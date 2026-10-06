// Trapcode Particular: a deterministic look-alike, not a reproduction. Particular's
// particle positions come from its own random generator, so this draws a seeded
// particle system from the stored emitter, physics and particle settings (system 1
// only): particles born at the emission rate inside the emitter box, moving with
// their velocity plus wind, seen through the default comp camera, drawn as soft
// white dots with a glow halo. It replaces the layer's pixels as Particular does.
import { effectNumber, effectVector } from "../effectParams.ts";
import { compile, type GL } from "../gl.ts";
import { registerEffect } from "../registry.ts";

/** Deterministic uniform random numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each dot is an instanced quad over its reach; its soft disc (full inside
// `inner`, linear to zero at `r`) is laid over what is below: a + b (1 - a).
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

const SPLAT_FS = `#version 300 es
precision highp float;
uniform vec2 u_size;
uniform float u_pad;
flat in vec4 v_splat;
flat in float v_opacity;
out vec4 outColor;
void main() {
  vec2 pixel = vec2(gl_FragCoord.x - u_pad, u_size.y - u_pad - gl_FragCoord.y);
  float d = distance(pixel, v_splat.xy);
  float r = v_splat.z;
  float inner = v_splat.w;
  float cover = d <= inner ? 1.0 : d >= r ? 0.0 : 1.0 - (d - inner) / max(1e-6, r - inner);
  outColor = vec4(v_opacity * cover);
}`;

interface SplatGpu {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  instances: WebGLBuffer;
  size: WebGLUniformLocation | null;
  pad: WebGLUniformLocation | null;
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
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 20, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 16);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);
  state = { program, vao, instances, size: gl.getUniformLocation(program, "u_size"), pad: gl.getUniformLocation(program, "u_pad") };
  splatGpu.set(gl, state);
  return state;
}

/** Appends a soft disc of radius r (feathered over its outer `feather` share) as one instance: cx, cy, r, inner, opacity. */
function splat(out: number[], cx: number, cy: number, radius: number, feather: number, opacity: number) {
  // Dots below a pixel keep their area as fainter one-pixel dots.
  const r = Math.max(radius, 0.75);
  opacity *= Math.min(1, (radius / r) ** 2);
  if (opacity > 0) out.push(cx, cy, r, r * (1 - feather), opacity);
}

registerEffect("tc Particular", (input, effect, layer, time, ctx) => {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  ctx.warn("Particular is drawn with a seeded look-alike; particle positions do not match After Effects");
  const rate = Math.max(0, num(146, 100));
  const emitterType = num(5, 1);
  const position = effectVector(effect, 581, layer, time, [input.width / 2, input.height / 2, 0]);
  const size = [num(14, 50), num(15, 50), num(16, 50)];
  const velocity = num(11, 100);
  const velocityRandom = num(12, 20) / 100;
  const life = Math.max(0, num(2, 3));
  const lifeRandom = num(65, 0) / 100;
  const particleSize = Math.max(0, num(27, 4));
  const sizeRandom = num(74, 0) / 100;
  const opacity = num(33, 100) / 100;
  const opacityRandom = num(75, 0) / 100;
  const feather = num(29, 50) / 100;
  const glowSize = num(215, 300) / 100;
  const glowOpacity = num(216, 25) / 100;
  const timeFactor = num(25, 1);
  const wind = [num(22, 0), num(23, 0), num(24, 0)];
  const rand = random(num(230, 100000));

  const width = input.width;
  const height = input.height;
  const splats: number[] = [];
  // Default comp camera: 50 mm equivalent, looking at the comp centre from z = -zoom.
  const zoom = (width / 2) / Math.tan((39.6 * Math.PI) / 360);
  const born = Math.floor(time * rate + 1e-6);
  for (let i = 0; i <= born; i++) {
    const birth = i / Math.max(rate, 1e-6);
    const box = emitterType === 1 ? [0, 0, 0] : [rand() - 0.5, rand() - 0.5, rand() - 0.5];
    const dir = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
    const speed = velocity * (1 - velocityRandom * rand());
    const lifeSpan = life * (1 - lifeRandom * 0.5 * rand());
    const pSize = particleSize * (1 - sizeRandom * rand());
    const pOpacity = opacity * (1 - opacityRandom * rand());
    const age = time - birth;
    if (age < 0 || age > lifeSpan) continue;
    const t = age * timeFactor;
    const norm = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const p = [0, 1, 2].map((c) => position[c] + box[c] * size[c] + (dir[c] / norm) * speed * t + wind[c] * t);
    const scale = zoom / Math.max(1, zoom + p[2]);
    const sx = width / 2 + (p[0] - width / 2) * scale;
    const sy = height / 2 + (p[1] - height / 2) * scale;
    const r = (pSize * scale) / 2;
    splat(splats, sx, sy, r * glowSize, 1, pOpacity * glowOpacity);
    splat(splats, sx, sy, r, feather, pOpacity);
  }
  const pad = ctx.pad;
  // `acquire` leaves the cleared target bound with its viewport set.
  const out = ctx.pool.acquire(width + 2 * pad, height + 2 * pad);
  ctx.pool.release(input.target);
  if (splats.length) {
    const gl = ctx.gl;
    const gpu = splatter(gl);
    gl.useProgram(gpu.program);
    gl.uniform2f(gpu.size, out.width, out.height);
    gl.uniform1f(gpu.pad, pad);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.instances);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(splats), gl.STREAM_DRAW);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(pad, pad, width, height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(gpu.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, splats.length / 5);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
  }
  return { ...input, target: out };
});
