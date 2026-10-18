// Particular's textured particles (Sprite, Sprite Colorize, Sprite Fill and the Textured Polygon types): the frames
// of the Texture layer a render needs, gathered into one array texture, and one instanced quad per particle given by
// its four projected corners, so camera-facing sprites and polygons turned in 3D share a draw that keeps the
// particles' depth order.
import type { Layer } from "../../aep/model.ts";
import { compile, type GL, type Target } from "../gl.ts";
import type { RenderContext } from "../registry.ts";

/** How a particle colours its texture. */
export const SPRITE_MODE = { TEXTURE: 0, COLORIZE: 1, FILL: 2 } as const;

/** Frames of the texture layer kept for one render at most; further times share the nearest kept frame. */
const MAX_FRAMES = 64;

// Copies a layer image (padded, GL rows) into one layer of the array texture, at the texture layer's own size:
// transparent outside the image's content.
const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_src;
uniform vec2 u_srcSize;   // padded source target
uniform vec2 u_size;      // texture layer size
uniform vec2 u_origin;    // layer position of the source's first content pixel
uniform vec2 u_content;   // source content size
uniform float u_scale;
uniform float u_pad;
void main() {
  vec2 layer = vec2(v_uv.x, 1.0 - v_uv.y) * u_size;
  vec2 c = (layer - u_origin) * u_scale;
  if (c.x < 0.0 || c.y < 0.0 || c.x > u_content.x || c.y > u_content.y) { outColor = vec4(0.0); return; }
  vec2 gl = vec2(u_pad + c.x, u_pad + u_content.y - c.y);
  outColor = texture(u_src, gl / u_srcSize);
}`;

const SPRITE_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_p0;
layout(location = 2) in vec3 a_p1;
layout(location = 3) in vec3 a_p2;
layout(location = 4) in vec3 a_p3;
layout(location = 5) in vec2 a_frame;   // array layer, opacity
uniform vec2 u_size;
uniform float u_pad;
out vec2 v_uv;
flat out vec2 v_frame;
void main() {
  // Corners: p0 top left, p1 top right, p2 bottom left, p3 bottom right (x, y in layer pixels, w the depth).
  vec3 p = a_corner.y < 0.5 ? (a_corner.x < 0.5 ? a_p0 : a_p1) : (a_corner.x < 0.5 ? a_p2 : a_p3);
  v_uv = a_corner;
  v_frame = a_frame;
  vec2 ndc = vec2(p.x + u_pad, u_size.y - u_pad - p.y) / u_size * 2.0 - 1.0;
  gl_Position = vec4(ndc * p.z, 0.0, p.z);
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_tex;
uniform int u_mode;
uniform vec3 u_color;
in vec2 v_uv;
flat in vec2 v_frame;
out vec4 outColor;
void main() {
  vec4 t = texture(u_tex, vec3(v_uv.x, 1.0 - v_uv.y, v_frame.x));
  vec4 c = t;
  if (u_mode == 1) {
    vec3 straight = t.a > 0.0 ? t.rgb / t.a : vec3(0.0);
    float l = (straight.r + straight.g + straight.b) / 3.0;
    c = vec4(u_color * l * t.a, t.a);
  } else if (u_mode == 2) {
    c = vec4(u_color * t.a, t.a);
  }
  outColor = c * v_frame.y;
}`;

/** Floats per sprite instance: four corners (x, y, w), array layer, opacity. */
export const SPRITE_FLOATS = 14;

interface SpriteGpu {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  instances: WebGLBuffer;
  texture: WebGLTexture;
  /** Allocated size of `texture`: width, height, layers. */
  allocated: [number, number, number];
  framebuffers: WebGLFramebuffer[];
}
const gpus = new WeakMap<GL, SpriteGpu>();

function spriteGpu(gl: GL): SpriteGpu {
  let state = gpus.get(gl);
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
  for (let k = 0; k < 4; k++) {
    gl.enableVertexAttribArray(1 + k);
    gl.vertexAttribPointer(1 + k, 3, gl.FLOAT, false, SPRITE_FLOATS * 4, k * 12);
    gl.vertexAttribDivisor(1 + k, 1);
  }
  gl.enableVertexAttribArray(5);
  gl.vertexAttribPointer(5, 2, gl.FLOAT, false, SPRITE_FLOATS * 4, 48);
  gl.vertexAttribDivisor(5, 1);
  gl.bindVertexArray(null);
  state = { program, vao, instances, texture: gl.createTexture()!, allocated: [0, 0, 0], framebuffers: [] };
  gpus.set(gl, state);
  return state;
}

