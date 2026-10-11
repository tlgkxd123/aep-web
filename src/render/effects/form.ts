// Trapcode Form: a look-alike, not a reproduction. Form lays particles out in a base form (a box grid, box
// strings or layered sphere of Size and Particles in X/Y/Z, rotated about its centre), moves them by Disperse
// (seeded random offsets), Twist (about the X axis, growing along it) and a Fractal Field (value-noise fBm,
// flowing with Flow X/Y/Z and evolving), which also varies their size and opacity, and places them in the comp
// by the World Transform (rotation about the comp centre, then offset) seen through the comp's camera, as soft
// spheres (with a halo for the glow particle types) faded by Visibility. Particles are laid out and moved on the
// GPU, one instance each. It replaces the layer's pixels as Form does. Its parameters are read by name
// (formSettings.ts); nothing here was fitted to Form renders.
import type { CompItem, Layer, Project } from "../../aep/model.ts";
import { cameraAt, Mat4 } from "../../aep/transform.ts";
import { compile, type GL } from "../gl.ts";
import { registerEffect } from "../registry.ts";
import { FormBase, FormBlend, formLayout, formSettings } from "./formSettings.ts";
import { namedParams } from "./namedParams.ts";

const FORM_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 a_corner;
uniform ivec3 u_count;
uniform int u_stride;
uniform int u_base;
uniform vec3 u_size3;
uniform mat4 u_model;
uniform mat3 u_toCamera;
uniform vec3 u_camPos;
uniform float u_zoom;
uniform vec2 u_screen;
uniform vec2 u_target;
uniform float u_pad;
uniform float u_disperse;
uniform float u_twist;
uniform vec3 u_displace;
uniform vec3 u_flow;
uniform float u_evolution;
uniform float u_frequency;
uniform int u_octaves;
uniform float u_octMult;
uniform float u_octScale;
uniform float u_affectSize;
uniform float u_affectOpacity;
uniform float u_psize;
uniform float u_sizeRandom;
uniform float u_opacity;
uniform float u_opacityRandom;
uniform float u_feather;
uniform float u_glowSize;
uniform float u_glowOpacity;
uniform vec4 u_visibility;
flat out vec2 v_center;
flat out vec4 v_shape;
flat out float v_opacity;

uint mixBits(uint x) {
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}
float hash01(uint x) { return float(mixBits(x)) / 4294967295.0; }
float lattice(ivec3 c, uint seed) {
  uvec3 k = uvec3(c + ivec3(1 << 20));
  return hash01(k.x * 73856093u ^ k.y * 19349663u ^ k.z * 83492791u ^ seed) * 2.0 - 1.0;
}
float valueNoise(vec3 p, uint seed) {
  ivec3 i = ivec3(floor(p));
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float x00 = mix(lattice(i, seed), lattice(i + ivec3(1, 0, 0), seed), u.x);
  float x10 = mix(lattice(i + ivec3(0, 1, 0), seed), lattice(i + ivec3(1, 1, 0), seed), u.x);
  float x01 = mix(lattice(i + ivec3(0, 0, 1), seed), lattice(i + ivec3(1, 0, 1), seed), u.x);
  float x11 = mix(lattice(i + ivec3(0, 1, 1), seed), lattice(i + ivec3(1, 1, 1), seed), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}
float fbm(vec3 p, uint seed) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= u_octaves) break;
    sum += amp * valueNoise(p, seed + uint(o) * 1013u);
    norm += amp;
    amp *= u_octMult;
    p *= u_octScale;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
float visibility(float z) {
  vec4 v = u_visibility;
  float near = v.y > v.x ? (z - v.x) / (v.y - v.x) : (z >= v.x ? 1.0 : 0.0);
  float far = v.w > v.z ? (v.w - z) / (v.w - v.z) : (z <= v.w ? 1.0 : 0.0);
  return clamp(min(near, far), 0.0, 1.0);
}

