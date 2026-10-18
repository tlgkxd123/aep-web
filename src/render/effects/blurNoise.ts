// Blur & Sharpen and Noise & Grain effects beyond blurSharpen.ts.
import { acquireFloat, releaseFloat } from "../floatTargets.ts";
import type { LayerImage, RenderContext } from "../registry.ts";
import { boxBlur, effectBounds, type BoxBlurOptions } from "./boxBlur.ts";
import { FRACTAL_GLSL, FractalShape, noiseSpace, octaveTransform, setFractalUniforms } from "./fractal.ts";
import { copyImage } from "./fxextraUtil.ts";
import { blurrinessSigma } from "./stockMath.ts";
import { blurAxes, compOf, gaussian, imageRect, layerCenter, layerPass, layerRect, registerStock, unionRect, type Params } from "./stockUtil.ts";

/**
 * Channel Blur's blur of one Blurriness b, in box passes with a fractional outer tap: one of radius b/2 up to 1, two
 * of 0.37b up to 2, three of 0.37b from 2.5 and between 2 and 2.5 the two-pass and three-pass results mixed linearly.
 * `scale` is the downsample factor; the input is released.
 */
function channelBoxBlur(ctx: RenderContext, source: LayerImage, blurriness: number, scale: number, options: Omit<BoxBlurOptions, "radius" | "iterations">): LayerImage {
  const b = Math.max(0, blurriness);
  if (b <= 1) return boxBlur(ctx, source, { ...options, radius: (b / 2) * scale, iterations: 1 });
  const radius = 0.37 * b * scale;
  if (b <= 2 || b >= 2.5) return boxBlur(ctx, source, { ...options, radius, iterations: b <= 2 ? 2 : 3 });
  const two = boxBlur(ctx, source, { ...options, radius, iterations: 2 });
  const three = boxBlur(ctx, copyImage(ctx, two), { ...options, radius, iterations: 1 });
  const out = layerPass(ctx, unionRect(imageRect(two), imageRect(three)), [two, three], "uniform float u_t;", "  outColor = mix(at(0, p), at(1, p), u_t);",
    (u) => ctx.gl.uniform1f(u("u_t"), (b - 2) / 0.5), source.scale);
  ctx.pool.release(two.target);
  ctx.pool.release(three.target);
  return out;
}

// Channel Blur: alpha blurred first, then the input's straight colour (transparent pixels black) premultiplied by
// that blurred alpha and each colour channel blurred from there, each by its channel's Blurriness (channelBoxBlur).
// Pixels under 1.5/255 alpha count as transparent: in 8 bits their straight colour is only 0 or 1.
registerStock("ADBE Channel Blur", (input, p, ctx, layer) => {
  const amounts = [1, 2, 3, 4].map((i) => Math.max(0, p.num(i, 0)));
  if (amounts.every((a) => a <= 0)) return input;
  const k = input.scale ?? 1;
  const [h, v] = blurAxes(p.choice(6, 1));
  const repeat = p.bool(5, false);
  const bounds = repeat ? effectBounds(layer, input) : undefined;
  const blurred = (source: LayerImage, a: number) => channelBoxBlur(ctx, source, a, k, { horizontal: h, vertical: v, repeatEdges: repeat, bounds });
  const alpha = blurred(copyImage(ctx, input), amounts[3]);
  const colour = layerPass(
    ctx,
    imageRect(input),
    [input, alpha],
    "",
    "  vec4 c = at(0, p);\n  outColor = vec4(c.a < 1.5 / 255.0 ? vec3(0.0) : straight(c) * at(1, p).a, 1.0);",
    undefined,
    input.scale,
  );
  ctx.pool.release(input.target);
  const distinct = [...new Set(amounts.slice(0, 3))];
  const images = [...distinct.map((a) => blurred(copyImage(ctx, colour), a)), alpha];
  ctx.pool.release(colour.target);
  const pick = amounts.slice(0, 3).map((a) => distinct.indexOf(a));
  const out = layerPass(
    ctx,
    imageRect(alpha),
    images,
    "",
    `  vec4 s[${images.length}];
${images.map((_, i) => `  s[${i}] = at(${i}, p);`).join("\n")}
  float a = s[${images.length - 1}].a;
  outColor = vec4(clamp(vec3(s[${pick[0]}].r, s[${pick[1]}].g, s[${pick[2]}].b), 0.0, a), a);`,
    undefined,
    input.scale,
  );
  for (const image of images) ctx.pool.release(image.target);
  return out;
});

/** GLSL: a padded RGBA8 image's content texel (GL rows), transparent outside; straight colour with u_straight. */
const FETCH_GLSL = `
uniform sampler2D u_source;
uniform ivec2 u_size;
uniform int u_pad;
uniform int u_straight;
vec4 fetch(ivec2 c) {
  if (any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, u_size))) return vec4(0.0);
  vec4 v = texelFetch(u_source, c + u_pad, 0);
  if (u_straight == 1) v.rgb = v.a > 0.0 ? v.rgb / v.a : vec3(0.0);
  return floor(v * 255.0 + 0.5);
}`;

/**
 * One step of the median's search: per channel, the state (the median's bits found so far, 0..255) gains bit
 * u_bit where fewer than half of the window's values lie below state + u_bit.
 */
const MEDIAN_STEP_FS = `#version 300 es
precision highp float;
${FETCH_GLSL}
uniform sampler2D u_state;
uniform int u_radius;
uniform float u_bit;
uniform int u_first;
out vec4 outColor;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 state = u_first == 1 ? vec4(0.0) : texelFetch(u_state, t, 0);
  vec4 candidate = state + u_bit;
  vec4 below = vec4(0.0);
  vec4 n = vec4(0.0);
  for (int dy = -u_radius; dy <= u_radius; dy++) {
    for (int dx = -u_radius; dx <= u_radius; dx++) {
      below += vec4(lessThan(fetch(t + ivec2(dx, dy)), candidate));
      n += 1.0;
    }
  }
  outColor = state + u_bit * vec4(lessThanEqual(below, (n - 1.0) * 0.5));
}`;

/** The median (u_state) into a padded RGBA8 image; Dust & Scratches keeps pixels within u_threshold of it. */
const MEDIAN_STORE_FS = `#version 300 es
precision highp float;
${FETCH_GLSL}
uniform sampler2D u_state;
uniform int u_alpha;
uniform float u_threshold;
out vec4 outColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) - u_pad;
  if (any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, u_size))) { outColor = vec4(0.0); return; }
  vec4 x = fetch(c);
  vec4 m = texelFetch(u_state, c, 0);
  if (u_threshold >= 0.0) m = mix(x, m, vec4(greaterThan(abs(m - x), vec4(u_threshold))));
  if (u_alpha == 0) m.a = x.a;
  vec4 v = m / 255.0;
  if (u_straight == 1) v.rgb *= v.a;
  outColor = vec4(min(v.rgb, vec3(v.a)), v.a);
}`;

