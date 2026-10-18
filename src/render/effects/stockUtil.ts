// Shared pieces of the stock After Effects effects (colour, blur, distort,
// transition, matte and generate modules): parameter readers, GLSL colour
// helpers, layer-space sampling of images, a separable Gaussian blur, a warp
// pass and a pass combining two images in layer space.
//
// Layer points are in layer pixels, y down, pixel centres at +0.5. Images are
// padded premultiplied targets in GL row order (registry.ts).
import type { CompItem, Layer, PropertyGroup } from "../../aep/model.ts";
import { effectNumber, effectProperty, effectVector } from "../effectParams.ts";
import { acquireFloat, releaseFloat } from "../floatTargets.ts";
import type { Target } from "../gl.ts";
import { registerEffect, type EffectOptions, type LayerImage, type RenderContext } from "../registry.ts";
import { boxBlur } from "./boxBlur.ts";
import { mapPass, PASS_HEADER, type Uniforms } from "./fxextraUtil.ts";
import { boxRadiusForSigma, EXACT_SIGMA_LIMIT, popupChoice, type Rect } from "./stockMath.ts";

export type { Rect } from "./stockMath.ts";

/** Reads an effect's parameters (by 1-based index) at the render time. */
export interface Params {
  num(index: number, fallback: number): number;
  vec(index: number, fallback: number[]): number[];
  bool(index: number, fallback: boolean): boolean;
  /** A colour parameter's RGB. */
  rgb(index: number, fallback: [number, number, number]): [number, number, number];
  /**
   * A popup's choice (1-based, separators skipped; popupChoice): the effect definition's menu when the project
   * holds it, else `menu` (After Effects' own, separators included); `fallback` when the parameter is absent.
   */
  choice(index: number, fallback: number, menu?: readonly string[]): number;
}

export function params(effect: PropertyGroup, layer: Layer, time: number): Params {
  const num = (index: number, fallback: number) => {
    const v = effectNumber(effect, index, layer, time, fallback);
    return Number.isFinite(v) ? v : fallback;
  };
  const vec = (index: number, fallback: number[]) => effectVector(effect, index, layer, time, fallback);
  return {
    num,
    vec,
    bool: (index, fallback) => num(index, fallback ? 1 : 0) !== 0,
    rgb: (index, fallback) => {
      const v = vec(index, fallback);
      return [v[0] ?? fallback[0], v[1] ?? fallback[1], v[2] ?? fallback[2]];
    },
    choice: (index, fallback, menu = []) => {
      const v = num(index, Number.NaN);
      return Number.isNaN(v) ? fallback : popupChoice(v, effectProperty(effect, index)?.options ?? menu);
    },
  };
}

/** The composition a layer belongs to. */
export function compOf(ctx: RenderContext, layer: Layer): CompItem | undefined {
  for (const item of ctx.project.items.values()) if (item.kind === "comp" && item.layers.includes(layer)) return item;
  return undefined;
}

export type StockRenderer = (input: LayerImage, p: Params, ctx: RenderContext, layer: Layer, time: number, effect: PropertyGroup) => LayerImage;

/** Registers an effect whose renderer reads its parameters through `Params`. */
export function registerStock(matchName: string, render: StockRenderer, options: EffectOptions = { cacheable: true, scalable: true }): void {
  registerEffect(matchName, (input, effect, layer, time, ctx) => render(input, params(effect, layer, time), ctx, layer, time, effect), options);
}

/** GLSL: straight colour, luma, HSL and YIQ conversions. */
export const COLOR_LIB = `
vec3 straight(vec4 c) { return c.a > 0.0 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d <= 1e-6) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h = mx == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 hsl) {
  if (hsl.y <= 0.0) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(hue2rgb(p, q, hsl.x + 1.0 / 3.0), hue2rgb(p, q, hsl.x), hue2rgb(p, q, hsl.x - 1.0 / 3.0));
}
const mat3 RGB2YIQ = mat3(0.299, 0.595716, 0.211456, 0.587, -0.274453, -0.522591, 0.114, -0.321263, 0.311135);
const mat3 YIQ2RGB = mat3(1.0, 1.0, 1.0, 0.9563, -0.2721, -1.107, 0.621, -0.6474, 1.7046);
`;

/**
 * GLSL: the layer point of the fragment being written (u_size, u_pad, u_origin describe the output image), and
 * the texture coordinate of a layer point in an image with origin `o`, content height `h` and target size `t`.
 */
