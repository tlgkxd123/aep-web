// Fast Box Blur (ADBE Box Blur2): `Iterations` passes of a box of half-width
// Blur Radius along each chosen dimension, on premultiplied pixels in float.
// A box of 2n+1 taps is summed from power-of-two partial sums
// (P[b+1](i) = P[b](i) + P[b](i + 2^b)), so a pass costs log2(radius) full-image
// draws of two fetches each, whatever the radius.
import type { Layer, PropertyGroup } from "../../aep/model.ts";
import { effectNumber } from "../effectParams.ts";
import { acquireFloat, releaseFloat } from "../floatTargets.ts";
import type { Target } from "../gl.ts";
import { registerEffect, type LayerImage, type RenderContext } from "../registry.ts";

const Dimensions = { BOTH: 1, HORIZONTAL: 2, VERTICAL: 3 } as const;

const AXIS_HEADER = `#version 300 es
precision highp float;
precision highp int;
uniform ivec2 u_axis;
uniform sampler2D u_x;
uniform sampler2D u_p;
uniform sampler2D u_acc;
// The image being blurred spans indices [0, u_xSize) along the axis, transparent outside.
uniform int u_xSize;
// P[b] is stored with index i at texel i + u_pOffset, over u_pSize texels; level 0 is the image itself.
uniform int u_level0;
uniform int u_pOffset;
uniform int u_pSize;
out vec4 outColor;

ivec2 texel(ivec2 t, int i) { return u_axis.x == 1 ? ivec2(i, t.y) : ivec2(t.x, i); }
int along(ivec2 t) { return u_axis.x == 1 ? t.x : t.y; }

vec4 xAt(ivec2 t, int i) {
  if (i < 0 || i >= u_xSize) return vec4(0.0);
  return texelFetch(u_x, texel(t, i), 0);
}

vec4 pAt(ivec2 t, int i) {
  if (u_level0 == 1) return xAt(t, i);
  int k = i + u_pOffset;
  if (k < 0 || k >= u_pSize) return vec4(0.0);
  return texelFetch(u_p, texel(t, k), 0);
}
`;

/** P[b+1] from P[b]: the sum of 2^(b+1) consecutive samples starting at each index. */
const LEVEL_FS = `${AXIS_HEADER}
uniform int u_outOffset;
uniform int u_step;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int i = along(t) - u_outOffset;
  outColor = pAt(t, i) + pAt(t, i + u_step);
}`;

/** Adds the next binary piece of the window [i - n, i + n] to the running sum. */
const ACCUMULATE_FS = `${AXIS_HEADER}
uniform int u_hasAcc;
uniform int u_start;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 acc = u_hasAcc == 1 ? texelFetch(u_acc, t, 0) : vec4(0.0);
  outColor = acc + pAt(t, along(t) + u_start);
}`;

/**
 * The window sum plus the fractional outer taps, divided by the full window, or with u_inside by the weight of
 * the taps within [u_lo, u_hi) (After Effects' Repeat Edge Pixels: the extent of the previous pass).
 */
const FINISH_FS = `${AXIS_HEADER}
uniform int u_n;
uniform float u_frac;
uniform int u_inside;
uniform int u_lo;
uniform int u_hi;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int i = along(t);
  vec4 sum = texelFetch(u_acc, t, 0);
  if (u_frac > 0.0) sum += u_frac * (xAt(t, i - u_n - 1) + xAt(t, i + u_n + 1));
  float weight = 2.0 * (float(u_n) + u_frac) + 1.0;
  if (u_inside == 1) {
    int outerLo = i - u_n - 1;
    int outerHi = i + u_n + 1;
    weight = float(max(0, min(u_hi - 1, outerHi - 1) - max(u_lo, outerLo + 1) + 1));
    if (outerLo >= u_lo && outerLo < u_hi) weight += u_frac;
    if (outerHi >= u_lo && outerHi < u_hi) weight += u_frac;
  }
  outColor = weight > 0.0 ? sum / weight : vec4(0.0);
}`;

