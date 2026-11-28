// Trapcode Particular: a deterministic look-alike, not a reproduction. Particular's
// particle positions come from its own random generator, so this draws a seeded
// particle system from the stored emitter, physics and particle settings (system 1
// only): particles born at the emission rate inside the (rotated) emitter box,
// moving with their velocity, wind and gravity in particle space, placed in the
// comp by the World Transform (rotation about the comp centre, then offset; checked
// against After Effects renders of the user's setup), seen through the comp's
// camera, drawn as soft dots with a glow halo. It replaces the layer's pixels as
// Particular does. Positions cannot match; the particle count, sizes, brightness and
// spread are fitted to After Effects renders (scripts/research/particular/particular-stats.ts): Size Random
// varies the size by up to ±half its percentage, and with Depth of Field on, particles
// off the focal plane (at the camera's zoom distance) spread over a circle of confusion.
import type { CompItem, Layer, Project } from "../../aep/model.ts";
import { compile, type GL } from "../gl.ts";
import { registerEffect } from "../registry.ts";
import { drawSprites, spriteFrames } from "./particularSprites.ts";
import { BLEND_ADD, BLEND_LIGHTEN, BLEND_SCREEN, particularFrame, particularSplats, rotation, SPLAT_FLOATS, textureTime, type Particle } from "./particularSim.ts";

// Each dot is an instanced quad over its reach; its soft disc (full inside `inner`, falling to zero at `r` as
// 1 - smoothstep, as After Effects draws spheres and glows) is laid over what is below: a + b (1 - a).
const SPLAT_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_splat;
layout(location = 2) in float a_opacity;
uniform vec2 u_size;
uniform float u_pad;
flat out vec4 v_splat;
flat out float v_opacity;
void main() {
  vec2 p = a_splat.xy + (a_corner * 2.0 - 1.0) * (a_splat.z + 1.0);
  v_splat = a_splat;
  v_opacity = a_opacity;
  gl_Position = vec4(vec2(p.x + u_pad, u_size.y - u_pad - p.y) / u_size * 2.0 - 1.0, 0.0, 1.0);
}`;

export const SPLAT_FS = `#version 300 es
precision highp float;
uniform vec2 u_size;
uniform float u_pad;
uniform vec3 u_color;
flat in vec4 v_splat;
flat in float v_opacity;
out vec4 outColor;
void main() {
  vec2 pixel = vec2(gl_FragCoord.x - u_pad, u_size.y - u_pad - gl_FragCoord.y);
  float d = distance(pixel, v_splat.xy);
  float r = v_splat.z;
  float inner = v_splat.w;
  float cover = inner >= r ? (d < r ? 1.0 : 0.0) : 1.0 - smoothstep(inner, r, d);
  float a = v_opacity * cover;
  outColor = vec4(u_color * a, a);
}`;

/**
 * SPLAT_VS for the native engine, which has no per-instance attributes: splat u_first + gl_InstanceID is read from
 * u_data, two texels each (cx, cy, outer, inner; opacity), u_width texels to a row.
 */
export const SPLAT_DATA_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
uniform highp sampler2D u_data;
uniform int u_width;
uniform int u_first;
uniform vec2 u_size;
uniform float u_pad;
flat out vec4 v_splat;
flat out float v_opacity;
void main() {
  int k = (u_first + gl_InstanceID) * 2;
  vec4 splat = texelFetch(u_data, ivec2(k % u_width, k / u_width), 0);
  float opacity = texelFetch(u_data, ivec2((k + 1) % u_width, (k + 1) / u_width), 0).r;
  vec2 p = splat.xy + (a_corner * 2.0 - 1.0) * (splat.z + 1.0);
  v_splat = splat;
  v_opacity = opacity;
  gl_Position = vec4(vec2(p.x + u_pad, u_size.y - u_pad - p.y) / u_size * 2.0 - 1.0, 0.0, 1.0);
}`;

interface SplatGpu {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  instances: WebGLBuffer;
  size: WebGLUniformLocation | null;
  pad: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
}
const splatGpu = new WeakMap<GL, SplatGpu>();

function splatter(gl: GL): SplatGpu {
  let state = splatGpu.get(gl);
  if (state) return state;
  const program = compile(gl, SPLAT_VS, SPLAT_FS);
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const corners = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const instances = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SPLAT_FLOATS * 4, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, SPLAT_FLOATS * 4, 16);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);
  state = {
    program,
    vao,
    instances,
    size: gl.getUniformLocation(program, "u_size"),
    pad: gl.getUniformLocation(program, "u_pad"),
    color: gl.getUniformLocation(program, "u_color"),
  };
  splatGpu.set(gl, state);
  return state;
}

