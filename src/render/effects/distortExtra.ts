// Distort effects beyond distort.ts and displace.ts, fitted to After Effects renders of the distort2 fixtures.
// Points are layer pixels. Most of these effects place their points with pixel centres on whole numbers, so a point
// parameter (x, y) is the layer point (x + 0.5, y + 0.5); Magnify and CC Tiler take it as it is. At a reduced
// resolution lengths and points are multiplied by the image's scale. Each output pixel shows the input at the point
// the effect's map gives, bilinear, transparent outside the input.
import { layerTimeAt } from "../../aep/evaluate.ts";
import type { Layer } from "../../aep/model.ts";
import type { LayerImage } from "../registry.ts";
import { cornerPinInverse } from "./stockMath.ts";
import { clampRect, growRect, imageRect, layerPass, layerRect, registerStock, unionRect, warp, type Params, type Rect } from "./stockUtil.ts";

/** A point parameter in image pixels, at the image's scale; `shift` 0.5 for effects placing points on pixel centres. */
function point(p: Params, index: number, layer: Layer, input: LayerImage, shift = 0.5): [number, number] {
  const k = input.scale ?? 1;
  const box = layerRect(layer, input);
  const v = p.vec(index, [box.x / k + box.width / k / 2, box.y / k + box.height / k / 2]);
  return [v[0] * k + shift, (v[1] ?? 0) * k + shift];
}

const discRect = (c: number[], r: number): Rect => ({ x: c[0] - r, y: c[1] - r, width: 2 * r, height: 2 * r });

/** An empty image, for effects whose parameters leave nothing to draw; releases `input`. */
function nothing(input: LayerImage, ctx: Parameters<typeof warp>[0]): LayerImage {
  ctx.pool.release(input.target);
  return layerPass(ctx, { ...imageRect(input), width: 1, height: 1 }, [], "", "  outColor = vec4(0.0);", undefined, input.scale);
}

// Spherize: the disc of Radius about Center of Sphere magnified as if wrapped on a sphere. The point at a fraction t of
// the radius shows the layer at t (0.6419 + 0.2268 t^2 + 0.1313 t^4) of it (fitted to After Effects' renders to within
// 0.05 pixels); the layer grows to the disc.
registerStock("ADBE Spherize", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const radius = Math.max(0, p.num(1, 0)) * k;
  if (radius < 0.5) return input;
  const c = point(p, 2, layer, input);
  const rect = clampRect(unionRect(imageRect(input), discRect(c, radius)));
  return warp(
    ctx,
    input,
    rect,
    `uniform vec2 u_center;
uniform float u_radius;
vec2 map(vec2 p) {
  vec2 v = p - u_center;
  float t2 = dot(v, v) / (u_radius * u_radius);
  if (t2 >= 1.0) return p;
  return u_center + v * (0.6419 + t2 * (0.2268 + 0.1313 * t2));
}`,
    (u) => {
      ctx.gl.uniform2f(u("u_center"), c[0], c[1]);
      ctx.gl.uniform1f(u("u_radius"), radius);
    },
  );
});