/**
 * Each channel's median over the (2r+1)² square about each pixel, by a binary search of its 8 bits; alpha's only
 * with `alpha`. With `threshold` (levels) a pixel keeps its value where it is within it of the median. Releases
 * `input`.
 */
function median(ctx: RenderContext, input: LayerImage, radius: number, alpha: boolean, threshold = -1): LayerImage {
  const gl = ctx.gl;
  const straight = 1;
  const common = (u: (name: string) => WebGLUniformLocation | null) => {
    gl.uniform1i(u("u_source"), 0);
    gl.uniform1i(u("u_state"), 1);
    gl.uniform2i(u("u_size"), input.width, input.height);
    gl.uniform1i(u("u_pad"), ctx.pad);
    gl.uniform1i(u("u_straight"), straight);
  };
  let state: ReturnType<typeof acquireFloat> | undefined;
  for (let bit = 128; bit >= 1; bit /= 2) {
    const next = acquireFloat(ctx, input.width, input.height);
    ctx.pass(ctx.program(MEDIAN_STEP_FS), next, [input.target, state ?? input.target], (u) => {
      common(u);
      gl.uniform1i(u("u_radius"), radius);
      gl.uniform1f(u("u_bit"), bit);
      gl.uniform1i(u("u_first"), state ? 0 : 1);
    });
    releaseFloat(ctx, state);
    state = next;
  }
  const out = ctx.pool.acquire(input.target.width, input.target.height, false);
  ctx.pass(ctx.program(MEDIAN_STORE_FS), out, [input.target, state!], (u) => {
    common(u);
    gl.uniform1i(u("u_alpha"), alpha ? 1 : 0);
    gl.uniform1f(u("u_threshold"), threshold);
  });
  releaseFloat(ctx, state);
  ctx.pool.release(input.target);
  return { ...input, target: out };
}

registerStock("ADBE Median", (input, p, ctx) => {
  const radius = Math.round(Math.max(0, p.num(1, 0)) * (input.scale ?? 1));
  return radius > 0 ? median(ctx, input, radius, p.bool(2, false)) : input;
});

registerStock("ADBE Dust & Scratches", (input, p, ctx) => {
  const radius = Math.round(Math.max(0, p.num(1, 1)) * (input.scale ?? 1));
  return radius > 0 ? median(ctx, input, radius, p.bool(3, false), Math.max(0, p.num(2, 0)) * 255) : input;
});

const CrossMode = { BLEND: 1, ADD: 2, SCREEN: 3, MULTIPLY: 4, LIGHTEN: 5, DARKEN: 6 } as const;

// CC Cross Blur: the layer blurred along x as Channel Blur blurs by Radius X and along y by Radius Y (premultiplied).
// Blend averages the two and Add sums them (alphas screened); the other Transfer Modes composite one over the other
// with that blend of their straight colours where both cover.
registerStock("CS CrossBlur", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const rx = Math.max(0, p.num(1, 0));
  const ry = Math.max(0, p.num(2, 0));
  if (rx <= 0 && ry <= 0) return input;
  const repeatEdges = p.bool(4, false);
  const bounds = repeatEdges ? layerRect(layer, input) : undefined;
  const box = (r: number, horizontal: boolean) =>
    channelBoxBlur(ctx, copyImage(ctx, input), r, k, {
      horizontal,
      vertical: !horizontal,
      repeatEdges,
      bounds: bounds && { origin: [bounds.x, bounds.y], width: bounds.width, height: bounds.height },
    });
  const images = [box(rx, true), box(ry, false)];
  ctx.pool.release(input.target);
  const rect = images.map(imageRect).reduce(unionRect);
  const out = layerPass(
    ctx,
    rect,
    images,
    "uniform int u_mode;",
    `  vec4 a = at(0, p);
  vec4 b = at(1, p);
  vec4 r;
  if (u_mode == ${CrossMode.BLEND}) r = 0.5 * (a + b);
  else if (u_mode == ${CrossMode.ADD}) r = vec4(a.rgb + b.rgb, a.a + b.a - a.a * b.a);
  else {
    vec3 sa = straight(a), sb = straight(b), m;
    if (u_mode == ${CrossMode.SCREEN}) m = sa + sb - sa * sb;
    else if (u_mode == ${CrossMode.MULTIPLY}) m = sa * sb;
    else if (u_mode == ${CrossMode.LIGHTEN}) m = max(sa, sb);
    else m = min(sa, sb);
    r = vec4((1.0 - b.a) * a.rgb + (1.0 - a.a) * b.rgb + a.a * b.a * m, a.a + b.a - a.a * b.a);
  }
  r = clamp(r, 0.0, 1.0);
  outColor = vec4(min(r.rgb, vec3(r.a)), r.a);`,
    (u) => ctx.gl.uniform1i(u("u_mode"), p.choice(3, CrossMode.BLEND)),
    input.scale,
  );
  for (const image of images) ctx.pool.release(image.target);
  return out;
});

/** The largest window radius (image pixels) the edge-preserving blurs sample in full. */
const MAX_WINDOW = 64;

/** sRGB (D65) to CIE L*a*b* and back. */
const LAB_GLSL = `vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 linearToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 labF(vec3 t) { return mix(t * 7.787 + 16.0 / 116.0, pow(max(t, 0.0), vec3(1.0 / 3.0)), step(0.008856, t)); }
vec3 labFInv(vec3 f) { return mix((f - 16.0 / 116.0) / 7.787, f * f * f, step(0.206893, f)); }
vec3 rgb2lab(vec3 c) {
  vec3 l = srgbToLinear(c);
  vec3 xyz = mat3(0.4124, 0.2126, 0.0193, 0.3576, 0.7152, 0.1192, 0.1805, 0.0722, 0.9505) * l / vec3(0.95047, 1.0, 1.08883);
  vec3 f = labF(xyz);
  return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
}
vec3 lab2rgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0;
  vec3 xyz = labFInv(vec3(fy + lab.y / 500.0, fy, fy - lab.z / 200.0)) * vec3(0.95047, 1.0, 1.08883);
  vec3 l = mat3(3.2406, -0.9689, 0.0557, -1.5372, 1.8758, -0.2040, -0.4986, 0.0415, 1.0570) * xyz;
  return linearToSrgb(l);
}`;