export const COORDS = `
uniform vec2 u_size;
uniform float u_pad;
uniform vec2 u_origin;
vec2 layerPoint() { return vec2(gl_FragCoord.x - u_pad + u_origin.x, u_size.y - gl_FragCoord.y - u_pad + u_origin.y); }
vec2 uvIn(vec2 q, vec2 o, float h, vec2 t) { return vec2(q.x - o.x + u_pad, h + u_pad - (q.y - o.y)) / t; }
bool insideContent() {
  vec2 px = gl_FragCoord.xy;
  return px.x > u_pad && px.y > u_pad && px.x < u_size.x - u_pad && px.y < u_size.y - u_pad;
}
`;

/**
 * The layer's own rectangle in the input's pixels: an AV layer's source box, a shape layer's comp-sized box
 * centred on its origin, else the input image's extent (as boxBlur.ts's effectBounds).
 */
export function layerRect(layer: Layer, input: LayerImage): Rect {
  const k = input.scale ?? 1;
  let x0: number;
  let y0: number;
  if (layer.width > 0 && layer.height > 0 && layer.layerType === "AVLayer") [x0, y0] = [0, 0];
  else if (layer.width > 0 && layer.height > 0 && layer.layerType === "ShapeLayer") [x0, y0] = [-Math.floor(layer.width / 2), -Math.floor(layer.height / 2)];
  else return imageRect(input);
  const x1 = Math.ceil((x0 + layer.width) * k - 1e-6);
  const y1 = Math.ceil((y0 + layer.height) * k - 1e-6);
  const fx = Math.floor(x0 * k + 1e-6);
  const fy = Math.floor(y0 * k + 1e-6);
  return { x: fx, y: fy, width: x1 - fx, height: y1 - fy };
}

export const imageRect = (image: LayerImage): Rect => ({ x: image.origin[0], y: image.origin[1], width: image.width, height: image.height });

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function growRect(r: Rect, gx: number, gy = gx): Rect {
  const x = Math.ceil(Math.max(0, gx));
  const y = Math.ceil(Math.max(0, gy));
  return { x: r.x - x, y: r.y - y, width: r.width + 2 * x, height: r.height + 2 * y };
}

/** The largest output a distortion may grow the layer to, per side (image pixels). */
export const MAX_EXTENT = 16384;

/** `r` grown to whole pixels, within MAX_EXTENT of the origin. */
export const clampRect = (r: Rect): Rect => {
  const x = Math.max(-MAX_EXTENT, Math.floor(r.x));
  const y = Math.max(-MAX_EXTENT, Math.floor(r.y));
  return { x, y, width: Math.min(MAX_EXTENT, Math.ceil(r.x + r.width)) - x, height: Math.min(MAX_EXTENT, Math.ceil(r.y + r.height)) - y };
};

/** The default of an effect's centre point (layer pixels): the middle of a sized layer's box, else of its image. */
export function layerCenter(layer: Layer, input: LayerImage): [number, number] {
  if (layer.width > 0 && layer.height > 0) return [layer.width / 2, layer.height / 2];
  const k = input.scale ?? 1;
  return [(input.origin[0] + input.width / 2) / k, (input.origin[1] + input.height / 2) / k];
}

/** A new padded image covering `rect`. */
function acquireRect(ctx: RenderContext, rect: Rect, clear = false): LayerImage {
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const target = ctx.pool.acquire(width + 2 * ctx.pad, height + 2 * ctx.pad, clear);
  return { target, width, height, origin: [Math.round(rect.x), Math.round(rect.y)] };
}

/** Binds an image's placement uniforms `<name>Origin`, `<name>Height`, `<name>Target`. */
function bindImage(ctx: RenderContext, u: (name: string) => WebGLUniformLocation | null, name: string, image: LayerImage): void {
  ctx.gl.uniform2f(u(`${name}Origin`), image.origin[0], image.origin[1]);
  ctx.gl.uniform1f(u(`${name}Height`), image.height);
  ctx.gl.uniform2f(u(`${name}Target`), image.target.width, image.target.height);
}

const imageUniforms = (name: string) => `uniform vec2 ${name}Origin;\nuniform float ${name}Height;\nuniform vec2 ${name}Target;\n`;

/**
 * Writes `rect` from `sources` (texture units 0..n-1, sampled as u_src0..): `body` is GLSL setting `outColor` from
 * the layer point `p`; `at(i, q)` samples source i at layer point q (bilinear, transparent outside its content).
 * Releases nothing.
 */
