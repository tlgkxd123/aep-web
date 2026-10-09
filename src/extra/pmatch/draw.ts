// Draws world-model particles (sample.ts instances) into a padded target: each one
// an instanced quad sampling its learned sprite from a mipmapped array texture, so
// small particles keep their light; light adds up, and alpha is the brightest
// channel, so the light screens what is below it and adds in the Add mode. The
// effect and training's analysis-by-synthesis both draw through here.
import { bindTarget, compile, type GL, type Target } from "../../render/gl.ts";
import type { Prepared } from "./sample.ts";
import { INSTANCE_FLOATS, type Instances } from "./sample.ts";

const SPRITE_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_particle;
layout(location = 2) in float a_sprite;
uniform vec2 u_size;
uniform float u_pad;
uniform float u_reach;
out vec2 v_local;
flat out float v_light;
flat out int v_sprite;
void main() {
  // Half a pixel more than the sprite's reach, so its edge is sampled.
  float extent = u_reach * a_particle.z + 0.5;
  vec2 offset = (a_corner * 2.0 - 1.0) * extent;
  vec2 p = a_particle.xy + offset;
  v_local = offset / (u_reach * a_particle.z);
  v_light = a_particle.w;
  v_sprite = int(a_sprite + 0.5);
  gl_Position = vec4(vec2(p.x + u_pad, u_size.y - u_pad - p.y) / u_size * 2.0 - 1.0, 0.0, 1.0);
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_sprites;
uniform float u_texels;
uniform vec3 u_tint[16];
uniform vec3 u_color;
in vec2 v_local;
flat in float v_light;
flat in int v_sprite;
out vec4 outColor;
void main() {
  vec2 uv = v_local * 0.5 + 0.5;
  // Template texel centres span [0.5, size - 0.5]; outside them the sprite is dark.
  vec2 st = (0.5 + uv * (u_texels - 1.0)) / u_texels;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float value = texture(u_sprites, vec3(st, float(v_sprite))).r * inside;
  vec3 light = u_tint[v_sprite] * u_color * (v_light * value);
  outColor = vec4(light, max(light.r, max(light.g, light.b)));
}`;

/** Sprites a model may have (the tint uniform array's length). */
export const MAX_SPRITES = 16;

interface SpriteGpu {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  instances: WebGLBuffer;
  uniforms: Record<string, WebGLUniformLocation | null>;
}
const spriteGpu = new WeakMap<GL, SpriteGpu>();

function spriteProgram(gl: GL): SpriteGpu {
  let state = spriteGpu.get(gl);
  if (state) return state;
  const program = compile(gl, SPRITE_VS, SPRITE_FS);
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
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, INSTANCE_FLOATS * 4, 16);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);
  const uniforms = Object.fromEntries(
    ["u_size", "u_pad", "u_reach", "u_sprites", "u_texels", "u_tint[0]", "u_color"].map((name) => [name, gl.getUniformLocation(program, name)]),
  );
  state = { program, vao, instances, uniforms };
  spriteGpu.set(gl, state);
  return state;
}

const spriteTextures = new WeakMap<GL, WeakMap<Prepared, WebGLTexture>>();
function spriteTexture(gl: GL, prepared: Prepared): WebGLTexture {
  let perModel = spriteTextures.get(gl);
  if (!perModel) spriteTextures.set(gl, (perModel = new WeakMap()));
  let texture = perModel.get(prepared);
  if (texture) return texture;
  const { size, count, data } = prepared.model.sprites;
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = Math.round(Math.max(0, Math.min(1, data[i])) * 255);
  texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, size, size, count, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  perModel.set(prepared, texture);
  return texture;
}

/**
 * Adds the particles' light into `out` (blending onto what it holds), inside the
 * `width` × `height` content area that starts `pad` pixels in.
 */
export function drawParticles(gl: GL, out: Target, pad: number, width: number, height: number, prepared: Prepared, instances: Instances, color: ArrayLike<number> = [1, 1, 1]): void {
  if (!instances.count) return;
  const gpu = spriteProgram(gl);
  const sprites = prepared.model.sprites;
  const u = gpu.uniforms;
  const texture = spriteTexture(gl, prepared);
  bindTarget(gl, out);
  gl.useProgram(gpu.program);
  gl.uniform2f(u.u_size, out.width, out.height);
  gl.uniform1f(u.u_pad, pad);
  gl.uniform1f(u.u_reach, sprites.reach);
  gl.uniform1f(u.u_texels, sprites.size);
  const tint = new Float32Array(3 * MAX_SPRITES);
  tint.set(sprites.tint.subarray(0, Math.min(tint.length, sprites.tint.length)));
  gl.uniform3fv(u["u_tint[0]"], tint);
  gl.uniform3f(u.u_color, color[0] ?? 1, color[1] ?? 1, color[2] ?? 1);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.uniform1i(u.u_sprites, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, gpu.instances);
  gl.bufferData(gl.ARRAY_BUFFER, instances.data.subarray(0, instances.count * INSTANCE_FLOATS), gl.STREAM_DRAW);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(pad, pad, width, height);
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.bindVertexArray(gpu.vao);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances.count);
  gl.bindVertexArray(null);
  gl.disable(gl.BLEND);
  gl.disable(gl.SCISSOR_TEST);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
}