const compOfLayer = new WeakMap<Layer, CompItem>();
function compOf(project: Project, layer: Layer): CompItem | undefined {
  let comp = compOfLayer.get(layer);
  if (comp) return comp;
  for (const item of project.items.values()) {
    if (item.kind === "comp" && item.layers.includes(layer)) comp = item;
  }
  if (comp) compOfLayer.set(layer, comp);
  return comp;
}

registerEffect("tc Particular", (input, effect, layer, time, ctx) => {
  ctx.warn("Particular is drawn with a seeded look-alike; particle positions do not match After Effects");
  const width = input.width;
  const height = input.height;
  const comp = compOf(ctx.project, layer);
  const frame = particularFrame(effect, layer, comp, time, width, height);
  const { particles, textured, polygon, spriteMode, textureIndex, timeSampling, textureSeed, clips, aspect, particleBlend, glowBlend, color, fps, cx, cy, shiftX, shiftY, camera } = frame;
  const pad = ctx.pad;
  // `acquire` leaves the cleared target bound with its viewport set.
  const out = ctx.pool.acquire(width + 2 * pad, height + 2 * pad);
  ctx.pool.release(input.target);
  const gl = ctx.gl;
  if (textured) {
    const textureLayer = textureIndex > 0 ? comp?.layers.find((l) => l.index === textureIndex && l !== layer) : undefined;
    const fpsTexture = fps;
    const sampleTime = (p: Particle) => textureTime(timeSampling, p, time, textureLayer, clips, textureSeed, 1 / fpsTexture);
    const shown = particles.filter((p) => Number.isFinite(sampleTime(p)));
    const frames = textureLayer && shown.length ? spriteFrames(ctx, textureLayer, shown.map(sampleTime), fpsTexture) : null;
    if (frames) {
      const instances: number[] = [];
      for (const p of shown) {
        // A sprite is twice its Size wide, whatever its texture's shape, and as tall as the texture's proportions
        // make it; Aspect Ratio widens it alone.
        const w = p.r * aspect;
        const h = (p.r * frames.height) / frames.width;
        const corners: [number, number][] = [
          [-w, -h],
          [w, -h],
          [-w, h],
          [w, h],
        ];
        if (polygon) {
          const turn = rotation(p.angles[0], p.angles[1], p.angles[2]);
          for (const [x, y] of corners) {
            const v = turn.transformVector([x / p.scale, y / p.scale, 0]);
            const z = p.view[2] + v[2];
            const k = camera.zoom / Math.max(1, z);
            instances.push(cx + (p.view[0] + v[0]) * k + shiftX, cy + (p.view[1] + v[1]) * k + shiftY, z / p.view[2]);
          }
        } else {
          const a = (p.angles[2] * Math.PI) / 180;
          const c = Math.cos(a);
          const s = Math.sin(a);
          for (const [x, y] of corners) instances.push(p.sx + x * c - y * s, p.sy + x * s + y * c, 1);
        }
        instances.push(frames.slot(sampleTime(p)), p.seen);
      }
      withBlend(gl, out, pad, width, height, particleBlend, () => drawSprites(gl, out, pad, instances, spriteMode, color));
    }
  } else {
    const { glow: glowSplats, core: coreSplats } = particularSplats(frame);
    const gpu = splatter(gl);
    const draw = (splats: number[]) => {
      if (!splats.length) return;
      gl.useProgram(gpu.program);
      gl.uniform2f(gpu.size, out.width, out.height);
      gl.uniform1f(gpu.pad, pad);
      gl.uniform3f(gpu.color, color[0] ?? 1, color[1] ?? 1, color[2] ?? 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.instances);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(splats), gl.STREAM_DRAW);
      gl.bindVertexArray(gpu.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, splats.length / SPLAT_FLOATS);
      gl.bindVertexArray(null);
    };
    withBlend(gl, out, pad, width, height, glowBlend, () => draw(glowSplats));
    withBlend(gl, out, pad, width, height, particleBlend, () => draw(coreSplats));
  }
  return { ...input, target: out };
});

/** Runs `draw` into `out`'s content (scissored to it) with Particular's blend mode `mode` between particles. */
function withBlend(gl: GL, out: { framebuffer: WebGLFramebuffer; width: number; height: number }, pad: number, width: number, height: number, mode: number, draw: () => void) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
  gl.viewport(0, 0, out.width, out.height);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(pad, pad, width, height);
  gl.enable(gl.BLEND);
  if (mode === BLEND_ADD) gl.blendFunc(gl.ONE, gl.ONE);
  else if (mode === BLEND_SCREEN) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  else if (mode === BLEND_LIGHTEN) gl.blendEquation(gl.MAX);
  else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  draw();
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.BLEND);
  gl.disable(gl.SCISSOR_TEST);
}