/** The padded RGBA8 layer image into a float image; u_offset maps float texels to input texels (GL rows). */
const LOAD_FS = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform ivec2 u_offset;
uniform ivec2 u_size;
uniform int u_pad;
out vec4 outColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) + u_offset;
  outColor = any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, u_size)) ? vec4(0.0) : texelFetch(u_source, c + u_pad, 0);
}`;

/** The u_size window at u_crop of a float image into a padded RGBA8 layer image. */
const STORE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform ivec2 u_size;
uniform ivec2 u_crop;
uniform int u_pad;
out vec4 outColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) - u_pad;
  if (any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, u_size))) {
    outColor = vec4(0.0);
    return;
  }
  vec4 v = clamp(texelFetch(u_source, c + u_crop, 0), 0.0, 1.0);
  outColor = vec4(min(v.rgb, v.a), v.a);
}`;

interface Plane {
  target: Target;
  width: number;
  height: number;
}

/**
 * One box pass of half-width `radius` (n whole taps each side plus a fractional outer tap) along an axis;
 * with `inside` = [lo, hi) it averages only the taps in that range. Releases `x`.
 */
function boxPass(ctx: RenderContext, x: Plane, horizontal: boolean, radius: number, inside?: [number, number]): Plane {
  const gl = ctx.gl;
  const n = Math.floor(radius);
  const frac = radius - n;
  const taps = 2 * n + 1;
  const size = horizontal ? x.width : x.height;
  const pSize = size + 2 * n;
  const common = (u: (name: string) => WebGLUniformLocation | null) => {
    gl.uniform1i(u("u_x"), 0);
    gl.uniform1i(u("u_p"), 1);
    gl.uniform1i(u("u_acc"), 2);
    gl.uniform2i(u("u_axis"), horizontal ? 1 : 0, horizontal ? 0 : 1);
    gl.uniform1i(u("u_xSize"), size);
    gl.uniform1i(u("u_pOffset"), n);
    gl.uniform1i(u("u_pSize"), pSize);
  };
  let p: Target | undefined;
  let acc: Target | undefined;
  let start = -n;
  for (let b = 0; ; b++) {
    const bit = 2 ** b;
    if (taps & bit) {
      const next = acquireFloat(ctx, x.width, x.height);
      ctx.pass(ctx.program(ACCUMULATE_FS), next, [x.target, p ?? x.target, acc ?? x.target], (u) => {
        common(u);
        gl.uniform1i(u("u_level0"), p ? 0 : 1);
        gl.uniform1i(u("u_hasAcc"), acc ? 1 : 0);
        gl.uniform1i(u("u_start"), start);
      });
      releaseFloat(ctx, acc);
      acc = next;
      start += bit;
    }
    if (taps < 2 * bit) break;
    const next = acquireFloat(ctx, horizontal ? pSize : x.width, horizontal ? x.height : pSize);
    ctx.pass(ctx.program(LEVEL_FS), next, [x.target, p ?? x.target, x.target], (u) => {
      common(u);
      gl.uniform1i(u("u_level0"), p ? 0 : 1);
      gl.uniform1i(u("u_outOffset"), n);
      gl.uniform1i(u("u_step"), bit);
    });
    releaseFloat(ctx, p);
    p = next;
  }
  releaseFloat(ctx, p);
  const out = acquireFloat(ctx, x.width, x.height);
  ctx.pass(ctx.program(FINISH_FS), out, [x.target, x.target, acc!], (u) => {
    common(u);
    gl.uniform1i(u("u_level0"), 1);
    gl.uniform1i(u("u_n"), n);
    gl.uniform1f(u("u_frac"), frac);
    gl.uniform1i(u("u_inside"), inside ? 1 : 0);
    gl.uniform1i(u("u_lo"), inside?.[0] ?? 0);
    gl.uniform1i(u("u_hi"), inside?.[1] ?? size);
  });
  releaseFloat(ctx, acc, x.target);
  return { target: out, width: x.width, height: x.height };
}

export interface BoxBlurOptions {
  radius: number;
  iterations: number;
  horizontal: boolean;
  vertical: boolean;
  /**
   * After Effects' Repeat Edge Pixels: each pass spreads past the extent of the previous one as usual but
   * averages only the taps within that extent (so no transparency from beyond the layer is mixed in), and the
   * result is cropped back to the layer. Measured on 1D profiles; repeating the edge pixels themselves misses
   * After Effects by up to 52/255.
   */
  repeatEdges: boolean;
  /**
   * The rectangle (layer space) the blur starts from, by default the input image's. Content outside it is cut
   * away; with Repeat Edge Pixels its edges are the ones repeated.
   */
  bounds?: { origin: [number, number]; width: number; height: number };
}

