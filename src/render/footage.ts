// Footage layers (still images, image sequences, video): comp time to source
// frame, the located file's decoded frame from the footage store, and the
// Interpret Footage alpha settings applied on the way into the layer image.
import { layerTimeAt, currentValue } from "../aep/evaluate.ts";
import { AlphaMode, type CompItem, type FootageItem, type Layer, type Project } from "../aep/model.ts";
import type { FootageFrame } from "../media/frames.ts";
import { footageStore } from "../media/store.ts";
import type { GL } from "./gl.ts";
import { registerContentProvider, type RenderContext } from "./registry.ts";

/** Absorbs comp-time and conform-rate floating point error at exact frame boundaries. */
const FRAME_EPSILON = 1e-6;

/** Frame of the footage shown at `sourceTime` seconds of footage time (after loops and conforming), as the store indexes it. */
export function footageFrameIndex(item: FootageItem, sourceTime: number): number {
  const source = item.mainSource;
  if (source.isStill || !item.frameRate) return 0;
  const loops = source.loop || 1;
  const perLoop = Math.max(1, Math.round((item.duration / loops) * item.frameRate));
  const frame = Math.min(Math.max(Math.floor(sourceTime * item.frameRate + FRAME_EPSILON), 0), perLoop * loops - 1);
  return frame % perLoop;
}

/** The layer's source time at comp time `time`: Time Remap when enabled, else start time and stretch. */
export function layerSourceTime(layer: Layer, time: number): number {
  if (layer.timeRemapEnabled) {
    const remap = layer.properties.find((n) => n.matchName === "ADBE Time Remapping");
    const value = remap?.kind === "property" ? currentValue(remap, time, layer) : null;
    if (typeof value === "number") return value;
  }
  return layerTimeAt(layer, time);
}

/** Horizontal scale from the layer's source pixels to the comp's pixels. */
export function sourcePixelAspect(layer: Layer, comp: CompItem, project: Project): number {
  const item = layer.sourceId ? project.items.get(layer.sourceId) : undefined;
  if (!item || (item.kind !== "footage" && item.kind !== "comp")) return 1;
  return (item.pixelAspect || 1) / (comp.pixelAspect || 1);
}

const INTERPRET_FS = `#version 300 es
precision highp float;
uniform sampler2D u_rgba;
uniform sampler2D u_cb;
uniform sampler2D u_cr;
uniform int u_yuv;
uniform ivec2 u_size;
uniform ivec2 u_chromaSize;
uniform int u_pad;
uniform bool u_limited;
uniform vec3 u_kr;
uniform int u_mode;
uniform bool u_hasAlpha;
uniform bool u_invert;
uniform vec3 u_matte;
out vec4 outColor;

float chroma(sampler2D plane, vec2 at) {
  vec2 base = floor(at);
  vec2 w = at - base;
  ivec2 lo = clamp(ivec2(base), ivec2(0), u_chromaSize - 1);
  ivec2 hi = clamp(ivec2(base) + 1, ivec2(0), u_chromaSize - 1);
  float a = texelFetch(plane, lo, 0).r;
  float b = texelFetch(plane, ivec2(hi.x, lo.y), 0).r;
  float c = texelFetch(plane, ivec2(lo.x, hi.y), 0).r;
  float d = texelFetch(plane, hi, 0).r;
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - u_pad;
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, u_size))) {
    outColor = vec4(0.0);
    return;
  }
  ivec2 at = ivec2(p.x, u_size.y - 1 - p.y);
  vec4 c;
  if (u_yuv == 1) {
    // Bilinear chroma, sited at the centre of the luma pixels it covers on both axes.
    vec2 ratio = vec2(u_size) / vec2(u_chromaSize);
    vec2 site = (vec2(at) + 0.5) / ratio - 0.5;
    float y = texelFetch(u_rgba, at, 0).r;
    float cb = chroma(u_cb, site);
    float cr = chroma(u_cr, site);
    if (u_limited) {
      y = (y * 255.0 - 16.0) / 219.0;
      cb = (cb * 255.0 - 128.0) / 224.0;
      cr = (cr * 255.0 - 128.0) / 224.0;
    } else {
      cb -= 128.0 / 255.0;
      cr -= 128.0 / 255.0;
    }
    float kr = u_kr.x;
    float kb = u_kr.y;
    float kg = 1.0 - kr - kb;
    vec3 rgb = vec3(
      y + 2.0 * (1.0 - kr) * cr,
      y - (2.0 * kb * (1.0 - kb) * cb + 2.0 * kr * (1.0 - kr) * cr) / kg,
      y + 2.0 * (1.0 - kb) * cb);
    c = vec4(clamp(rgb, 0.0, 1.0), 1.0);
  } else {
    c = texelFetch(u_rgba, at, 0);
  }
  float a = u_hasAlpha ? c.a : 1.0;
  if (u_invert) a = 1.0 - a;
  if (u_mode == 2) {
    outColor = vec4(c.rgb, 1.0);
  } else if (u_mode == 1) {
    outColor = vec4(clamp(c.rgb - u_matte * (1.0 - a), 0.0, a), a);
  } else {
    outColor = vec4(c.rgb * a, a);
  }
}`;