// Bilateral Blur: each pixel averages its neighbours within Radius in CIE Lab (transparent neighbours count as
// black; the pixel keeps its own alpha), weighted by a Gaussian of their distance and by one of their Lab
// difference from it relative to Threshold; without Colorize on L alone, giving grey.
registerStock("ADBE Bilateral", (input, p, ctx) => {
  const k = input.scale ?? 1;
  const radius = Math.max(0, p.num(1, 25)) * k;
  if (radius < 0.5) return input;
  const window = Math.min(MAX_WINDOW, Math.ceil(radius));
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform int u_window;
uniform float u_sigma;
uniform float u_threshold;
uniform int u_colorize;
${LAB_GLSL}
vec3 value(vec4 c) {
  vec3 lab = rgb2lab(c.rgb);
  return u_colorize == 1 ? lab : vec3(lab.x, 0.0, 0.0);
}`,
    `  vec4 centre = at(0, p);
  vec3 c = value(centre);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int dy = -u_window; dy <= u_window; dy++) {
    for (int dx = -u_window; dx <= u_window; dx++) {
      vec2 d = vec2(dx, dy);
      float ws = exp(-0.5 * dot(d, d) / (u_sigma * u_sigma));
      if (ws < 1e-4) continue;
      vec3 s = value(at(0, p + d));
      float diff = length(s - c) / max(u_threshold, 1e-3);
      float w = ws * exp(-0.5 * diff * diff);
      sum += s * w;
      wsum += w;
    }
  }
  vec3 rgb = clamp(lab2rgb(sum / max(wsum, 1e-6)), 0.0, centre.a);
  outColor = vec4(rgb, centre.a);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform1i(u("u_window"), window);
      gl.uniform1f(u("u_sigma"), radius / 2);
      gl.uniform1f(u("u_threshold"), Math.max(0, p.num(2, 3)));
      gl.uniform1i(u("u_colorize"), p.bool(3, true) ? 1 : 0);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

const SmartMode = { NORMAL: 1, EDGE_ONLY: 2, EDGE_OVERLAY: 3 } as const;

/**
 * What Smart Blur's Threshold is multiplied by at a Radius, as After Effects applies it to 4 px wide areas: wider
 * areas count as edges at somewhat smaller differences, which this does not model.
 */
const SMART_THRESHOLD_SCALE: [number, number][] = [[3, 1.02], [4, 0.975], [5, 0.925], [6, 0.875], [8, 0.825], [10, 0.765], [15, 0.575]];

function smartThresholdScale(radius: number): number {
  const t = SMART_THRESHOLD_SCALE;
  if (radius <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    const [r1, s1] = t[i];
    const [r0, s0] = t[i - 1];
    if (radius <= r1) return s0 + ((s1 - s0) * (radius - r0)) / (r1 - r0);
  }
  return t[t.length - 1][1];
}

// Smart Blur: each pixel averages the neighbours within Radius that differ from it by at most Threshold (levels of
// 255, every channel), a threshold that shrinks as Radius grows (SMART_THRESHOLD_SCALE). Edge Only draws white over
// black where the right or lower neighbour differs by more, Edge Overlay those edges over the layer; both leave the
// layer's last column and row as they are.
registerStock("ADBE Smart Blur", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const radius = Math.max(0, p.num(1, 3)) * k;
  const window = Math.min(MAX_WINDOW, Math.round(radius));
  if (window < 1) return input;
  const bounds = layerRect(layer, input);
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform int u_window;
uniform float u_radius;
uniform float u_threshold;
uniform int u_mode;
uniform vec2 u_end;`,
    `  vec4 c = at(0, p);
  if (u_mode != ${SmartMode.NORMAL}) {
    if (p.x + 1.0 > u_end.x || p.y + 1.0 > u_end.y) { outColor = c; return; }
    bool edge = false;
    for (int i = 0; i < 2; i++) {
      vec2 d = i == 0 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 diff = abs(at(0, p + d) - c) * 255.0;
      if (max(max(diff.r, diff.g), max(diff.b, diff.a)) > u_threshold) edge = true;
    }
    if (edge || u_mode == ${SmartMode.EDGE_ONLY}) { outColor = vec4(vec3(edge ? c.a : 0.0), c.a); return; }
  }
  vec4 sum = vec4(0.0);
  float n = 0.0;
  for (int dy = -u_window; dy <= u_window; dy++) {
    for (int dx = -u_window; dx <= u_window; dx++) {
      vec2 d = vec2(dx, dy);
      if (dot(d, d) > u_radius * u_radius + 0.5) continue;
      vec4 s = at(0, p + d);
      vec4 diff = abs(s - c) * 255.0;
      if (max(max(diff.r, diff.g), max(diff.b, diff.a)) <= u_threshold) { sum += s; n += 1.0; }
    }
  }
  outColor = n > 0.0 ? sum / n : c;`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform1i(u("u_window"), window);
      gl.uniform1f(u("u_radius"), radius);
      gl.uniform1f(u("u_threshold"), Math.max(0, p.num(2, 25)) * smartThresholdScale(radius / k));
      gl.uniform1i(u("u_mode"), p.choice(3, SmartMode.NORMAL));
      gl.uniform2f(u("u_end"), bounds.x + bounds.width, bounds.y + bounds.height);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

/** Blurriness levels Compound Blur blends between, from none to Maximum Blur. */
const COMPOUND_LEVELS = 6;

// Compound Blur: each pixel blurred as Gaussian Blur blurs, by Maximum Blur times the luminance of the Blur Layer's
// source there (inverted with Invert Blur), the map centred on the layer or stretched over it (the layer itself when
// none is chosen). Drawn between Gaussians at COMPOUND_LEVELS evenly spaced blurrinesses. Reads another layer, so
// it is drawn every frame.
registerStock(
  "ADBE Compound Blur",
  (input, p, ctx, layer, time) => {
    const k = input.scale ?? 1;
    const max = Math.max(0, p.num(2, 20));
    if (!max) return input;
    const index = Math.round(p.num(1, 0));
    const other = index > 0 ? compOf(ctx, layer)?.layers.find((l) => l.index === index && l !== layer) : undefined;
    const map: LayerImage | null = other ? ctx.layerImage(other, time, false) : copyImage(ctx, input);
    if (!map) return input;
    const rect = layerRect(layer, input);
    let scale = [1, 1];
    let offset = [0, 0];
    let mapRect = rect;
    if (other) {
      mapRect = layerRect(other, map);
      const mk = map.scale ?? 1;
      const stretch = p.bool(3, true);
      scale = stretch ? [mapRect.width / rect.width, mapRect.height / rect.height] : [mk / k, mk / k];
      offset = stretch
        ? [mapRect.x - rect.x * scale[0], mapRect.y - rect.y * scale[1]]
        : [mapRect.x + mapRect.width / 2 - (rect.x + rect.width / 2) * scale[0], mapRect.y + mapRect.height / 2 - (rect.y + rect.height / 2) * scale[1]];
    }
    const levels = Array.from({ length: COMPOUND_LEVELS }, (_, i) => (max * i) / (COMPOUND_LEVELS - 1));
    const images = levels.map((b, i) => (i === 0 ? copyImage(ctx, input) : gaussian(ctx, copyImage(ctx, input), blurrinessSigma(b) * k, blurrinessSigma(b) * k)));
    ctx.pool.release(input.target);
    const outRect = images.map(imageRect).reduce(unionRect);
    const out = layerPass(
      ctx,
      outRect,
      [...images, map],
      `uniform vec2 u_scale;
uniform vec2 u_offset;
uniform vec4 u_mapRect;
uniform int u_invert;`,
      `  vec2 q = clamp(p * u_scale + u_offset, u_mapRect.xy + 0.5, u_mapRect.xy + u_mapRect.zw - 0.5);
  vec4 m = at(${images.length}, q);
  float v = luma(straight(m)) * m.a;
  if (u_invert == 1) v = 1.0 - v;
  float f = clamp(v, 0.0, 1.0) * ${COMPOUND_LEVELS - 1}.0;
  int i = min(int(floor(f)), ${COMPOUND_LEVELS - 2});
  float t = f - float(i);
  vec4 a = vec4(0.0);
  vec4 b = vec4(0.0);
${images
  .slice(0, -1)
  .map((_, i) => `  if (i == ${i}) { a = at(${i}, p); b = at(${i + 1}, p); }`)
  .join("\n")}
  outColor = mix(a, b, t);`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform2f(u("u_scale"), scale[0], scale[1]);
        gl.uniform2f(u("u_offset"), offset[0], offset[1]);
        gl.uniform4f(u("u_mapRect"), mapRect.x, mapRect.y, mapRect.width, mapRect.height);
        gl.uniform1i(u("u_invert"), p.bool(4, false) ? 1 : 0);
      },
      input.scale,
    );
    for (const image of images) ctx.pool.release(image.target);
    ctx.pool.release(map.target);
    return out;
  },
  { scalable: true },
);

const VectorType = { NATURAL: 1, CONSTANT: 2, PERPENDICULAR: 3, DIRECTION_CENTER: 4, DIRECTION_FADING: 5 } as const;
const VectorProperty = { RED: 1, GREEN: 2, BLUE: 3, ALPHA: 4, LUMINANCE: 5, LIGHTNESS: 6, HUE: 7, SATURATION: 8 } as const;
/** The most samples CC Vector Blur takes along a pixel's vector. */
const VECTOR_TAPS = 64;

// CC Vector Blur: each pixel is smeared along a vector field from the Vector Map's (or the layer's own) Property,
// blurred by Map Softness: along its contours (Natural, as long as the slope is steep; Constant Length, Amount long),
// across them (Perpendicular), or with the property as an angle (Direction Center both ways, Direction Fading
// fading); Angle Offset turns the vectors. Reads another layer, so it is drawn every frame.
registerStock(
  "CC Vector Blur",
  (input, p, ctx, layer, time) => {
    const k = input.scale ?? 1;
    const amount = p.num(2, 0) * k;
    if (!amount) return input;
    const index = Math.round(p.num(5, 0));
    const other = index > 0 ? compOf(ctx, layer)?.layers.find((l) => l.index === index && l !== layer) : undefined;
    let map: LayerImage | null = other ? ctx.layerImage(other, time, false) : copyImage(ctx, input);
    if (!map) return input;
    const softness = Math.max(0, p.num(7, 15)) * (map.scale ?? 1);
    if (softness > 0) map = gaussian(ctx, map, blurrinessSigma(softness), blurrinessSigma(softness));
    const rect = layerRect(layer, input);
    const mapRect = other ? layerRect(other, map) : rect;
    const mk = (map.scale ?? 1) / k;
    const offset = [mapRect.x + mapRect.width / 2 - (rect.x + rect.width / 2) * mk, mapRect.y + mapRect.height / 2 - (rect.y + rect.height / 2) * mk];
    const out = layerPass(
      ctx,
      imageRect(input),
      [input, map],
      `vec4 at(int i, vec2 q);
uniform int u_type;
uniform int u_property;
uniform float u_amount;
uniform float u_angle;
uniform float u_ridge;
uniform float u_mapScale;
uniform vec2 u_mapOffset;
float prop(vec2 q) {
  vec4 m = at(1, q * u_mapScale + u_mapOffset);
  vec3 s = straight(m);
  vec3 hsl = rgb2hsl(s);
  if (u_property == ${VectorProperty.RED}) return s.r * m.a;
  if (u_property == ${VectorProperty.GREEN}) return s.g * m.a;
  if (u_property == ${VectorProperty.BLUE}) return s.b * m.a;
  if (u_property == ${VectorProperty.ALPHA}) return m.a;
  if (u_property == ${VectorProperty.LUMINANCE}) return luma(s) * m.a;
  if (u_property == ${VectorProperty.HUE}) return hsl.x;
  if (u_property == ${VectorProperty.SATURATION}) return hsl.y;
  return hsl.z * m.a;
}`,
      `  float v = prop(p);
  vec2 g = vec2(prop(p + vec2(1.0, 0.0)) - prop(p - vec2(1.0, 0.0)), prop(p + vec2(0.0, 1.0)) - prop(p - vec2(0.0, 1.0))) * 0.5;
  float slope = length(g);
  vec2 dir;
  float len = u_amount;
  if (u_type == ${VectorType.DIRECTION_CENTER} || u_type == ${VectorType.DIRECTION_FADING}) {
    float a = v * 6.2831853 + u_angle;
    dir = vec2(sin(a), -cos(a));
  } else {
    vec2 n = slope > 1e-6 ? g / slope : vec2(0.0);
    dir = u_type == ${VectorType.PERPENDICULAR} ? n : vec2(-n.y, n.x);
    float c = cos(u_angle), s = sin(u_angle);
    dir = vec2(c * dir.x - s * dir.y, s * dir.x + c * dir.y);
    if (u_type == ${VectorType.NATURAL}) len *= min(1.0, slope * 255.0 / max(u_ridge, 1.0));
  }
  int taps = int(min(${VECTOR_TAPS}.0, ceil(abs(len)) + 1.0));
  bool both = u_type == ${VectorType.DIRECTION_CENTER};
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${VECTOR_TAPS}; i++) {
    if (i >= taps) break;
    float f = taps == 1 ? 0.0 : float(i) / float(taps - 1);
    float t = both ? f - 0.5 : f;
    float w = u_type == ${VectorType.DIRECTION_FADING} ? 1.0 - f : 1.0;
    sum += at(0, p + dir * len * t) * w;
    wsum += w;
  }
  outColor = wsum > 0.0 ? sum / wsum : at(0, p);`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform1i(u("u_type"), p.choice(1, VectorType.NATURAL));
        gl.uniform1i(u("u_property"), p.choice(6, VectorProperty.LIGHTNESS));
        gl.uniform1f(u("u_amount"), amount);
        gl.uniform1f(u("u_angle"), (p.num(3, 0) * Math.PI) / 180);
        gl.uniform1f(u("u_ridge"), Math.max(0, p.num(4, 1)));
        gl.uniform1f(u("u_mapScale"), mk);
        gl.uniform2f(u("u_mapOffset"), offset[0], offset[1]);
      },
      input.scale,
    );
    ctx.pool.release(input.target);
    ctx.pool.release(map.target);
    return out;
  },
  { scalable: true },
);

/** Camera Lens Blur's Shape popup: Triangle (3 sides) to Decagon (10). */
const irisSides = (choice: number) => Math.min(10, Math.max(3, choice + 2));

// Camera Lens Blur: each pixel averages the layer over the iris, a regular polygon of Shape's sides with a corner
// pointing down and Blur Radius to its corners, rounded toward a circle by Roundness, turned by Rotation and then
// widened by Aspect Ratio along x. Samples weigh fully inside the iris and fade to nothing one pixel beyond it. With
// Use "Linear" Working Space it averages in linear light (gamma 2.2). Highlights brighter than Threshold are boosted
// by Gain; the blur map, Diffraction Fringe and Saturation are not drawn. Repeat Edge Pixels clamps the samples to
// the layer.
registerStock("ADBE Camera Lens Blur", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const radius = Math.max(0, p.num(1, 5)) * k;
  if (radius < 0.5) return input;
  if (Math.round(p.num(10, 0)) > 0) ctx.warn("Camera Lens Blur: the blur map is not drawn");
  const repeat = p.bool(21, false) ? layerRect(layer, input) : undefined;
  const aspect = Math.max(0.01, p.num(5, 1));
  const window = Math.min(MAX_WINDOW, Math.ceil(radius * Math.max(1, aspect)) + 1);
  const rect = repeat ?? { x: input.origin[0] - window, y: input.origin[1] - window, width: input.width + 2 * window, height: input.height + 2 * window };
  const out = layerPass(
    ctx,
    rect,
    [input],
    `uniform int u_window;
uniform float u_radius;
uniform float u_sides;
uniform float u_round;
uniform float u_aspect;
uniform float u_rotation;
uniform int u_linear;
uniform float u_gain;
uniform float u_threshold;
uniform int u_repeat;
uniform vec4 u_rect;
float inside(vec2 d) {
  float c = cos(u_rotation), s = sin(u_rotation);
  d = vec2(c * d.x + s * d.y, -s * d.x + c * d.y);
  d.x /= u_aspect;
  float r = length(d);
  if (r <= 1e-6) return 1.0;
  float sector = 6.2831853 / u_sides;
  float a = mod(atan(d.x, -d.y), sector) - 0.5 * sector;
  float polygon = u_radius * cos(0.5 * sector) / cos(a);
  return clamp(mix(polygon, u_radius, u_round) - r + 1.0, 0.0, 1.0);
}
vec4 lin(vec4 c) {
  if (u_linear == 0) return c;
  vec3 s = straight(c);
  return vec4(pow(s, vec3(2.2)) * c.a, c.a);
}`,
    `  vec4 sum = vec4(0.0);
  float n = 0.0;
  for (int dy = -u_window; dy <= u_window; dy++) {
    for (int dx = -u_window; dx <= u_window; dx++) {
      vec2 d = vec2(dx, dy);
      float w = inside(d);
      if (w <= 0.0) continue;
      vec2 q = p + d;
      if (u_repeat == 1) q = clamp(q, u_rect.xy + 0.5, u_rect.xy + u_rect.zw - 0.5);
      vec4 s = lin(at(0, q));
      if (u_gain > 0.0 && s.a > 0.0 && luma(s.rgb / s.a) > u_threshold) s.rgb *= 1.0 + u_gain;
      sum += w * s;
      n += w;
    }
  }
  vec4 r = n > 0.0 ? sum / n : vec4(0.0);
  if (u_linear == 1 && r.a > 0.0) r.rgb = pow(clamp(r.rgb / r.a, 0.0, 1.0), vec3(1.0 / 2.2)) * r.a;
  r = clamp(r, 0.0, 1.0);
  outColor = vec4(min(r.rgb, vec3(r.a)), r.a);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform1i(u("u_window"), window);
      gl.uniform1f(u("u_radius"), radius);
      gl.uniform1f(u("u_sides"), irisSides(p.choice(3, 4)));
      gl.uniform1f(u("u_round"), Math.min(1, Math.max(0, p.num(4, 0) / 100)));
      gl.uniform1f(u("u_aspect"), aspect);
      gl.uniform1f(u("u_rotation"), (p.num(6, 0) * Math.PI) / 180);
      gl.uniform1i(u("u_linear"), p.bool(22, false) ? 1 : 0);
      gl.uniform1f(u("u_gain"), Math.max(0, p.num(17, 0)) / 100);
      gl.uniform1f(u("u_threshold"), Math.min(1, Math.max(0, p.num(18, 1))));
      gl.uniform1i(u("u_repeat"), repeat ? 1 : 0);
      if (repeat) gl.uniform4f(u("u_rect"), repeat.x, repeat.y, repeat.width, repeat.height);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

/** The most samples the radial blurs take per pixel. */
const RADIAL_TAPS = 256;

const RadialPath = { ZOOM: 0, SPIN: 1 } as const;
const RadialReduce = { MEAN: 0, MAX: 1, MIN: 2 } as const;

interface RadialOptions {
  center: number[];
  path: number;
  /** The path's parameter runs over [from, to]: the zoom factor's change, or the turn in radians. */
  from: number;
  to: number;
  taps: number;
  /** Weight of the far end of the path relative to its start (1 = even weights). */
  fade: number;
  reduce: number;
}

/** Each pixel's samples along the ray from (zoom) or arc about (spin) the centre; releases `input`. */
function radialPass(ctx: RenderContext, input: LayerImage, o: RadialOptions): LayerImage {
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform vec2 u_center;
uniform int u_path;
uniform vec2 u_range;
uniform int u_taps;
uniform float u_fade;
uniform int u_reduce;`,
    `  vec2 v = p - u_center;
  vec4 acc = u_reduce == ${RadialReduce.MIN} ? vec4(1.0) : vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${RADIAL_TAPS}; i++) {
    if (i >= u_taps) break;
    float f = u_taps == 1 ? 0.0 : float(i) / float(u_taps - 1);
    float t = mix(u_range.x, u_range.y, f);
    vec2 q = u_path == ${RadialPath.ZOOM} ? u_center + v * (1.0 + t) : u_center + vec2(cos(t) * v.x - sin(t) * v.y, sin(t) * v.x + cos(t) * v.y);
    vec4 s = at(0, q);
    float w = mix(1.0, u_fade, f);
    if (u_reduce == ${RadialReduce.MAX}) acc = max(acc, s);
    else if (u_reduce == ${RadialReduce.MIN}) acc = min(acc, s);
    else acc += s * w;
    wsum += w;
  }
  outColor = u_reduce == ${RadialReduce.MEAN} ? acc / wsum : acc;`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_center"), o.center[0], o.center[1] ?? 0);
      gl.uniform1i(u("u_path"), o.path);
      gl.uniform2f(u("u_range"), o.from, o.to);
      gl.uniform1i(u("u_taps"), Math.max(1, Math.min(RADIAL_TAPS, Math.round(o.taps))));
      gl.uniform1f(u("u_fade"), o.fade);
      gl.uniform1i(u("u_reduce"), o.reduce);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
}

/** The farthest corner of an image from a point (image pixels). */
function reach(input: LayerImage, center: number[]): number {
  const r = imageRect(input);
  return Math.max(
    ...[
      [r.x, r.y],
      [r.x + r.width, r.y],
      [r.x, r.y + r.height],
      [r.x + r.width, r.y + r.height],
    ].map(([x, y]) => Math.hypot(x - center[0], y - (center[1] ?? 0))),
  );
}

const FastZoom = { STANDARD: 1, BRIGHTEST: 2, DARKEST: 3 } as const;

// CC Radial Fast Blur: each pixel averages (or with Brightest / Darkest takes the largest / smallest value of) the
// layer along its ray toward Center, over Amount % of its distance.
registerStock("CC Radial Fast Blur", (input, p, ctx, layer) => {
  const amount = Math.min(100, Math.max(0, p.num(2, 50))) / 100;
  if (!amount) return input;
  const k = input.scale ?? 1;
  const center = p.vec(1, layerCenter(layer, input)).map((v) => v * k);
  const zoom = p.choice(3, FastZoom.STANDARD);
  return radialPass(ctx, input, {
    center,
    path: RadialPath.ZOOM,
    from: 0,
    to: -amount,
    taps: Math.ceil(amount * reach(input, center)) + 1,
    fade: 1,
    reduce: zoom === FastZoom.BRIGHTEST ? RadialReduce.MAX : zoom === FastZoom.DARKEST ? RadialReduce.MIN : RadialReduce.MEAN,
  });
});

const RadialType = { STRAIGHT_ZOOM: 1, FADING_ZOOM: 2, CENTERED_ZOOM: 3, ROTATE: 4, SCRATCH: 5, ROTATE_FADING: 6 } as const;

// CC Radial Blur: Straight Zoom averages along the ray toward Center over Amount % of the distance (away from it
// when negative), Fading Zoom weighs the far samples less, Centered Zoom spreads both ways; Rotate turns through
// Amount degrees about Center, Rotate Fading fading, Scratch as Rotate. Quality sets the samples.
registerStock("CC Radial Blur", (input, p, ctx, layer) => {
  const amount = p.num(2, 0);
  if (!amount) return input;
  const k = input.scale ?? 1;
  const center = p.vec(4, layerCenter(layer, input)).map((v) => v * k);
  const type = p.choice(1, RadialType.SCRATCH);
  const quality = Math.min(100, Math.max(10, p.num(3, 50))) / 100;
  const spin = type === RadialType.ROTATE || type === RadialType.SCRATCH || type === RadialType.ROTATE_FADING;
  const span = spin ? (amount * Math.PI) / 180 : -amount / 100;
  const centered = type === RadialType.CENTERED_ZOOM;
  const fading = type === RadialType.FADING_ZOOM || type === RadialType.ROTATE_FADING;
  return radialPass(ctx, input, {
    center,
    path: spin ? RadialPath.SPIN : RadialPath.ZOOM,
    from: centered ? -span / 2 : 0,
    to: centered ? span / 2 : span,
    taps: Math.max(2, Math.ceil(Math.abs(span) * reach(input, center) * quality) + 1),
    fade: fading ? 0 : 1,
    reduce: RadialReduce.MEAN,
  });
});

// --- Noise & Grain. After Effects draws these from its own random generators; ours are seeded look-alikes with
// the documented controls, drawn on an integer hash so every GPU draws the same noise.

/** GLSL: `float rand(vec2 cell, float seed, uint stream)`, uniform in [0, 1). */
const RAND_GLSL = `
uint hash3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.y ^ v.z;
}
float rand(vec2 cell, float seed, uint stream) {
  ivec2 c = ivec2(floor(cell));
  return float(hash3(uvec3(uvec2(c), uint(int(seed)) * 747796405u + stream)) >> 8u) * (1.0 / 16777216.0);
}
// Noise between whole seeds, eased from one to the next.
float rand(vec2 cell, float seed, uint stream, int smoothly) {
  if (smoothly == 0) return rand(cell, seed, stream);
  float f = fract(seed);
  return mix(rand(cell, floor(seed), stream), rand(cell, floor(seed) + 1.0, stream), f * f * (3.0 - 2.0 * f));
}`;

const NoiseAlphaType = { UNIFORM: 1, SQUARED: 2, UNIFORM_ANIMATION: 3, SQUARED_ANIMATION: 4 } as const;
const OriginalAlpha = { ADD: 1, CLAMP: 2, SCALE: 3, EDGES: 4 } as const;
const AlphaOverflow = { CLIP: 1, WRAP_BACK: 2, WRAP: 3 } as const;

// Noise Alpha: noise of up to Amount in alpha, added to the layer's (Add), only within it (Clamp), scaling it
// (Scale) or on its partly transparent edges (Edges); past the range it clips, folds back or wraps. The random
// types draw new noise each frame, the animated ones move through it with Random Phase (degrees).
registerStock(
  "ADBE Noise Alpha2",
  (input, p, ctx, layer, time) => {
    const amount = Math.max(0, p.num(2, 0)) / 100;
    if (!amount) return input;
    const type = p.choice(1, NoiseAlphaType.UNIFORM);
    const animated = type === NoiseAlphaType.UNIFORM_ANIMATION || type === NoiseAlphaType.SQUARED_ANIMATION;
    const cycle = p.bool(7, false) ? Math.max(1, Math.round(p.num(8, 1))) : 0;
    let phase = p.num(5, 0) / 360;
    if (cycle) phase = ((phase % cycle) + cycle) % cycle;
    const seed = animated ? phase * 8 : Math.round(time * (compOf(ctx, layer)?.frameRate ?? 24)) + phase * 8;
    const out = layerPass(
      ctx,
      imageRect(input),
      [input],
      `${RAND_GLSL}
