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
uniform bool u_interleaved;
uniform vec3 u_kr;
uniform int u_mode;
uniform bool u_hasAlpha;
uniform bool u_invert;
uniform vec3 u_matte;
out vec4 outColor;

// Cb and Cr at chroma texel p: two planes, or one interleaved (NV12) plane in u_cb.
vec2 cbcr(ivec2 p) {
  return u_interleaved ? texelFetch(u_cb, p, 0).rg : vec2(texelFetch(u_cb, p, 0).r, texelFetch(u_cr, p, 0).r);
}

vec2 chroma(vec2 at) {
  vec2 base = floor(at);
  vec2 w = at - base;
  ivec2 lo = clamp(ivec2(base), ivec2(0), u_chromaSize - 1);
  ivec2 hi = clamp(ivec2(base) + 1, ivec2(0), u_chromaSize - 1);
  vec2 a = cbcr(lo);
  vec2 b = cbcr(ivec2(hi.x, lo.y));
  vec2 c = cbcr(ivec2(lo.x, hi.y));
  vec2 d = cbcr(hi);
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

vec3 toRgb(float y, float cb, float cr, vec2 k) {
  float kr = k.x;
  float kb = k.y;
  float kg = 1.0 - kr - kb;
  return vec3(y + 2.0 * (1.0 - kr) * cr, y - (2.0 * kb * (1.0 - kb) * cb + 2.0 * kr * (1.0 - kr) * cr) / kg, y + 2.0 * (1.0 - kb) * cb);
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
    vec2 c2 = chroma(site);
    float cb = c2.x;
    float cr = c2.y;
    if (u_limited) {
      y = (y * 255.0 - 16.0) / 219.0;
      cb = (cb * 255.0 - 128.0) / 224.0;
      cr = (cr * 255.0 - 128.0) / 224.0;
    } else {
      cb -= 128.0 / 255.0;
      cr -= 128.0 / 255.0;
    }
    c = vec4(clamp(toRgb(y, cb, cr, u_kr.xy), 0.0, 1.0), 1.0);
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
/** Unused textures kept per format and size for the next frames. */
const MAX_SPARE = 8;

interface PlaneTexture {
  texture: WebGLTexture;
  /** Format and size, the spare pool it returns to. */
  key: string;
}

const uploads = new WeakMap<GL, Map<FootageFrame, PlaneTexture[]>>();
const spares = new WeakMap<GL, Map<string, WebGLTexture[]>>();

/**
 * A bound texture with immutable storage for `width` x `height` texels of `format`. Textures of frames that left
 * the upload cache are refilled rather than deleted, so a playing movie does not allocate textures every frame.
 */
function planeTexture(gl: GL, format: number, width: number, height: number): PlaneTexture {
  const key = `${format}:${width}x${height}`;
  let pool = spares.get(gl);
  if (!pool) spares.set(gl, (pool = new Map()));
  let texture = pool.get(key)?.pop();
  if (texture) gl.bindTexture(gl.TEXTURE_2D, texture);
  else {
    texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
  }
  return { texture, key };
}

function retire(gl: GL, planes: PlaneTexture[]): void {
  const pool = spares.get(gl)!;
  for (const { texture, key } of planes) {
    const list = pool.get(key) ?? [];
    if (list.length < MAX_SPARE) {
      list.push(texture);
      pool.set(key, list);
    } else gl.deleteTexture(texture);
  }
}

/** Textures holding the frame's samples as stored (RGBA, or Y/Cb/Cr planes). */
function frameTextures(gl: GL, frame: FootageFrame): WebGLTexture[] {
  let cache = uploads.get(gl);
  if (!cache) uploads.set(gl, (cache = new Map()));
  const hit = cache.get(frame);
  if (hit) {
    cache.delete(frame);
    cache.set(frame, hit);
    return hit.map((p) => p.texture);
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  let planes: PlaneTexture[];
  if (frame.kind === "yuv") {
    // Each plane straight from the decoder's buffer, rows `stride` bytes apart; NV12's CbCr as one RG texture.
    const plane = (index: number, w: number, h: number, pairs: boolean) => {
      const p = planeTexture(gl, pairs ? gl.RG8 : gl.R8, w, h);
      const { offset, stride } = frame.planes[index];
      const bytes = pairs ? 2 : 1;
      let data = frame.data;
      let start = offset;
      let rowLength = stride / bytes;
      if (!Number.isInteger(rowLength)) {
        data = new Uint8Array(w * h * bytes);
        for (let r = 0; r < h; r++) data.set(frame.data.subarray(offset + r * stride, offset + r * stride + w * bytes), r * w * bytes);
        start = 0;
        rowLength = w;
      }
      if (rowLength !== w) gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowLength);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, pairs ? gl.RG : gl.RED, gl.UNSIGNED_BYTE, data, start);
      if (rowLength !== w) gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      return p;
    };
    const { width: w, height: h, chromaWidth: cw, chromaHeight: ch } = frame;
    planes = frame.interleaved ? [plane(0, w, h, false), plane(1, cw, ch, true)] : [plane(0, w, h, false), plane(1, cw, ch, false), plane(2, cw, ch, false)];
  } else {
    const p = planeTexture(gl, gl.RGBA8, frame.width, frame.height);
    if (frame.kind === "rgba") gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, frame.data);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.image);
    planes = [p];
  }
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
  cache.set(frame, planes);
  for (const [key, old] of cache) {
    if (cache.size <= MAX_UPLOADS) break;
    cache.delete(key);
    retire(gl, old);
  }
  return planes.map((p) => p.texture);
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
    gl.uniform1i(uniform("u_cr"), frame.kind === "yuv" && !frame.interleaved ? 2 : 0);
    gl.uniform1i(uniform("u_interleaved"), frame.kind === "yuv" && frame.interleaved ? 1 : 0);
    gl.uniform1i(uniform("u_yuv"), frame.kind === "yuv" ? 1 : 0);
    gl.uniform2i(uniform("u_size"), width, height);
    gl.uniform2i(uniform("u_chromaSize"), frame.kind === "yuv" ? frame.chromaWidth : width, frame.kind === "yuv" ? frame.chromaHeight : height);
    gl.uniform1i(uniform("u_pad"), ctx.pad);
    gl.uniform1i(uniform("u_limited"), frame.kind === "yuv" && frame.limitedRange ? 1 : 0);
    // After Effects' matrix: BT.709 above standard definition, else BT.601.
    const [kr, kb] = frame.height > 576 ? BT709 : BT601;
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
  if (state.status === "pending") {
    ctx.loading(`footage is loading ("${item.name}")`);
    // The nearest decoded frame stands in; the viewers do not show incomplete frames once they have shown one.
    return state.fallback ? interpret(item, state.fallback, ctx) : null;
  }
  if (state.status === "missing") ctx.warn(`footage is missing ("${item.name}"); After Effects refuses to render it`);
  else ctx.warn(`footage "${item.name}" cannot be decoded: ${state.message}`);
  return null;
});