// Ripple: rings about Ripple Center move the layer by Wave Height / 4 times cos(pi d / Wave Width + Phase - 2 pi Speed
// t) at distance d, fading over a smoothstep to nothing at Radius percent of the layer's diagonal. Asymmetric moves
// pixels along (1, 1), Symmetric away from the centre. The layer grows by the largest move.
registerStock(
  "ADBE Ripple",
  (input, p, ctx, layer, time) => {
    const k = input.scale ?? 1;
    const box = layerRect(layer, input);
    const reach = (Math.max(0, p.num(1, 0)) / 100) * Math.hypot(box.width, box.height);
    const amplitude = (p.num(6, 20) / 4) * k;
    if (reach < 0.5 || Math.abs(amplitude) < 1e-3) return input;
    const c = point(p, 2, layer, input);
    const symmetric = p.choice(3, 1) === 2;
    const width = Math.max(1, p.num(5, 20)) * k;
    const phase = (p.num(7, 0) * Math.PI) / 180 - 2 * Math.PI * p.num(4, 1) * layerTimeAt(layer, time);
    const rect = clampRect(growRect(imageRect(input), Math.abs(amplitude)));
    return warp(
      ctx,
      input,
      rect,
      `uniform vec2 u_center;
uniform float u_reach;
uniform float u_amplitude;
uniform float u_width;
uniform float u_phase;
uniform int u_symmetric;
vec2 map(vec2 p) {
  vec2 v = p - u_center;
  float d = length(v);
  if (d >= u_reach) return p;
  float f = 1.0 - d / u_reach;
  float move = u_amplitude * f * f * (3.0 - 2.0 * f) * cos(3.14159265 * d / u_width + u_phase);
  if (u_symmetric == 1) return d > 0.0 ? p + v * (move / d) : p;
  return p + vec2(move);
}`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform2f(u("u_center"), c[0], c[1]);
        gl.uniform1f(u("u_reach"), reach);
        gl.uniform1f(u("u_amplitude"), amplitude);
        gl.uniform1f(u("u_width"), width);
        gl.uniform1f(u("u_phase"), phase);
        gl.uniform1i(u("u_symmetric"), symmetric ? 1 : 0);
      },
    );
  },
  { scalable: true },
);

const MagnifyBlend = { NONE: 1, NORMAL: 2 } as const;