uniform float u_amount;
uniform float u_seed;
uniform float u_scale;
uniform int u_squared;
uniform int u_smooth;
uniform int u_original;
uniform int u_overflow;`,
      `  vec4 c = at(0, p);
  float n = rand(p / u_scale, u_seed, 1u, u_smooth);
  if (u_squared == 1) n *= n;
  float a = c.a;
  float d = n * u_amount;
  if (u_original == ${OriginalAlpha.CLAMP}) a = a > 0.0 ? a + d - 0.5 * u_amount : 0.0;
  else if (u_original == ${OriginalAlpha.SCALE}) a = a * (1.0 + (n - 0.5) * 2.0 * u_amount);
  else if (u_original == ${OriginalAlpha.EDGES}) a = a + (n - 0.5) * u_amount * 4.0 * a * (1.0 - a);
  else a = a + d;
  if (u_overflow == ${AlphaOverflow.WRAP_BACK}) a = 1.0 - abs(1.0 - mod(a, 2.0));
  else if (u_overflow == ${AlphaOverflow.WRAP}) a = a > 1.0 ? fract(a) : a;
  a = clamp(a, 0.0, 1.0);
  outColor = vec4(straight(c) * a, a);`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform1f(u("u_amount"), amount);
        gl.uniform1f(u("u_seed"), seed);
        gl.uniform1f(u("u_scale"), input.scale ?? 1);
        gl.uniform1i(u("u_squared"), type === NoiseAlphaType.SQUARED || type === NoiseAlphaType.SQUARED_ANIMATION ? 1 : 0);
        gl.uniform1i(u("u_smooth"), animated ? 1 : 0);
        gl.uniform1i(u("u_original"), p.choice(3, OriginalAlpha.CLAMP));
        gl.uniform1i(u("u_overflow"), p.choice(4, AlphaOverflow.WRAP_BACK));
      },
      input.scale,
    );
    ctx.pool.release(input.target);
    return out;
  },
  { scalable: true },
);

const NoiseHlsType = { UNIFORM: 1, SQUARED: 2, GRAIN: 3 } as const;

/** Noise HLS and Noise HLS Auto: Hue, Lightness and Saturation each moved by noise of up to their amount. */
function noiseHls(input: LayerImage, ctx: RenderContext, p: Params, seed: number): LayerImage {
  const amounts = [p.num(2, 0), p.num(3, 0), p.num(4, 0)].map((v) => Math.max(0, v) / 100);
  if (amounts.every((v) => !v)) return input;
  const type = p.choice(1, NoiseHlsType.UNIFORM);
  const k = input.scale ?? 1;
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `${RAND_GLSL}
uniform vec3 u_amounts;
uniform float u_seed;
uniform float u_cell;
uniform int u_type;`,
    `  vec4 c = at(0, p);
  if (c.a <= 0.0) { outColor = c; return; }
  vec2 cell = p / u_cell;
  vec3 n = vec3(rand(cell, u_seed, 1u, 1), rand(cell, u_seed, 2u, 1), rand(cell, u_seed, 3u, 1)) * 2.0 - 1.0;
  if (u_type == ${NoiseHlsType.SQUARED}) n = sign(n) * n * n;
  vec3 hsl = rgb2hsl(straight(c));
  hsl.x = fract(hsl.x + 0.5 * n.x * u_amounts.x);
  hsl.z = clamp(hsl.z + 0.5 * n.y * u_amounts.y, 0.0, 1.0);
  hsl.y = clamp(hsl.y + 0.5 * n.z * u_amounts.z, 0.0, 1.0);
  outColor = vec4(clamp(hsl2rgb(hsl), 0.0, 1.0) * c.a, c.a);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform3f(u("u_amounts"), amounts[0], amounts[1], amounts[2]);
      gl.uniform1f(u("u_seed"), seed);
      gl.uniform1f(u("u_cell"), type === NoiseHlsType.GRAIN ? Math.max(1, p.num(5, 1)) * k : k);
      gl.uniform1i(u("u_type"), type);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
}