export function layerPass(ctx: RenderContext, rect: Rect, sources: LayerImage[], decls: string, body: string, setUniforms?: Uniforms, scale?: number): LayerImage {
  const out = acquireRect(ctx, rect);
  const samplers = sources.map((_, i) => `uniform sampler2D u_src${i};\n${imageUniforms(`u_img${i}`)}`).join("");
  const cases = sources
    .map((_, i) => `  if (i == ${i}) { vec2 uv = uvIn(q, u_img${i}Origin, u_img${i}Height, u_img${i}Target); vec2 t = uv * u_img${i}Target;
    if (t.x < u_pad || t.y < u_pad || t.x > u_img${i}Target.x - u_pad || t.y > u_img${i}Target.y - u_pad) return vec4(0.0);
    return texture(u_src${i}, uv); }`)
    .join("\n");
  const fragment = `#version 300 es
precision highp float;
out vec4 outColor;
${COORDS}${COLOR_LIB}${samplers}${decls}
vec4 at(int i, vec2 q) {
${cases}
  return vec4(0.0);
}
void main() {
  if (!insideContent()) { outColor = vec4(0.0); return; }
  vec2 p = layerPoint();
${body}
}`;
  ctx.pass(ctx.program(fragment), out.target, sources.map((s) => s.target), (u) => {
    const gl = ctx.gl;
    gl.uniform2f(u("u_size"), out.target.width, out.target.height);
    gl.uniform1f(u("u_pad"), ctx.pad);
    gl.uniform2f(u("u_origin"), out.origin[0], out.origin[1]);
    sources.forEach((s, i) => {
      gl.uniform1i(u(`u_src${i}`), i);
      bindImage(ctx, u, `u_img${i}`, s);
    });
    setUniforms?.(u);
  });
  return scale === undefined ? out : { ...out, scale };
}

/** `input` moved into `rect` (content outside it cut away); releases `input`. */
export function reframe(ctx: RenderContext, input: LayerImage, rect: Rect): LayerImage {
  const r = imageRect(input);
  if (r.x === rect.x && r.y === rect.y && r.width === rect.width && r.height === rect.height) return input;
  const out = layerPass(ctx, rect, [input], "", "  outColor = at(0, p);", undefined, input.scale);
  ctx.pool.release(input.target);
  return out;
}

/**
 * Per-pixel colour adjustment on straight colour: `glsl` declares its uniforms and `vec3 adjust(vec3 s)`; alpha is
 * kept. Releases `input`.
 */
export function colorPass(ctx: RenderContext, input: LayerImage, glsl: string, setUniforms?: Uniforms): LayerImage {
  const fragment = `${PASS_HEADER}${COLOR_LIB}${glsl}
void main() {
  vec4 c = texture(u_source, v_uv);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  vec3 r = clamp(adjust(straight(c)), 0.0, 1.0);
  outColor = vec4(r * c.a, c.a);
}`;
  return mapPass(ctx, input, fragment, setUniforms);
}

/** Registers a colour adjustment (colorPass); `uniforms` sets its uniforms from the parameters. */
export function registerColor(matchName: string, glsl: string, uniforms: (p: Params, gl: WebGL2RenderingContext, u: (name: string) => WebGLUniformLocation | null, ctx: RenderContext) => void): void {
  registerStock(matchName, (input, p, ctx) => colorPass(ctx, input, glsl, (u) => uniforms(p, ctx.gl, u, ctx)));
}