/** Iterated separable box blur of a layer image; releases `input`. */
export function boxBlur(ctx: RenderContext, input: LayerImage, o: BoxBlurOptions): LayerImage {
  const gl = ctx.gl;
  if (o.radius <= 0 || (!o.horizontal && !o.vertical)) return input;
  const base = o.bounds ?? input;
  const step = Math.ceil(o.radius);
  const gx = o.horizontal ? o.iterations * step : 0;
  const gy = o.vertical ? o.iterations * step : 0;
  const width = base.width + 2 * gx;
  const height = base.height + 2 * gy;
  let plane: Plane = { target: acquireFloat(ctx, width, height), width, height };
  ctx.pass(ctx.program(LOAD_FS), plane.target, [input.target], (u) => {
    gl.uniform1i(u("u_source"), 0);
    gl.uniform2i(u("u_offset"), base.origin[0] - gx - input.origin[0], input.height - height - base.origin[1] + gy + input.origin[1]);
    gl.uniform2i(u("u_size"), input.width, input.height);
    gl.uniform1i(u("u_pad"), ctx.pad);
  });
  const extent = (grow: number, size: number, k: number): [number, number] | undefined =>
    o.repeatEdges ? [grow - k * step, grow + size + k * step] : undefined;
  for (let k = 0; k < o.iterations; k++) {
    if (o.horizontal) plane = boxPass(ctx, plane, true, o.radius, extent(gx, base.width, k));
    if (o.vertical) plane = boxPass(ctx, plane, false, o.radius, extent(gy, base.height, k));
  }
  const [cx, cy] = o.repeatEdges ? [gx, gy] : [0, 0];
  const outWidth = width - 2 * cx;
  const outHeight = height - 2 * cy;
  const out = ctx.pool.acquire(outWidth + 2 * ctx.pad, outHeight + 2 * ctx.pad);
  ctx.pass(ctx.program(STORE_FS), out, [plane.target], (u) => {
    gl.uniform1i(u("u_source"), 0);
    gl.uniform2i(u("u_size"), outWidth, outHeight);
    gl.uniform2i(u("u_crop"), cx, cy);
    gl.uniform1i(u("u_pad"), ctx.pad);
  });
  releaseFloat(ctx, plane.target);
  ctx.pool.release(input.target);
  return { target: out, width: outWidth, height: outHeight, origin: [base.origin[0] - gx + cx, base.origin[1] - gy + cy] };
}

/**
 * The buffer After Effects hands the effect: the layer's rectangle in layer space (its source's, or a shape
 * layer's comp-sized box centred on its origin), grown to whatever an earlier effect spread beyond it.
 */
export function effectBounds(layer: Layer, input: LayerImage): BoxBlurOptions["bounds"] {
  if (layer.width <= 0 || layer.height <= 0) return undefined;
  let x0: number;
  let y0: number;
  if (layer.layerType === "ShapeLayer") [x0, y0] = [-Math.floor(layer.width / 2), -Math.floor(layer.height / 2)];
  else if (layer.layerType === "AVLayer") [x0, y0] = [0, 0];
  else return undefined;
  const left = Math.min(x0, input.origin[0]);
  const top = Math.min(y0, input.origin[1]);
  const right = Math.max(x0 + layer.width, input.origin[0] + input.width);
  const bottom = Math.max(y0 + layer.height, input.origin[1] + input.height);
  return { origin: [left, top], width: right - left, height: bottom - top };
}

function fastBoxBlur(input: LayerImage, effect: PropertyGroup, layer: Layer, time: number, ctx: RenderContext): LayerImage {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  const dims = num(3, Dimensions.BOTH);
  const repeatEdges = num(4, 0) !== 0;
  return boxBlur(ctx, input, {
    radius: Math.max(0, num(1, 0)),
    iterations: Math.min(50, Math.max(1, Math.round(num(2, 1)))),
    horizontal: dims !== Dimensions.VERTICAL,
    vertical: dims !== Dimensions.HORIZONTAL,
    repeatEdges,
    // The edges repeated are the buffer's, wherever the layer's content image ends.
    bounds: repeatEdges ? effectBounds(layer, input) : undefined,
  });
}

registerEffect("ADBE Box Blur2", fastBoxBlur);