// Noise HLS: Noise Phase (degrees) moves through the noise; Noise HLS Auto moves through it at Noise Animation
// Speed (phases a second).
registerStock("ADBE Noise HLS2", (input, p, ctx) => noiseHls(input, ctx, p, p.num(6, 0) / 360 * 8));
registerStock("ADBE Noise HLS Auto2", (input, p, ctx, _layer, time) => noiseHls(input, ctx, p, time * Math.max(0, p.num(6, 24))), { scalable: true });

/** Turbulent Noise's Blending Mode choices (its menu without separators), as Fractal Noise's. */
const TurbulentBlend = { NONE: 1, NORMAL: 2, ADD: 3, MULTIPLY: 4, SCREEN: 5, OVERLAY: 6, DARKEN: 11, LIGHTEN: 12, DIFFERENCE: 13 } as const;
const TurbulentOverflow = { CLIP: 1, SOFT_CLAMP: 2, WRAP_BACK: 3 } as const;
/** The shape fractal.ts draws for each Fractal Type choice: the first four exactly, the others by the closest. */
const TURBULENT_SHAPES = [1, 2, 3, 4, 1, 1, 1, 3, 1, 1, 4, 1, 1, 1, 2, 4, 4];

// Turbulent Noise: Fractal Noise's controls over fractal.ts's noise. Turbulence Factor sharpens the turbulent types;
// Perspective Offset is not drawn.
registerStock("ADBE AIF Perlin Noise 3D", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const typeChoice = p.choice(1, 1);
  const uniform = p.bool(9, true);
  const scale: [number, number] = uniform ? [p.num(10, 100) / 100, p.num(10, 100) / 100] : [p.num(11, 100) / 100, p.num(12, 100) / 100];
  const toNoise = noiseSpace(p.vec(13, layerCenter(layer, input)), scale, p.num(8, 0), k);
  const blend = p.choice(26, TurbulentBlend.NORMAL);
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `${FRACTAL_GLSL}
uniform mat3 u_toNoise;
uniform int u_invert;
uniform float u_contrast;
uniform float u_brightness;
uniform float u_factor;
uniform int u_overflow;
uniform int u_blend;
uniform float u_opacity;
vec3 blended(vec3 s, vec3 n) {
  if (u_blend == ${TurbulentBlend.ADD}) return s + n;
  if (u_blend == ${TurbulentBlend.MULTIPLY}) return s * n;
  if (u_blend == ${TurbulentBlend.SCREEN}) return 1.0 - (1.0 - s) * (1.0 - n);
  if (u_blend == ${TurbulentBlend.OVERLAY}) return mix(2.0 * s * n, 1.0 - 2.0 * (1.0 - s) * (1.0 - n), step(0.5, s));
  if (u_blend == ${TurbulentBlend.DARKEN}) return min(s, n);
  if (u_blend == ${TurbulentBlend.LIGHTEN}) return max(s, n);
  if (u_blend == ${TurbulentBlend.DIFFERENCE}) return abs(s - n);
  return n;
}`,
    `  vec4 c = at(0, p);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  float v = fractal((u_toNoise * vec3(p, 1.0)).xy, 0u);
  if (u_shape != ${FractalShape.BASIC}) v = pow(clamp(v, 0.0, 1.0), u_factor / 1.5);
  if (u_invert == 1) v = 1.0 - v;
  v = (v - 0.5) * u_contrast + 0.5 + u_brightness;
  if (u_overflow == ${TurbulentOverflow.SOFT_CLAMP}) v = v > 0.75 ? 0.75 + 0.25 * tanh((v - 0.75) * 4.0) : v < 0.25 ? 0.25 + 0.25 * tanh((v - 0.25) * 4.0) : v;
  else if (u_overflow == ${TurbulentOverflow.WRAP_BACK}) v = 1.0 - abs(1.0 - mod(v, 2.0));
  vec3 n = vec3(clamp(v, 0.0, 1.0));
  if (u_blend == ${TurbulentBlend.NONE}) { outColor = vec4(n, 1.0) * (c.a * u_opacity); return; }
  vec3 s = straight(c);
  outColor = vec4(mix(s, clamp(blended(s, n), 0.0, 1.0), u_opacity) * c.a, c.a);`,
    (u) => {
      const gl = ctx.gl;
      const m = toNoise;
      gl.uniformMatrix3fv(u("u_toNoise"), false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
      gl.uniform1i(u("u_invert"), p.bool(3, false) ? 1 : 0);
      gl.uniform1f(u("u_contrast"), p.num(4, 100) / 100);
      gl.uniform1f(u("u_brightness"), p.num(5, 0) / 100);
      gl.uniform1f(u("u_factor"), Math.min(4, Math.max(1, p.num(22, 1.5))));
      gl.uniform1i(u("u_overflow"), p.choice(6, 4));
      gl.uniform1i(u("u_blend"), blend);
      gl.uniform1f(u("u_opacity"), Math.min(1, Math.max(0, p.num(25, 100) / 100)));
      setFractalUniforms(gl, u, {
        noiseType: p.choice(2, 3),
        shape: TURBULENT_SHAPES[typeChoice - 1] ?? FractalShape.BASIC,
        complexity: p.num(15, 6),
        persistence: p.num(17, 70) / 100,
        sub: octaveTransform(p.num(18, 56), 0),
        evolution: p.num(20, 0),
        cycle: false,
        revolutions: 1,
        seed: p.num(23, 0),
      });
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

const GrainView = { PREVIEW: 1, BLENDING_MATTE: 2, FINAL: 3 } as const;
const GrainBlend = { FILM: 1, MULTIPLY: 2, ADD: 3, SCREEN: 4, OVERLAY: 5 } as const;

// Add Grain: grain of Size pixels (per channel), smoothed by Softness, of Intensity times each channel's, laid over
// the layer by Blend Mode; Monochromatic grain is grey, else Saturation sets its colour, tinted by Tint Amount
// toward Tint Color. Preview shows it within the preview box only; the film presets, the tonal response, colour
// matching and the mask layer are not drawn. New grain each frame at Animation Speed 1.
registerStock(
  "VISINF Grain Implant",
  (input, p, ctx, layer, time) => {
    const k = input.scale ?? 1;
    const view = p.choice(21, GrainView.PREVIEW);
    const fps = compOf(ctx, layer)?.frameRate ?? 24;
    const speed = Math.max(0, p.num(39, 1));
    const step = Math.floor(time * fps * speed);
    const center = p.vec(22, layerCenter(layer, input));
    const out = layerPass(
      ctx,
      imageRect(input),
      [input],
      `${RAND_GLSL}
uniform float u_intensity;
uniform vec3 u_channels;
uniform vec3 u_sizes;
uniform float u_size;
uniform float u_aspect;
uniform int u_mono;
uniform float u_saturation;
uniform float u_tint;
uniform vec3 u_tintColor;
uniform int u_blend;
uniform float u_seed;
uniform int u_view;
uniform vec4 u_box;
float grain(vec2 q, float size, uint stream) {
  vec2 cell = q / max(vec2(size * u_aspect, size), vec2(0.25));
  vec2 f = fract(cell);
  f = f * f * (3.0 - 2.0 * f);
  vec2 i = floor(cell);
  float a = mix(rand(i, u_seed, stream), rand(i + vec2(1.0, 0.0), u_seed, stream), f.x);
  float b = mix(rand(i + vec2(0.0, 1.0), u_seed, stream), rand(i + vec2(1.0, 1.0), u_seed, stream), f.x);
  return mix(a, b, f.y) - 0.5;
}`,
      `  vec4 c = at(0, p);
  if (c.a <= 0.0) { outColor = c; return; }
  if (u_view == ${GrainView.PREVIEW} && (p.x < u_box.x || p.y < u_box.y || p.x >= u_box.z || p.y >= u_box.w)) { outColor = c; return; }
  vec3 g = u_mono == 1 ? vec3(grain(p, u_size * u_sizes.g, 1u)) : vec3(grain(p, u_size * u_sizes.r, 1u), grain(p, u_size * u_sizes.g, 2u), grain(p, u_size * u_sizes.b, 3u));
  float grey = dot(g, vec3(1.0 / 3.0));
  g = mix(vec3(grey), g, u_saturation);
  g = mix(g, g * u_tintColor, u_tint);
  g *= u_intensity * u_channels;
  vec3 s = straight(c);
  vec3 r;
  if (u_blend == ${GrainBlend.MULTIPLY}) r = s * (1.0 + 2.0 * g);
  else if (u_blend == ${GrainBlend.ADD}) r = s + max(g, 0.0);
  else if (u_blend == ${GrainBlend.SCREEN}) r = 1.0 - (1.0 - s) * (1.0 - max(g, 0.0));
  else if (u_blend == ${GrainBlend.OVERLAY}) r = s + g * 2.0 * min(s, 1.0 - s);
  else r = s + g * (1.0 - abs(2.0 * s - 1.0) * 0.5);
  if (u_view == ${GrainView.BLENDING_MATTE}) r = vec3(1.0);
  outColor = vec4(clamp(r, 0.0, 1.0) * c.a, c.a);`,
      (u) => {
        const gl = ctx.gl;
        const [w, h] = [p.num(23, 200) * k, p.num(24, 200) * k];
        gl.uniform1f(u("u_intensity"), Math.max(0, p.num(8, 1)) * 0.25);
        gl.uniform3f(u("u_channels"), p.num(2, 1), p.num(3, 1), p.num(4, 1));
        gl.uniform3f(u("u_sizes"), p.num(32, 1), p.num(33, 1), p.num(34, 1));
        gl.uniform1f(u("u_size"), Math.max(0, p.num(7, 1)) * k);
        gl.uniform1f(u("u_aspect"), Math.max(0.05, p.num(30, 1)));
        gl.uniform1i(u("u_mono"), p.bool(5, false) ? 1 : 0);
        gl.uniform1f(u("u_saturation"), Math.max(0, p.num(6, 1)));
        gl.uniform1f(u("u_tint"), Math.min(1, Math.max(0, p.num(11, 100) / 100)));
        gl.uniform3fv(u("u_tintColor"), p.rgb(10, [1, 1, 1]));
        gl.uniform1i(u("u_blend"), p.choice(14, GrainBlend.FILM));
        gl.uniform1f(u("u_seed"), p.num(13, 0) * 9973 + step);
        gl.uniform1i(u("u_view"), view);
        gl.uniform4f(u("u_box"), center[0] * k - w / 2, (center[1] ?? 0) * k - h / 2, center[0] * k + w / 2, (center[1] ?? 0) * k + h / 2);
      },
      input.scale,
    );
    ctx.pool.release(input.target);
    return out;
  },
  { scalable: true },
);