const GAUSS_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_pad;
uniform vec2 u_dir;
uniform float u_sigma;
uniform int u_radius;
uniform int u_clamp;
void main() {
  vec2 px = v_uv * u_size;
  if (px.x < u_pad || px.y < u_pad || px.x > u_size.x - u_pad || px.y > u_size.y - u_pad) { outColor = vec4(0.0); return; }
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -u_radius; i <= u_radius; i++) {
    float w = exp(-0.5 * float(i * i) / (u_sigma * u_sigma));
    vec2 q = px + u_dir * float(i);
    if (u_clamp == 1 && (q.x < u_pad || q.y < u_pad || q.x > u_size.x - u_pad || q.y > u_size.y - u_pad)) continue;
    sum += texture(u_source, q / u_size) * w;
    wsum += w;
  }
  outColor = wsum > 0.0 ? sum / wsum : vec4(0.0);
}`;

/** Entries of PAIRED_GAUSS_FS's kernel at most: the centre and the pairs of taps out to 3 sigma at EXACT_SIGMA_LIMIT. */
const MAX_KERNEL = 40;

/**
 * GAUSS_FS's sum without clamping, two taps a texture read: the bilinear read between taps i and i + 1, placed by
 * their weights, returns their weighted sum. u_kernel holds (offset, weight) pairs, the centre's first, normalised.
 */
const PAIRED_GAUSS_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_pad;
uniform vec2 u_dir;
uniform int u_taps;
uniform vec2 u_kernel[${MAX_KERNEL}];
void main() {
  vec2 px = v_uv * u_size;
  if (px.x < u_pad || px.y < u_pad || px.x > u_size.x - u_pad || px.y > u_size.y - u_pad) { outColor = vec4(0.0); return; }
  vec4 sum = texture(u_source, v_uv) * u_kernel[0].y;
  for (int k = 1; k < u_taps; k++) {
    vec2 d = u_dir * (u_kernel[k].x / u_size);
    sum += (texture(u_source, v_uv + d) + texture(u_source, v_uv - d)) * u_kernel[k].y;
  }
  outColor = sum;
}`;

/**
 * A padded image of `u_source` (u_fromSize its target, u_fromHeight its content's) averaged over f x f blocks from
 * its top-left corner (u_factor 2 or 4), each 2 x 2 of them one bilinear read. The loops count in ints to a constant,
 * as every GLSL compiler takes them.
 */
const REDUCE_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_pad;
uniform vec2 u_fromSize;
uniform float u_fromHeight;
uniform float u_factor;
void main() {
  vec2 g = gl_FragCoord.xy;
  if (g.x < u_pad || g.y < u_pad || g.x > u_size.x - u_pad || g.y > u_size.y - u_pad) { outColor = vec4(0.0); return; }
  // The block's top-left content pixel, rows from the top.
  vec2 block = vec2(floor(g.x - u_pad), floor(u_size.y - u_pad - g.y)) * u_factor;
  int reads = int(u_factor) / 2;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      if (i < reads && j < reads) {
        vec2 at = vec2(u_pad + block.x + float(2 * i) + 1.0, u_pad + u_fromHeight - 1.0 - block.y - float(2 * j));
        sum += texture(u_source, at / u_fromSize);
      }
    }
  }
  outColor = sum / float(reads * reads);
}`;

/** A reduced image of REDUCE_FS's (u_fromSize, u_fromHeight) read back at full size, bilinear. */
const EXPAND_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_pad;
uniform vec2 u_fromSize;
uniform float u_fromHeight;
uniform float u_factor;
uniform float u_height;
void main() {
  vec2 g = gl_FragCoord.xy;
  if (g.x < u_pad || g.y < u_pad || g.x > u_size.x - u_pad || g.y > u_size.y - u_pad) { outColor = vec4(0.0); return; }
  // This pixel's centre in the reduced image's pixels, rows from the top.
  vec2 c = vec2(g.x - u_pad, u_height - (g.y - u_pad)) / u_factor;
  outColor = texture(u_source, vec2(u_pad + c.x, u_pad + u_fromHeight - c.y) / u_fromSize);
}`;

/**
 * Every Gaussian with GAUSS_FS, one read a tap at full resolution: on only to check the faster ways against. With
 * `float`, its first pass keeps half float (the result alone rounds to 8 bits): a Gaussian as near true as this
 * renderer draws one.
 */
export const exactBlurs = { on: false, float: false };

/** Standard deviations (image pixels) from which a Gaussian is computed at half, and at a quarter, of the resolution. */
const REDUCE_SIGMA = [10, 20] as const;

/**
 * The image's pixels a reduced blur adds to the variance per axis: REDUCE_FS's f x f block mean ((f^2 - 1) / 12)
 * and the bilinear read back (a tent f pixels each side, f^2 / 6). The kernel takes them off, so the blur's width
 * stays sigma; what is left is the interpolation of a blur too smooth to change between reduced pixels.
 */
const reducedVariance = (f: number) => (f * f - 1) / 12 + (f * f) / 6;