/** The frames of a texture layer one render draws its particles with. */
export interface SpriteFrames {
  width: number;
  height: number;
  /** Array layer holding the frame shown at `time` (seconds of the texture layer's own time). */
  slot(time: number): number;
}

/**
 * Renders `layer` (its masks and effects included) at each of `times` (seconds of the layer's own time) into the
 * array texture, one layer per distinct frame at `fps`. Null when the layer draws nothing.
 */
export function spriteFrames(ctx: RenderContext, layer: Layer, times: number[], fps: number): SpriteFrames | null {
  const width = Math.max(1, Math.round(layer.width));
  const height = Math.max(1, Math.round(layer.height));
  const frameOf = (t: number) => Math.floor(t * fps + 1e-6);
  const wanted = [...new Set(times.map(frameOf))].sort((a, b) => a - b);
  // Keep an even spread of the frames when more are wanted than kept.
  const kept = wanted.length <= MAX_FRAMES ? wanted : Array.from({ length: MAX_FRAMES }, (_, k) => wanted[Math.round((k * (wanted.length - 1)) / (MAX_FRAMES - 1))]);
  const gl = ctx.gl;
  const gpu = spriteGpu(gl);
  const [aw, ah, al] = gpu.allocated;
  if (aw !== width || ah !== height || al < kept.length) {
    const layers = Math.max(kept.length, al, 1);
    gl.deleteTexture(gpu.texture);
    gpu.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, gpu.texture);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, width, height, layers, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    for (const fb of gpu.framebuffers) gl.deleteFramebuffer(fb);
    gpu.framebuffers = [];
    gpu.allocated = [width, height, layers];
  }
  const copy = ctx.program(COPY_FS);
  const startTime = layer.startTime;
  let drew = false;
  kept.forEach((frame, k) => {
    let fb = gpu.framebuffers[k];
    if (!fb) {
      fb = gpu.framebuffers[k] = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gpu.texture, 0, k);
    }
    const out: Target = { texture: gpu.texture, framebuffer: fb, width, height };
    const image = ctx.layerImage(layer, startTime + frame / fps, true);
    if (!image) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    drew = true;
    const scale = image.scale ?? 1;
    ctx.pass(copy, out, [image.target], (u) => {
      gl.uniform1i(u("u_src"), 0);
      gl.uniform2f(u("u_srcSize"), image.target.width, image.target.height);
      gl.uniform2f(u("u_size"), width, height);
      gl.uniform2f(u("u_origin"), image.origin[0], image.origin[1]);
      gl.uniform2f(u("u_content"), image.width, image.height);
      gl.uniform1f(u("u_scale"), scale);
      gl.uniform1f(u("u_pad"), ctx.pad);
    });
    ctx.pool.release(image.target);
  });
  if (!drew) return null;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, gpu.texture);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  return {
    width,
    height,
    slot(time: number): number {
      const frame = frameOf(time);
      let best = 0;
      for (let k = 1; k < kept.length; k++) if (Math.abs(kept[k] - frame) < Math.abs(kept[best] - frame)) best = k;
      return best;
    },
  };
}

/** Draws `instances` (SPRITE_FLOATS each) into `out` with the frames last gathered by spriteFrames. */
export function drawSprites(gl: GL, out: Target, pad: number, instances: number[], mode: number, color: number[]): void {
  if (!instances.length) return;
  const gpu = spriteGpu(gl);
  gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
  gl.viewport(0, 0, out.width, out.height);
  gl.useProgram(gpu.program);
  gl.uniform2f(gl.getUniformLocation(gpu.program, "u_size"), out.width, out.height);
  gl.uniform1f(gl.getUniformLocation(gpu.program, "u_pad"), pad);
  gl.uniform1i(gl.getUniformLocation(gpu.program, "u_mode"), mode);
  gl.uniform3f(gl.getUniformLocation(gpu.program, "u_color"), color[0] ?? 1, color[1] ?? 1, color[2] ?? 1);
  gl.uniform1i(gl.getUniformLocation(gpu.program, "u_tex"), 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, gpu.texture);
  gl.bindBuffer(gl.ARRAY_BUFFER, gpu.instances);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(instances), gl.STREAM_DRAW);
  gl.bindVertexArray(gpu.vao);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances.length / SPRITE_FLOATS);
  gl.bindVertexArray(null);
}