const BT601: [number, number] = [0.299, 0.114];
const BT709: [number, number] = [0.2126, 0.0722];
const MAX_UPLOADS = 32;
const uploads = new WeakMap<GL, Map<FootageFrame, WebGLTexture[]>>();

function makeTexture(gl: GL): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** Textures holding the frame's samples as stored (RGBA, or Y/Cb/Cr planes). */
function frameTextures(gl: GL, frame: FootageFrame): WebGLTexture[] {
  let cache = uploads.get(gl);
  if (!cache) uploads.set(gl, (cache = new Map()));
  const hit = cache.get(frame);
  if (hit) {
    cache.delete(frame);
    cache.set(frame, hit);
    return hit;
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  let textures: WebGLTexture[];
  if (frame.kind === "yuv") {
    const plane = (data: Uint8Array, w: number, h: number) => {
      const t = makeTexture(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      return t;
    };
    textures = [plane(frame.y, frame.width, frame.height), plane(frame.u, frame.chromaWidth, frame.chromaHeight), plane(frame.v, frame.chromaWidth, frame.chromaHeight)];
  } else {
    const t = makeTexture(gl);
    if (frame.kind === "rgba") gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, frame.width, frame.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame.image);
    textures = [t];
  }
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
  cache.set(frame, textures);
  for (const [key, old] of cache) {
    if (cache.size <= MAX_UPLOADS) break;
    cache.delete(key);
    for (const t of old) gl.deleteTexture(t);
  }
  return textures;
}

function interpret(item: FootageItem, frame: FootageFrame, ctx: RenderContext) {
  const gl = ctx.gl;
  const source = item.mainSource;
  const { width, height } = frame;
  const textures = frameTextures(gl, frame);
  const out = ctx.pool.acquire(width + 2 * ctx.pad, height + 2 * ctx.pad);
  const program = ctx.program(INTERPRET_FS);
  ctx.pass(program, out, [], (uniform) => {
    textures.forEach((t, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
    });
    gl.uniform1i(uniform("u_rgba"), 0);
    gl.uniform1i(uniform("u_cb"), frame.kind === "yuv" ? 1 : 0);
    gl.uniform1i(uniform("u_cr"), frame.kind === "yuv" ? 2 : 0);
    gl.uniform1i(uniform("u_yuv"), frame.kind === "yuv" ? 1 : 0);
    gl.uniform2i(uniform("u_size"), width, height);
    gl.uniform2i(uniform("u_chromaSize"), frame.kind === "yuv" ? frame.chromaWidth : width, frame.kind === "yuv" ? frame.chromaHeight : height);
    gl.uniform1i(uniform("u_pad"), ctx.pad);
    gl.uniform1i(uniform("u_limited"), frame.kind === "yuv" && frame.limitedRange ? 1 : 0);
    const [kr, kb] = frame.kind === "yuv" && frame.height > 576 ? BT709 : BT601;
    gl.uniform3f(uniform("u_kr"), kr, kb, 0);
    gl.uniform1i(uniform("u_mode"), source.alphaMode === AlphaMode.IGNORE ? 2 : source.alphaMode === AlphaMode.PREMULTIPLIED ? 1 : 0);
    gl.uniform1i(uniform("u_hasAlpha"), source.hasAlpha ? 1 : 0);
    gl.uniform1i(uniform("u_invert"), source.invertAlpha ? 1 : 0);
    gl.uniform3f(uniform("u_matte"), ...source.premulColor);
  });
  return { target: out, width, height, origin: [0, 0] as [number, number] };
}

registerContentProvider((layer, time, ctx) => {
  if (layer.layerType !== "AVLayer" || !layer.sourceId) return undefined;
  const item = ctx.project.items.get(layer.sourceId);
  if (item?.kind !== "footage") return undefined;
  const source = item.mainSource;
  if (source.sourceType === "SolidSource") return undefined;
  if (source.sourceType === "PlaceholderSource") {
    ctx.warn(`placeholder "${item.name}" has no footage; After Effects refuses to render it`);
    return null;
  }
  if (!item.hasVideo) return null;
  const state = footageStore.frame(item, footageFrameIndex(item, layerSourceTime(layer, time)));
  if (state.status === "ready") return interpret(item, state.frame, ctx);
  if (state.status === "pending") ctx.warn(`footage is loading ("${item.name}")`);
  else if (state.status === "missing") ctx.warn(`footage is missing ("${item.name}"); After Effects refuses to render it`);
  else ctx.warn(`footage "${item.name}" cannot be decoded: ${state.message}`);
  return null;
});