/** GAUSS_FS's kernel for `sigma` out to `radius`, as PAIRED_GAUSS_FS reads it: (offset, weight) per texture read. */
export function pairedKernel(sigma: number, radius: number): Float32Array {
  const w = (i: number) => Math.exp((-0.5 * i * i) / (sigma * sigma));
  let total = w(0);
  for (let i = 1; i <= radius; i++) total += 2 * w(i);
  const kernel = new Float32Array(2 * MAX_KERNEL);
  kernel[1] = w(0) / total;
  let n = 1;
  for (let i = 1; i <= radius; i += 2) {
    const a = w(i);
    const b = i + 1 <= radius ? w(i + 1) : 0;
    kernel[2 * n] = (i * a + (i + 1) * b) / (a + b);
    kernel[2 * n + 1] = (a + b) / total;
    n++;
  }
  return kernel.subarray(0, 2 * n);
}

export interface BlurOptions {
  /**
   * Repeat Edge Pixels: the result covers just this rectangle, and each pixel averages only the taps within it
   * (as boxBlur.ts measured for Fast Box Blur), so no transparency from beyond its edges is mixed in.
   */
  repeatEdges?: Rect;
}

/**
 * Gaussian blur of a premultiplied image with standard deviations in image pixels, grown by the blur's reach
 * unless edges are repeated: an exact kernel truncated at 3 sigma up to EXACT_SIGMA_LIMIT, above it three box
 * passes of the same variance. Releases `input`.
 */
export function gaussian(ctx: RenderContext, input: LayerImage, sigmaX: number, sigmaY: number, o: BlurOptions = {}): LayerImage {
  const sx = sigmaX >= 0.1 ? sigmaX : 0;
  const sy = sigmaY >= 0.1 ? sigmaY : 0;
  if (!sx && !sy) return o.repeatEdges ? reframe(ctx, input, o.repeatEdges) : input;
  const scale = input.scale;
  if (Math.max(sx, sy) > EXACT_SIGMA_LIMIT) {
    const radius = boxRadiusForSigma(Math.max(sx, sy));
    const bounds = o.repeatEdges && { origin: [o.repeatEdges.x, o.repeatEdges.y] as [number, number], width: o.repeatEdges.width, height: o.repeatEdges.height };
    const out = boxBlur(ctx, input, { radius, iterations: 3, horizontal: sx > 0, vertical: sy > 0, repeatEdges: !!o.repeatEdges, bounds: bounds || undefined });
    return scale === undefined ? out : { ...out, scale };
  }
  const rx = Math.ceil(3 * sx);
  const ry = Math.ceil(3 * sy);
  let image = reframe(ctx, input, o.repeatEdges ?? growRect(imageRect(input), rx, ry));
  // Wide on both axes: blurred at a lower resolution (see reducedVariance), where Repeat Edge Pixels does not ask more.
  const exact = !!o.repeatEdges || exactBlurs.on;
  const factor = exact ? 1 : Math.min(sx, sy) >= REDUCE_SIGMA[1] ? 4 : Math.min(sx, sy) >= REDUCE_SIGMA[0] ? 2 : 1;
  if (factor > 1) return reducedGaussian(ctx, image, sx, sy, factor);
  for (const [sigma, radius, dir] of [
    [sx, rx, [1, 0]],
    [sy, ry, [0, 1]],
  ] as const) {
    if (!sigma) continue;
    // Repeat Edge Pixels leaves out each tap beyond the edges, which a read of two taps cannot.
    if (exact) {
      const uniforms = (u: (name: string) => WebGLUniformLocation | null) => {
        ctx.gl.uniform2f(u("u_dir"), dir[0], dir[1]);
        ctx.gl.uniform1f(u("u_sigma"), sigma);
        ctx.gl.uniform1i(u("u_radius"), radius);
        ctx.gl.uniform1i(u("u_clamp"), o.repeatEdges ? 1 : 0);
      };
      if (exactBlurs.float && sx && sy && dir[0]) {
        const half = acquireFloat(ctx, image.target.width, image.target.height, true);
        ctx.pass(ctx.program(GAUSS_FS), half, [image.target], (u) => {
          ctx.gl.uniform1i(u("u_source"), 0);
          ctx.gl.uniform2f(u("u_size"), half.width, half.height);
          ctx.gl.uniform1f(u("u_pad"), ctx.pad);
          uniforms(u);
        });
        ctx.pool.release(image.target);
        const out = ctx.pool.acquire(half.width, half.height, false);
        ctx.pass(ctx.program(GAUSS_FS), out, [half], (u) => {
          ctx.gl.uniform1i(u("u_source"), 0);
          ctx.gl.uniform2f(u("u_size"), out.width, out.height);
          ctx.gl.uniform1f(u("u_pad"), ctx.pad);
          ctx.gl.uniform2f(u("u_dir"), 0, 1);
          ctx.gl.uniform1f(u("u_sigma"), sy);
          ctx.gl.uniform1i(u("u_radius"), ry);
          ctx.gl.uniform1i(u("u_clamp"), o.repeatEdges ? 1 : 0);
        });
        releaseFloat(ctx, half);
        return { ...image, target: out };
      }
      image = mapPass(ctx, image, GAUSS_FS, uniforms);
      continue;
    }
    const kernel = pairedKernel(sigma, radius);
    image = mapPass(ctx, image, PAIRED_GAUSS_FS, (u) => {
      ctx.gl.uniform2f(u("u_dir"), dir[0], dir[1]);
      ctx.gl.uniform1i(u("u_taps"), kernel.length / 2);
      ctx.gl.uniform2fv(u("u_kernel"), kernel);
    });
  }
  return image;
}