void main() {
  int idx = gl_InstanceID * u_stride;
  int nx = u_count.x;
  int ny = u_count.y;
  vec3 g = vec3(float(idx % nx), float((idx / nx) % ny), float(idx / (nx * ny)));
  vec3 n = vec3(u_count);
  vec3 local;
  if (u_base == ${FormBase.SPHERE}) {
    float theta = 6.28318531 * (g.x + 0.5) / n.x;
    float phi = 3.14159265 * (g.y + 0.5) / n.y;
    float r = 0.5 * u_size3.x * (n.z - g.z) / n.z;
    local = r * vec3(sin(phi) * cos(theta), -cos(phi), sin(phi) * sin(theta));
  } else {
    vec3 t = vec3(n.x > 1.0 ? g.x / (n.x - 1.0) : 0.5, n.y > 1.0 ? g.y / (n.y - 1.0) : 0.5, n.z > 1.0 ? g.z / (n.z - 1.0) : 0.5);
    local = (t - 0.5) * u_size3;
  }
  uint id = uint(idx);
  local += (vec3(hash01(id * 3u), hash01(id * 3u + 1u), hash01(id * 3u + 2u)) * 2.0 - 1.0) * u_disperse;
  float turn = u_twist * 3.14159265 * local.x / max(abs(u_size3.x), 1.0);
  local.yz = mat2(cos(turn), sin(turn), -sin(turn), cos(turn)) * local.yz;
  float field = 0.0;
  if (u_frequency > 0.0 && (u_affectSize != 0.0 || u_affectOpacity != 0.0 || u_displace != vec3(0.0))) {
    vec3 q = (local + u_flow) * u_frequency + vec3(0.0, 0.0, u_evolution);
    field = fbm(q, 7u);
    if (u_displace != vec3(0.0)) local += u_displace * vec3(field, fbm(q, 131u), fbm(q, 257u));
  }
  vec3 world = (u_model * vec4(local, 1.0)).xyz;
  vec3 view = u_toCamera * (world - u_camPos);
  float size = u_psize * (1.0 + u_sizeRandom * (hash01(id * 5u + 101u) - 0.5)) * max(0.0, 1.0 + u_affectSize * field);
  float opacity = u_opacity * (1.0 - u_opacityRandom * hash01(id * 5u + 102u)) * clamp(1.0 + u_affectOpacity * field, 0.0, 1.0);
  opacity *= view.z > 1.0 ? visibility(view.z) : 0.0;
  if (opacity <= 0.0 || size <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float scale = u_zoom / view.z;
  vec2 center = u_screen + view.xy * scale;
  float r = 0.5 * size * scale;
  // Size is the diameter; Sphere Feather fades outward beyond it (as Particular's look-alike draws it).
  float outer = r * (1.0 + 1.8 * u_feather);
  // Dots below a pixel keep their area as fainter one-pixel dots.
  float reach = max(outer, 0.75);
  float halo = u_glowOpacity > 0.0 ? outer * u_glowSize : 0.0;
  vec2 p = center + (a_corner * 2.0 - 1.0) * (max(reach, halo) + 1.0);
  gl_Position = vec4(vec2(p.x + u_pad, u_target.y - u_pad - p.y) / u_target * 2.0 - 1.0, 0.0, 1.0);
  v_center = center;
  v_shape = vec4(min(r, reach), reach, halo, u_glowOpacity * opacity);
  v_opacity = opacity * min(1.0, (outer / reach) * (outer / reach));
}`;

const FORM_FS = `#version 300 es
precision highp float;
uniform vec2 u_target;
uniform float u_pad;
uniform vec3 u_color;
flat in vec2 v_center;
flat in vec4 v_shape;
flat in float v_opacity;
out vec4 outColor;
void main() {
  vec2 pixel = vec2(gl_FragCoord.x - u_pad, u_target.y - u_pad - gl_FragCoord.y);
  float d = distance(pixel, v_center);
  float core = d <= v_shape.x ? 1.0 : d >= v_shape.y ? 0.0 : 1.0 - (d - v_shape.x) / max(1e-6, v_shape.y - v_shape.x);
  float a = v_opacity * core;
  if (v_shape.z > 0.0) a += v_shape.w * max(0.0, 1.0 - d / v_shape.z) * (1.0 - a);
  if (a <= 0.0) discard;
  outColor = vec4(u_color * a, a);
}`;

interface FormGpu {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  uniforms: Map<string, WebGLUniformLocation | null>;
}
const formGpu = new WeakMap<GL, FormGpu>();

function gpuOf(gl: GL): FormGpu {
  let state = formGpu.get(gl);
  if (state) return state;
  const program = compile(gl, FORM_VS, FORM_FS);
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const corners = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  state = { program, vao, uniforms: new Map() };
  formGpu.set(gl, state);
  return state;
}

const compOfLayer = new WeakMap<Layer, CompItem>();
function compOf(project: Project, layer: Layer): CompItem | undefined {
  let comp = compOfLayer.get(layer);
  if (comp) return comp;
  for (const item of project.items.values()) if (item.kind === "comp" && item.layers.includes(layer)) comp = item;
  if (comp) compOfLayer.set(layer, comp);
  return comp;
}

const rotation = (r: number[]) => Mat4.rotateX(r[0]).mul(Mat4.rotateY(r[1])).mul(Mat4.rotateZ(r[2]));

/** Halo of the glow particle types: its radius over the sphere's, and its opacity (Particular's look-alike's defaults). */
const GLOW_SIZE = 3;
const GLOW_OPACITY = 0.25;

registerEffect("tc Form", (input, effect, layer, time, ctx) => {
  ctx.warn("Form is drawn with a look-alike; particle placement and shading do not match After Effects");
  const width = input.width;
  const height = input.height;
  const comp = compOf(ctx.project, layer);
  const compW = comp?.width ?? width;
  const compH = comp?.height ?? height;
  const s = formSettings(namedParams(effect, layer, time), [compW, compH]);
  for (const note of s.unsupported) ctx.warn(`Form: ${note}`);
  const layout = formLayout(s);
  if (layout.stride > 1) ctx.warn(`Form: ${layout.total} particles; every ${layout.stride}th is drawn`);

  const cx = compW / 2;
  const cy = compH / 2;
  const model = Mat4.translation(cx + s.world.offset[0], cy + s.world.offset[1], s.world.offset[2])
    .mul(rotation(s.world.rotation))
    .mul(Mat4.translation(-cx, -cy, 0))
    .mul(Mat4.translation(s.center[0], s.center[1], s.center[2]))
    .mul(rotation(s.rotation));
  const camera = comp ? cameraAt(comp, time) : { position: [cx, cy, -compW / 0.72], rotation: new Mat4(), zoom: compW / 0.72 };
  const toCamera = camera.rotation.inverse().m;

  const pad = ctx.pad;
  // `acquire` leaves the cleared target bound with its viewport set.
  const out = ctx.pool.acquire(width + 2 * pad, height + 2 * pad);
  ctx.pool.release(input.target);
  if (s.opacity > 0 && s.particleSize > 0) {
    const gl = ctx.gl;
    const gpu = gpuOf(gl);
    const u = (name: string) => {
      if (!gpu.uniforms.has(name)) gpu.uniforms.set(name, gl.getUniformLocation(gpu.program, name));
      return gpu.uniforms.get(name)!;
    };
    gl.useProgram(gpu.program);
    gl.uniform3i(u("u_count"), layout.count[0], layout.count[1], layout.count[2]);
    gl.uniform1i(u("u_stride"), layout.stride);
    gl.uniform1i(u("u_base"), s.base);
    gl.uniform3f(u("u_size3"), s.size[0], s.size[1], s.size[2]);
    gl.uniformMatrix4fv(u("u_model"), true, model.m);
    gl.uniformMatrix3fv(u("u_toCamera"), true, [toCamera[0], toCamera[1], toCamera[2], toCamera[4], toCamera[5], toCamera[6], toCamera[8], toCamera[9], toCamera[10]]);
    gl.uniform3f(u("u_camPos"), camera.position[0], camera.position[1], camera.position[2]);
    gl.uniform1f(u("u_zoom"), camera.zoom);
    // Form draws in comp space; a layer that is not comp-sized is centred on it.
    gl.uniform2f(u("u_screen"), cx + (width - compW) / 2, cy + (height - compH) / 2);
    gl.uniform2f(u("u_target"), out.width, out.height);
    gl.uniform1f(u("u_pad"), pad);
    gl.uniform1f(u("u_disperse"), s.disperse);
    gl.uniform1f(u("u_twist"), s.twist);
    const f = s.fractal;
    gl.uniform3f(u("u_displace"), f.displace[0], f.displace[1], f.displace[2]);
    gl.uniform3f(u("u_flow"), -f.flow[0] * time, -f.flow[1] * time, -f.flow[2] * time);
    gl.uniform1f(u("u_evolution"), f.evolution * time + f.offsetEvolution / 100);
    gl.uniform1f(u("u_frequency"), f.frequency);
    gl.uniform1i(u("u_octaves"), f.octaves);
    gl.uniform1f(u("u_octMult"), f.octaveMultiplier);
    gl.uniform1f(u("u_octScale"), f.octaveScale);
    gl.uniform1f(u("u_affectSize"), f.affectSize);
    gl.uniform1f(u("u_affectOpacity"), f.affectOpacity);
    gl.uniform1f(u("u_psize"), s.particleSize);
    gl.uniform1f(u("u_sizeRandom"), s.sizeRandom);
    gl.uniform1f(u("u_opacity"), s.opacity);
    gl.uniform1f(u("u_opacityRandom"), s.opacityRandom);
    gl.uniform1f(u("u_feather"), s.feather);
    gl.uniform1f(u("u_glowSize"), GLOW_SIZE);
    gl.uniform1f(u("u_glowOpacity"), s.glow ? GLOW_OPACITY : 0);
    const v = s.visibility;
    gl.uniform4f(u("u_visibility"), v.nearVanish, v.nearFade, v.farFade, v.farVanish);
    gl.uniform3f(u("u_color"), s.color[0], s.color[1], s.color[2]);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(pad, pad, width, height);
    gl.enable(gl.BLEND);
    if (s.blend === FormBlend.LIGHTEN) {
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else if (s.blend === FormBlend.ADD) gl.blendFunc(gl.ONE, gl.ONE);
    else if (s.blend === FormBlend.SCREEN) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(gpu.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, layout.drawn);
    gl.bindVertexArray(null);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
  }
  return { ...input, target: out };
});