// Magnify: the layer magnified Magnification percent about Center inside a circle of radius Size (a square of half
// side Size), over the layer at Opacity. The edge eases over a smoothstep Feather + 0.75 pixels to each side; Link
// grows Size (and Feather) with the magnification; Resize Layer grows the layer to the magnified area. Blending None
// replaces the layer there, Normal lays the magnified layer over it; the other modes and the Soft and Scatter scalings
// are drawn as Normal and Standard.
registerStock("ADBE Magnify", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const c = point(p, 1, layer, input, 0);
  const magnification = Math.max(1e-3, p.num(3, 150) / 100);
  const link = p.choice(11, 1);
  const size = Math.max(0, p.num(2, 100)) * k * (link >= 2 ? magnification : 1);
  const feather = Math.max(0, p.num(4, 0)) * k * (link === 3 ? magnification : 1);
  const blend = p.choice(12, MagnifyBlend.NORMAL);
  if (blend > MagnifyBlend.NORMAL) ctx.warn("Magnify: blending modes other than None and Normal are drawn as Normal");
  if (p.choice(8, 1) !== 1) ctx.warn("Magnify: Soft and Scatter scaling are drawn as Standard");
  const ease = feather + 0.75;
  const rect = p.bool(9, false) ? clampRect(unionRect(imageRect(input), discRect(c, size + ease))) : imageRect(input);
  const out = layerPass(
    ctx,
    rect,
    [input],
    `uniform vec2 u_center;
uniform float u_inverse;
uniform float u_extent;
uniform float u_ease;
uniform int u_square;
uniform float u_opacity;
uniform int u_replace;`,
    `  vec2 v = p - u_center;
  float d = u_square == 1 ? max(abs(v.x), abs(v.y)) : length(v);
  float t = clamp((u_extent + u_ease - d) / (2.0 * u_ease), 0.0, 1.0);
  float w = t * t * (3.0 - 2.0 * t) * u_opacity;
  vec4 o = at(0, p);
  vec4 m = at(0, u_center + v * u_inverse);
  outColor = u_replace == 1 ? mix(o, m, w) : m * w + o * (1.0 - m.a * w);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_center"), c[0], c[1]);
      gl.uniform1f(u("u_inverse"), 1 / magnification);
      gl.uniform1f(u("u_extent"), size);
      gl.uniform1f(u("u_ease"), ease);
      gl.uniform1i(u("u_square"), p.choice(10, 1) === 2 ? 1 : 0);
      gl.uniform1f(u("u_opacity"), Math.min(1, Math.max(0, p.num(5, 100) / 100)));
      gl.uniform1i(u("u_replace"), blend === MagnifyBlend.NONE ? 1 : 0);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

// CC Lens: a disc of radius Size percent of half the layer's diagonal about Center; the point at a fraction t of the
// radius shows the layer at (1 - Convergence / 100 t^2) of its distance. The disc's edge fades over sqrt(2) pixels and
// nothing is drawn outside it.
registerStock("CC Lens", (input, p, ctx, layer) => {
  const box = layerRect(layer, input);
  const radius = (Math.max(0, p.num(2, 50)) / 100) * (Math.hypot(box.width, box.height) / 2);
  if (radius < 0.5) return nothing(input, ctx);
  const c = point(p, 1, layer, input);
  return warp(
    ctx,
    input,
    clampRect(discRect(c, radius)),
    `uniform vec2 u_center;
uniform float u_radius;
uniform float u_convergence;
vec2 map(vec2 p) {
  vec2 v = p - u_center;
  return u_center + v * (1.0 - u_convergence * dot(v, v) / (u_radius * u_radius));
}`,
    (u) => {
      ctx.gl.uniform2f(u("u_center"), c[0], c[1]);
      ctx.gl.uniform1f(u("u_radius"), radius);
      ctx.gl.uniform1f(u("u_convergence"), p.num(3, 100) / 100);
    },
    "  outColor = c * clamp((u_radius - length(p - u_center)) / 1.41421356, 0.0, 1.0);",
  );
});

/**
 * GLSL `vec4 shearSample(vec2 q, vec2 size)` for layerPass bodies over source 0: the layer's mean over the box of
 * `size` pixels about q, each pixel's value held across it. The CC effects that shear the layer along x filter it
 * so, over 1 + 2 |shear| pixels across and the inverse of the vertical scale (at least one) down.
 */
const SHEAR_SAMPLE = `vec4 at(int i, vec2 q);
vec4 shearRow(float y, float a, float b) {
  vec4 sum = vec4(0.0);
  for (int k = 0; k < 64; k++) {
    float i = floor(a) + float(k);
    if (i >= b) break;
    sum += at(0, vec2(i + 0.5, y)) * (min(b, i + 1.0) - max(a, i));
  }
  return sum;
}
vec4 shearSample(vec2 q, vec2 size) {
  vec2 a = q - 0.5 * size;
  vec2 b = q + 0.5 * size;
  vec4 sum = vec4(0.0);
  for (int k = 0; k < 64; k++) {
    float j = floor(a.y) + float(k);
    if (j >= b.y) break;
    sum += shearRow(j + 0.5, a.x, b.x) * (min(b.y, j + 1.0) - max(a.y, j));
  }
  return sum / (size.x * size.y);
}`;

/**
 * GLSL, after `${SHEAR_SAMPLE}`: `vec4 boxSample(vec2 q, vec2 jx, vec2 jy, float shear)`, the layer at q through
 * `shearSample`, its box spanning, along each axis, the stretch of the map's derivatives jx and jy (per output pixel
 * along x and y) plus `shear` times their shear; and, after a `vec2 map(vec2 p)`, `vec4 footprintSample(vec2 p, float
 * shear)` with map's derivatives at p.
 */
const FOOTPRINT_SAMPLE = `vec2 map(vec2 p);
vec4 boxSample(vec2 q, vec2 jx, vec2 jy, float shear) {
  return shearSample(q, max(vec2(1.0), vec2(abs(jx.x) + shear * abs(jy.x), abs(jy.y) + shear * abs(jx.y))));
}
vec4 footprintSample(vec2 p, float shear) {
  vec2 jx = map(p + vec2(0.5, 0.0)) - map(p - vec2(0.5, 0.0));
  vec2 jy = map(p + vec2(0.0, 0.5)) - map(p - vec2(0.0, 0.5));
  return boxSample(map(p), jx, jy, shear);
}`;

// CC Slant: the layer slanted by Slant / 100 pixels across per pixel above Floor and scaled vertically about it by
// Height percent; without Stretching the slant keeps the layer's slanted sides at their length. Set Color fills it
// with Color.
registerStock("CC Slant", (input, p, ctx, layer) => {
  const slant = p.num(1, 0) / 100;
  const stretch = p.bool(2, true);
  const height = (p.num(3, 100) / 100) * (stretch ? 1 : 1 / Math.hypot(1, slant));
  if (Math.abs(height) < 1e-4) return nothing(input, ctx);
  const floor = point(p, 4, layer, input)[1];
  const r = imageRect(input);
  const corners = [
    [r.x, r.y],
    [r.x + r.width, r.y],
    [r.x, r.y + r.height],
    [r.x + r.width, r.y + r.height],
  ].map(([x, y]) => [x + slant * (floor - y), floor + (y - floor) * height]);
  const xs = corners.map((v) => v[0]);
  const ys = corners.map((v) => v[1]);
  const rect = clampRect({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
  const color = p.bool(5, false) ? p.rgb(6, [0, 0, 0]) : null;
  const out = layerPass(
    ctx,
    rect,
    [input],
    `uniform float u_slant;
uniform float u_height;
uniform float u_floor;
uniform vec4 u_color;
${SHEAR_SAMPLE}`,
    `  float y = u_floor + (p.y - u_floor) / u_height;
  vec4 c = shearSample(vec2(p.x - u_slant * (u_floor - y), y), vec2(1.0 + 2.0 * abs(u_slant / u_height), max(1.0, 1.0 / abs(u_height))));
  outColor = u_color.a > 0.0 ? vec4(u_color.rgb * c.a, c.a) : c;`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform1f(u("u_slant"), slant);
      gl.uniform1f(u("u_height"), height);
      gl.uniform1f(u("u_floor"), floor);
      gl.uniform4f(u("u_color"), color?.[0] ?? 0, color?.[1] ?? 0, color?.[2] ?? 0, color ? 1 : 0);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

// CC Tiler: the layer reduced to a tile of round(Scale x its size) pixels, each the layer's mean over the pixel's
// footprint, placed as the layer scaled about Center would be and repeated over the layer's box every tile size less
// one pixel: the tile is sampled bilinearly between its pixel centres, half a pixel in, so a repeat starts on its
// first pixel and ends just short of its last. Blend w. Original mixes the layer back in.
registerStock("CC Tiler", (input, p, ctx, layer) => {
  const box = layerRect(layer, input);
  const scale = Math.min(1, Math.max(0, p.num(1, 1)));
  const tw = Math.round(box.width * scale);
  const th = Math.round(box.height * scale);
  if (tw < 2 || th < 2) return nothing(input, ctx);
  const c = point(p, 2, layer, input, 0);
  const average = (source: LayerImage, rect: Rect, axis: 0 | 1, step: number, from: number) =>
    layerPass(
      ctx,
      rect,
      [source],
      `uniform vec2 u_axis;
uniform float u_step;
uniform float u_from;`,
      `  float a = u_from + floor(dot(p, u_axis)) * u_step;
  float b = a + u_step;
  vec4 sum = vec4(0.0);
  for (float i = floor(a); i < b; i += 1.0) {
    float w = min(b, i + 1.0) - max(a, i);
    sum += at(0, mix(p, vec2(i + 0.5), u_axis)) * w;
  }
  outColor = sum / u_step;`,
      (u) => {
        ctx.gl.uniform2f(u("u_axis"), 1 - axis, axis);
        ctx.gl.uniform1f(u("u_step"), step);
        ctx.gl.uniform1f(u("u_from"), from);
      },
    );
  const rows = average(input, { x: 0, y: box.y, width: tw, height: box.height }, 0, box.width / tw, box.x);
  const tile = average(rows, { x: 0, y: 0, width: tw, height: th }, 1, box.height / th, box.y);
  ctx.pool.release(rows.target);
  const blend = Math.min(1, Math.max(0, p.num(3, 0)));
  const out = layerPass(
    ctx,
    box,
    [tile, input],
    `uniform vec2 u_origin0;
uniform vec2 u_period;
uniform float u_blend;`,
    `  vec2 g = mod(p - u_origin0 - 0.5, u_period);
  vec2 j0 = floor(g);
  vec2 f = g - j0;
  vec2 j1 = j0 + 1.5;
  j0 += 0.5;
  vec4 t = mix(mix(at(0, j0), at(0, vec2(j1.x, j0.y)), f.x), mix(at(0, vec2(j0.x, j1.y)), at(0, j1), f.x), f.y);
  outColor = mix(t, at(1, p), u_blend);`,
    (u) => {
      ctx.gl.uniform2f(u("u_origin0"), c[0] * (1 - scale), c[1] * (1 - scale));
      ctx.gl.uniform2f(u("u_period"), tw - 1, th - 1);
      ctx.gl.uniform1f(u("u_blend"), blend);
    },
    input.scale,
  );
  ctx.pool.release(tile.target);
  ctx.pool.release(input.target);
  return out;
});

/** CC Split's pull towards the line at its middle, as a fraction of the distance from Point A to Point B. */
export const splitPull = (split: number) => 0.006 * Math.max(0, split);
/** How far from the line CC Split's pull reaches, as a fraction of the distance from Point A to Point B. */
export const SPLIT_REACH = 0.86;

// CC Split, CC Split 2: the layer torn open along the segment from Point A to Point B. A pixel at distance d from the
// line, a fraction t of the way along the segment, shows the layer d - m nearer the line, m = Split / 100 * 0.6 |AB|
// sin^2(pi t) (1 - d / (0.86 |AB|)); where m reaches past the line the tear is open, its edge fading over the two
// layer pixels past the line. CC Split 2 pulls the side to the right of A to B by Split 1 and the other by Split 2.
function registerSplit(matchName: string, two: boolean) {
  registerStock(matchName, (input, p, ctx, layer) => {
    const a = point(p, 1, layer, input);
    const b = point(p, 2, layer, input);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const right = splitPull(p.num(3, 0)) * length;
    const left = two ? splitPull(p.num(4, 0)) * length : right;
    if (length < 1e-3 || (right < 1e-3 && left < 1e-3)) return input;
    return warp(
      ctx,
      input,
      imageRect(input),
      `uniform vec2 u_a;
uniform vec2 u_axis;
uniform float u_length;
uniform vec2 u_pulls;
uniform float u_reach;
float pullAt(vec2 p, out float d) {
  vec2 n = vec2(-u_axis.y, u_axis.x);
  float t = dot(p - u_a, u_axis) / u_length;
  float v = dot(p - u_a, n);
  d = abs(v);
  if (t <= 0.0 || t >= 1.0 || d >= u_reach) return 0.0;
  float s = sin(3.14159265 * t);
  return (v >= 0.0 ? u_pulls.x : u_pulls.y) * s * s * (1.0 - d / u_reach);
}
float tearAlpha(vec2 p) {
  float d;
  float m = pullAt(p, d);
  return clamp(1.05 - (m - d) / 2.0, 0.0, 1.0);
}
vec2 map(vec2 p) {
  float d;
  float m = pullAt(p, d);
  if (m == 0.0) return p;
  if (tearAlpha(p) <= 0.0) return vec2(-1e9);
  vec2 n = vec2(-u_axis.y, u_axis.x);
  float v = dot(p - u_a, n);
  return p - n * (sign(v) * m);
}`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform2f(u("u_a"), a[0], a[1]);
        gl.uniform2f(u("u_axis"), (b[0] - a[0]) / length, (b[1] - a[1]) / length);
        gl.uniform1f(u("u_length"), length);
        gl.uniform2f(u("u_pulls"), right, left);
        gl.uniform1f(u("u_reach"), SPLIT_REACH * length);
      },
      "  outColor = c * tearAlpha(p);",
    );
  });
}
registerSplit("CC Split", false);
registerSplit("CC Split 2", true);

const BenderStyle = { BEND: 1, MARILYN: 2, SHARP: 3, BOXER: 4 } as const;

// CC Bender: the layer sheared across the line from Base to Top. At a fraction u of the way to Top it moves Amount /
// 200 of half the layer's diagonal (of the distance from Base to Top with Adjust To Distance) to the right of the
// line times the style's profile: Bend u^2 (on along its tangent past Top), Sharp a triangle peaking half way, Marilyn
// that triangle smoothstepped, Boxer smoothstep(u) (held past Top); below Base nothing moves.
registerStock("CC Bender", (input, p, ctx, layer) => {
  const top = point(p, 4, layer, input);
  const base = point(p, 5, layer, input);
  const length = Math.hypot(top[0] - base[0], top[1] - base[1]);
  const r = imageRect(input);
  const box = layerRect(layer, input);
  const amount = (p.num(1, 0) / 200) * (p.bool(3, false) ? length : Math.hypot(box.width, box.height) / 2);
  if (length < 1e-3 || Math.abs(amount) < 1e-3) return input;
  const style = p.choice(2, BenderStyle.BEND);
  const axis = [(top[0] - base[0]) / length, (top[1] - base[1]) / length];
  const reach = Math.max(
    1,
    ...[
      [r.x, r.y],
      [r.x + r.width, r.y],
      [r.x, r.y + r.height],
      [r.x + r.width, r.y + r.height],
    ].map(([x, y]) => ((x - base[0]) * axis[0] + (y - base[1]) * axis[1]) / length),
  );
  const grow = Math.abs(amount) * (style === BenderStyle.BEND ? 2 * reach - 1 : 1);
  const out = layerPass(
    ctx,
    clampRect(growRect(r, grow)),
    [input],
    `uniform vec2 u_base;
uniform vec2 u_axis;
uniform float u_length;
uniform float u_amount;
uniform int u_style;
float profile(float u) {
  if (u <= 0.0) return 0.0;
  if (u_style == 1) return u <= 1.0 ? u * u : 2.0 * u - 1.0;
  float sharp = max(0.0, 1.0 - abs(2.0 * u - 1.0));
  if (u_style == 2) return smoothstep(0.0, 1.0, sharp);
  if (u_style == 3) return sharp;
  return smoothstep(0.0, 1.0, u);
}
vec2 map(vec2 p) {
  vec2 n = vec2(-u_axis.y, u_axis.x);
  float u = dot(p - u_base, u_axis) / u_length;
  if (u <= 0.0) return p;
  return p - n * (u_amount * profile(u));
}
${SHEAR_SAMPLE}
${FOOTPRINT_SAMPLE}`,
    "  outColor = footprintSample(p, 1.0);",
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_base"), base[0], base[1]);
      gl.uniform2f(u("u_axis"), axis[0], axis[1]);
      gl.uniform1f(u("u_length"), length);
      gl.uniform1f(u("u_amount"), amount);
      gl.uniform1i(u("u_style"), style);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

const CROSS = "float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }";

/** GLSL `vec2 bilinearInverse(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d)`: (u, v) with p = mix(mix(a, b, u), mix(c, d, u), v). */
const BILINEAR_INVERSE = `vec2 bilinearInverse(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  vec2 e = b - a;
  vec2 f = c - a;
  vec2 g = a - b + d - c;
  vec2 h = p - a;
  float k2 = cross2(g, f);
  float k1 = cross2(e, f) + cross2(h, g);
  float k0 = cross2(h, e);
  float v;
  if (abs(k2) < 1e-6) {
    v = -k0 / k1;
  } else {
    float w = k1 * k1 - 4.0 * k0 * k2;
    if (w < 0.0) return vec2(-1.0);
    w = sqrt(w);
    v = (-k1 - w) / (2.0 * k2);
    if (v < 0.0 || v > 1.0) v = (-k1 + w) / (2.0 * k2);
  }
  vec2 s = e + g * v;
  float u = abs(s.x) > abs(s.y) ? (h.x - f.x * v) / s.x : (h.y - f.y * v) / s.y;
  return vec2(u, v);
}`;

const BEZIER_MAX_CELLS = 10;

/**
 * Bezier Warp's mesh: the bicubic patch whose boundary is the four cubic curves of `pts` (vertices and tangents
 * clockwise from the top left) and whose inner control points complete each corner's parallelogram, at the
 * (cells + 1)^2 nodes of a cells x cells grid, row by row.
 */
export function bezierMesh(pts: number[][], cells: number): number[][] {
  const [tl, t1, t2, tr, r1, r2, br, b1, b2, bl, l1, l2] = pts;
  const corner = (a: number[], b: number[], c: number[]) => [a[0] + b[0] - c[0], a[1] + b[1] - c[1]];
  const net = [
    [tl, t1, t2, tr],
    [l2, corner(t1, l2, tl), corner(t2, r1, tr), r1],
    [l1, corner(b2, l1, bl), corner(b1, r2, br), r2],
    [bl, b2, b1, br],
  ];
  const bern = (t: number) => [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3];
  const nodes: number[][] = [];
  for (let j = 0; j <= cells; j++) {
    const bv = bern(j / cells);
    for (let i = 0; i <= cells; i++) {
      const bu = bern(i / cells);
      const q = [0, 0];
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          q[0] += net[r][c][0] * bv[r] * bu[c];
          q[1] += net[r][c][1] * bv[r] * bu[c];
        }
      }
      nodes.push(q);
    }
  }
  return nodes;
}

// Bezier Warp: the layer's box drawn on `bezierMesh` with Quality cells a side, each cell bilinear; past the mesh's
// edge the nearest cell carries on, so the layer's own transparent border draws the edge.
registerStock("ADBE BEZMESH", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const box = layerRect(layer, input);
  const [x0, y0, w, h] = [box.x / k, box.y / k, box.width / k, box.height / k];
  const defaults = [
    [0, 0],
    [1 / 3, 0],
    [2 / 3, 0],
    [1, 0],
    [1, 1 / 3],
    [1, 2 / 3],
    [1, 1],
    [2 / 3, 1],
    [1 / 3, 1],
    [0, 1],
    [0, 2 / 3],
    [0, 1 / 3],
  ];
  const pts = defaults.map(([u, v], i) => {
    const q = p.vec(i + 1, [x0 + u * w, y0 + v * h]);
    return [q[0] * k, (q[1] ?? 0) * k];
  });
  const cells = Math.round(Math.min(10, Math.max(1, p.num(14, 8))));
  const nodes = bezierMesh(pts, cells);
  const xs = nodes.map((v) => v[0]);
  const ys = nodes.map((v) => v[1]);
  const out = clampRect(growRect({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }, 2));
  return warp(
    ctx,
    input,
    out,
    `uniform vec2 u_nodes[${(BEZIER_MAX_CELLS + 1) ** 2}];
uniform int u_cells;
uniform vec4 u_box;
${CROSS}
${BILINEAR_INVERSE}
vec2 map(vec2 p) {
  float best = 1e9;
  vec2 uv = vec2(-1e9);
  for (int j = 0; j < ${BEZIER_MAX_CELLS}; j++) {
    if (j >= u_cells) break;
    for (int i = 0; i < ${BEZIER_MAX_CELLS}; i++) {
      if (i >= u_cells) break;
      int n = j * (u_cells + 1) + i;
      vec2 a = u_nodes[n];
      vec2 b = u_nodes[n + 1];
      vec2 c = u_nodes[n + u_cells + 1];
      vec2 e = u_nodes[n + u_cells + 2];
      for (int t = 0; t < 2; t++) {
        mat2 m = t == 0 ? mat2(b - a, e - b) : mat2(e - c, c - a);
        if (abs(determinant(m)) < 1e-9) continue;
        vec2 w = inverse(m) * (p - a);
        vec2 ab = t == 0 ? vec2(w.x, w.y) : vec2(w.x, w.x + w.y);
        float d = max(0.0, max(max(-ab.x, -ab.y), max(ab.x - 1.0, ab.y - 1.0)));
        d = max(d, t == 0 ? ab.y - ab.x : ab.x - ab.y);
        if (d <= best) {
          best = d;
          uv = (vec2(float(i), float(j)) + ab) / float(u_cells);
        }
      }
    }
  }
  return best > 1.0 ? vec2(-1e9) : u_box.xy + uv * u_box.zw;
}`,
    (u) => {
      ctx.gl.uniform2fv(u("u_nodes[0]"), nodes.flat());
      ctx.gl.uniform1i(u("u_cells"), cells);
      ctx.gl.uniform4f(u("u_box"), box.x, box.y, box.width, box.height);
    },
  );
});

// CC Power Pin: the layer's box, grown by the Expansion percentages of its size, mapped projectively onto the four
// pins (bilinearly at Perspective 0); the output covers the pinned quad.
registerStock("CC Power Pin", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const box = layerRect(layer, input);
  const [x0, y0, x1, y1] = [box.x / k, box.y / k, (box.x + box.width) / k, (box.y + box.height) / k];
  const pins = [p.vec(2, [x0, y0]), p.vec(3, [x1, y0]), p.vec(4, [x0, y1]), p.vec(5, [x1, y1])].map((v) => [v[0] * k, (v[1] ?? 0) * k]);
  const inverse = cornerPinInverse(pins[0], pins[1], pins[2], pins[3]);
  const xs = pins.map((v) => v[0]);
  const ys = pins.map((v) => v[1]);
  const out = clampRect({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
  if (!inverse || out.width < 1 || out.height < 1) return nothing(input, ctx);
  const perspective = Math.min(1, Math.max(0, p.num(6, 1)));
  if (perspective > 0 && perspective < 1) ctx.warn("CC Power Pin: Perspective between 0 and 100% is drawn as full perspective");
  const [top, left, right, bottom] = [9, 10, 11, 12].map((i) => p.num(i, 0) / 100);
  const source = { x: box.x - left * box.width, y: box.y - top * box.height, width: box.width * (1 + left + right), height: box.height * (1 + top + bottom) };
  const result = layerPass(
    ctx,
    out,
    [input],
    `uniform mat3 u_inverse;
uniform vec4 u_rect;
uniform vec2 u_pins[4];
uniform int u_bilinear;
${CROSS}
${BILINEAR_INVERSE}
${SHEAR_SAMPLE}
${FOOTPRINT_SAMPLE}
vec3 pinned(vec2 p) {
  if (u_bilinear == 1) return vec3(bilinearInverse(p, u_pins[0], u_pins[1], u_pins[2], u_pins[3]), 1.0);
  vec3 h = u_inverse * vec3(p, 1.0);
  return vec3(h.xy / h.z, h.z);
}
vec2 map(vec2 p) {
  return u_rect.xy + pinned(p).xy * u_rect.zw;
}`,
    `  vec3 uv = pinned(p);
  if (uv.z <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { outColor = vec4(0.0); return; }
  outColor = footprintSample(p, 1.0);`,
    (u) => {
      const m = inverse;
      ctx.gl.uniformMatrix3fv(u("u_inverse"), false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
      ctx.gl.uniform4f(u("u_rect"), source.x, source.y, source.width, source.height);
      ctx.gl.uniform2fv(u("u_pins[0]"), pins.flat());
      ctx.gl.uniform1i(u("u_bilinear"), perspective === 0 ? 1 : 0);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return result;
});