/**
 * `image` blurred by sigmaX, sigmaY at 1 / `f` of its resolution and read back at full size; releases `image`. The
 * reduced images are half float, so only the result rounds to 8 bits.
 */
function reducedGaussian(ctx: RenderContext, image: LayerImage, sigmaX: number, sigmaY: number, f: number): LayerImage {
  const gl = ctx.gl;
  const width = Math.ceil(image.width / f);
  const height = Math.ceil(image.height / f);
  const reduced = () => acquireFloat(ctx, width + 2 * ctx.pad, height + 2 * ctx.pad, true);
  const placed = (u: (name: string) => WebGLUniformLocation | null, to: Target) => {
    gl.uniform1i(u("u_source"), 0);
    gl.uniform2f(u("u_size"), to.width, to.height);
    gl.uniform1f(u("u_pad"), ctx.pad);
  };
  const scaled = (u: (name: string) => WebGLUniformLocation | null, from: Target, fromHeight: number, to: Target) => {
    placed(u, to);
    gl.uniform2f(u("u_fromSize"), from.width, from.height);
    gl.uniform1f(u("u_fromHeight"), fromHeight);
    gl.uniform1f(u("u_factor"), f);
  };
  let small = reduced();
  ctx.pass(ctx.program(REDUCE_FS), small, [image.target], (u) => scaled(u, image.target, image.height, small));
  for (const [sigma, dir] of [
    [sigmaX, [1, 0]],
    [sigmaY, [0, 1]],
  ] as const) {
    const s = Math.sqrt(Math.max(0, sigma * sigma - reducedVariance(f))) / f;
    const kernel = pairedKernel(s, Math.ceil(3 * s));
    const next = reduced();
    ctx.pass(ctx.program(PAIRED_GAUSS_FS), next, [small], (u) => {
      placed(u, next);
      gl.uniform2f(u("u_dir"), dir[0], dir[1]);
      gl.uniform1i(u("u_taps"), kernel.length / 2);
      gl.uniform2fv(u("u_kernel"), kernel);
    });
    releaseFloat(ctx, small);
    small = next;
  }
  const out: LayerImage = { ...image, target: ctx.pool.acquire(image.target.width, image.target.height, false) };
  ctx.pass(ctx.program(EXPAND_FS), out.target, [small], (u) => {
    scaled(u, small, height, out.target);
    gl.uniform1f(u("u_height"), image.height);
  });
  releaseFloat(ctx, small);
  ctx.pool.release(image.target);
  return out;
}

/**
 * Resamples `input` into `rect`: `map` is GLSL `vec2 map(vec2 p)` giving the input layer point shown at output
 * layer point p (bilinear; transparent outside the input), with `decls` declaring its uniforms. `post` may change
 * `outColor` afterwards (p and the sample `c` in scope). Releases `input`.
 */
export function warp(ctx: RenderContext, input: LayerImage, rect: Rect, decls: string, setUniforms?: Uniforms, post = ""): LayerImage {
  const out = layerPass(ctx, rect, [input], decls, `  vec4 c = at(0, map(p));\n  outColor = c;\n${post}`, setUniforms, input.scale);
  ctx.pool.release(input.target);
  return out;
}

/** Blur Dimensions popups: 1 both, 2 horizontal, 3 vertical. */
export function blurAxes(dimensions: number): [boolean, boolean] {
  return [dimensions !== 3, dimensions !== 2];
}
