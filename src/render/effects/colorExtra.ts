// Color Correction effects beyond colorCorrection.ts, on straight colour per pixel unless said
// otherwise: their formulas are colorExtraMath.ts's, measured against After Effects renders
// (refs/fixtures/color2.*).
import type { LayerImage, RenderContext } from "../registry.ts";
import {
  CHANGE_TO_COLOR_CHANNELS,
  CHROMA_SCALE,
  BALANCE_TOE_SLOPE,
  colorBalanceSliders,
  COLORAMA_MODIFY,
  COLORAMA_PHASE_SCALE,
  coloramaCycle,
  CURVES_TABLE,
  curvesTables,
  instanceData,
  KEY_LUMA,
  KEY_SOFTNESS,
  neutralizerOffsets,
  PHOTO_FILTER_LUMA,
  photoFilterMatrix,
  proLevelsChannels,
  RGB_KEY_SCALE,
  rgbToHsl,
  SELECTIVE_GROUPS,
  tonerStops,
} from "./colorExtraMath.ts";
import { mapPass, PASS_HEADER, type Uniforms } from "./fxextraUtil.ts";
import { COLOR_LIB, registerStock, type Params } from "./stockUtil.ts";

/** The match names this module renders. */
export const COLOR2_EFFECTS: string[] = [];

/**
 * A per-pixel pass on straight RGBA: `glsl` declares its uniforms and `vec4 adjust(vec4 s)`. The result is clamped
 * and premultiplied. Releases `input`.
 */
function straightPass(ctx: RenderContext, input: LayerImage, glsl: string, setUniforms?: Uniforms): LayerImage {
  const fragment = `${PASS_HEADER}${COLOR_LIB}${glsl}
void main() {
  vec4 c = texture(u_source, v_uv);
  vec4 r = clamp(adjust(vec4(straight(c), c.a)), 0.0, 1.0);
  outColor = vec4(r.rgb * r.a, r.a);
}`;
  return mapPass(ctx, input, fragment, setUniforms);
}

type Setter = (p: Params, gl: WebGL2RenderingContext, u: (name: string) => WebGLUniformLocation | null) => void;

function register(matchName: string, render: Parameters<typeof registerStock>[1]): void {
  COLOR2_EFFECTS.push(matchName);
  registerStock(matchName, render);
}

function registerStraight(matchName: string, glsl: string, uniforms: Setter): void {
  register(matchName, (input, p, ctx) => straightPass(ctx, input, glsl, (u) => uniforms(p, ctx.gl, u)));
}

const LEVELS_GLSL = `
float level(float v, float c[5]) {
  float span = c[1] - c[0];
  float t = span == 0.0 ? step(c[1], v) : (v - c[0]) / span;
  t = pow(clamp(t, 0.0, 1.0), 1.0 / max(c[2], 1e-3));
  return clamp(c[3] + t * (c[4] - c[3]), 0.0, 1.0);
}`;

registerStraight(
  "ADBE Pro Levels2",
  `${LEVELS_GLSL}
uniform float u_rgb[5];
uniform float u_r[5];
uniform float u_g[5];
uniform float u_b[5];
uniform float u_a[5];
vec4 adjust(vec4 s) {
  return vec4(level(level(s.r, u_r), u_rgb), level(level(s.g, u_g), u_rgb), level(level(s.b, u_b), u_rgb), level(s.a, u_a));
}`,
  (p, gl, u) => {
    const [rgb, r, g, b, a] = proLevelsChannels(p);
    gl.uniform1fv(u("u_rgb"), rgb);
    gl.uniform1fv(u("u_r"), r);
    gl.uniform1fv(u("u_g"), g);
    gl.uniform1fv(u("u_b"), b);
    gl.uniform1fv(u("u_a"), a);
  },
);

// Curves renders from the tables its arbitrary data holds, four entries packed in a uint.
register("ADBE CurvesCustom", (input, _p, ctx, _layer, _time, effect) => {
  const tables = curvesTables(instanceData(effect, 1));
  const packed = new Uint32Array(tables.buffer, tables.byteOffset, tables.length / 4);
  const T = CURVES_TABLE;
  return straightPass(
    ctx,
    input,
    `uniform uvec4 u_lut[${packed.length / 4}];
float lut(int t, float v) {
  int k = t * 256 + int(floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5));
  uint word = u_lut[k >> 4][(k >> 2) & 3];
  return float((word >> uint((k & 3) * 8)) & 255u) / 255.0;
}
vec4 adjust(vec4 s) {
  return vec4(lut(${T.rgb}, lut(${T.red}, s.r)), lut(${T.rgb}, lut(${T.green}, s.g)), lut(${T.rgb}, lut(${T.blue}, s.b)), lut(${T.alpha}, s.a));
}`,
    (u) => ctx.gl.uniform4uiv(u("u_lut"), packed),
  );
});

registerStraight(
  "CC Toner",
  `uniform vec3 u_stops[5];
uniform int u_count;
uniform float u_blend;
vec4 adjust(vec4 s) {
  vec3 t = u_stops[0];
  if (u_count > 1) {
    float x = clamp(luma(s.rgb), 0.0, 1.0) * float(u_count - 1);
    int k = min(u_count - 2, int(floor(x)));
    t = mix(u_stops[k], u_stops[k + 1], x - float(k));
  }
  return vec4(mix(t, s.rgb, u_blend), s.a);
}`,
  (p, gl, u) => {
    const stops = tonerStops(p);
    gl.uniform3fv(u("u_stops"), [...stops.flat(), ...new Array(15 - stops.length * 3).fill(0)]);
    gl.uniform1i(u("u_count"), stops.length);
    gl.uniform1f(u("u_blend"), Math.min(1, Math.max(0, p.num(4, 0))));
  },
);

registerStraight(
  "CC Color Offset",
  `uniform vec3 u_phase;
uniform int u_overflow;
const float PI = 3.14159265358979;
float offset(float v, float phase) {
  if (u_overflow == 3) return (1.0 - cos(acos(1.0 - 2.0 * clamp(v, 0.0, 1.0)) + PI * phase)) / 2.0;
  float x = v + phase;
  if (u_overflow == 1) return x > 1.0 ? x - ceil(x - 1.0) : x < 0.0 ? fract(x) : x;
  float f = x - 2.0 * floor(x / 2.0);
  return f <= 1.0 ? f : 2.0 - f;
}
vec4 adjust(vec4 s) { return vec4(offset(s.r, u_phase.r), offset(s.g, u_phase.g), offset(s.b, u_phase.b), s.a); }`,
  (p, gl, u) => {
    gl.uniform3f(u("u_phase"), p.num(1, 0) / 360, p.num(2, 0) / 360, p.num(3, 0) / 360);
    gl.uniform1i(u("u_overflow"), p.choice(4, 2));
  },
);

registerStraight(
  "ADBE Gamma/Pedestal/Gain2",
  `uniform float u_stretch;
uniform vec3 u_gamma;
uniform vec3 u_pedestal;
uniform vec3 u_gain;
vec4 adjust(vec4 s) {
  vec3 v = u_pedestal + (u_gain - u_pedestal) * pow(max(s.rgb, 0.0), 1.0 / u_gamma);
  vec3 d = 1.0 - 2.0 * v;
  v += step(0.0, v) * step(v, vec3(0.5)) * (u_stretch - 1.0) * v * d * d;
  return vec4(v, s.a);
}`,
  (p, gl, u) => {
    gl.uniform1f(u("u_stretch"), p.num(1, 1));
    const [r, g, b] = [2, 5, 8].map((n) => [Math.max(1e-3, p.num(n, 1)), p.num(n + 1, 0), p.num(n + 2, 1)]);
    gl.uniform3f(u("u_gamma"), r[0], g[0], b[0]);
    gl.uniform3f(u("u_pedestal"), r[1], g[1], b[1]);
    gl.uniform3f(u("u_gain"), r[2], g[2], b[2]);
  },
);

registerStraight(
  "ADBE Color Balance 2",
  `uniform vec3 u_shadow;
uniform vec3 u_mid;
uniform vec3 u_high;
uniform int u_preserve;
vec3 balancePow(vec3 x, vec3 p) {
  vec3 q = min(p, vec3(0.999));
  vec3 x0 = pow(vec3(${BALANCE_TOE_SLOPE.toFixed(4)}) / q, 1.0 / (q - 1.0));
  vec3 toe = (2.0 - q) * pow(x0, q - 1.0) * x + (q - 1.0) * pow(x0, q - 2.0) * x * x;
  return mix(pow(x, p), toe, lessThan(x, x0));
}
vec4 adjust(vec4 s) {
  vec3 lo = -0.4 * min(u_shadow, 0.0);
  vec3 hi = 1.0 - 0.4 * max(u_high, 0.0);
  vec3 x = clamp((clamp(s.rgb, 0.0, 1.0) - lo) / (hi - lo), 0.0, 1.0);
  vec3 p = pow(vec3(2.0), -u_mid);
  if (u_preserve == 0) p *= pow(vec3(1.4), -u_high - u_shadow);
  return vec4(balancePow(x, p), s.a);
}`,
  (p, gl, u) => {
    const v = colorBalanceSliders(p);
    gl.uniform3f(u("u_shadow"), v[0], v[1], v[2]);
    gl.uniform3f(u("u_mid"), v[3], v[4], v[5]);
    gl.uniform3f(u("u_high"), v[6], v[7], v[8]);
    gl.uniform1i(u("u_preserve"), p.bool(10, false) ? 1 : 0);
  },
);

registerStraight(
  "CS Color Neutralizer",
  `uniform vec3 u_offsets[3];
uniform vec2 u_points;
vec4 adjust(vec4 s) {
  float x = ((s.r + s.g + s.b) / 3.0 - u_points.x) / max(u_points.y - u_points.x, 1e-6);
  float shadow = smoothstep(0.0, 1.0, 1.0 - 2.0 * x);
  float high = smoothstep(0.0, 1.0, 2.0 * x - 1.0);
  return vec4(s.rgb + shadow * u_offsets[0] + (1.0 - shadow - high) * u_offsets[1] + high * u_offsets[2], s.a);
}`,
  (p, gl, u) => {
    gl.uniform3fv(u("u_offsets"), neutralizerOffsets(p).flat());
    gl.uniform2f(u("u_points"), p.num(23, 0) / 100, p.num(24, 100) / 100);
  },
);

const SRGB_GLSL = `
vec3 toLinear(vec3 v) { return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(0.04045, v)); }
vec3 toSrgb(vec3 v) { return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, v)); }`;

registerStraight(
  "ADBE PhotoFilterPS",
  `${SRGB_GLSL}
uniform mat3 u_filter;
uniform int u_preserve;
const vec3 LUMA = vec3(${PHOTO_FILTER_LUMA.join(", ")});
vec4 adjust(vec4 s) {
  vec3 c = toSrgb(clamp(u_filter * toLinear(s.rgb), 0.0, 1.0));
  if (u_preserve == 1) {
    c += dot(s.rgb, LUMA) - dot(c, LUMA);
    float l = dot(c, LUMA);
    float lo = min(c.r, min(c.g, c.b));
    float hi = max(c.r, max(c.g, c.b));
    if (lo < 0.0) c = l + (c - l) * l / (l - lo);
    if (hi > 1.0) c = l + (c - l) * (1.0 - l) / (hi - l);
  }
  return vec4(c, s.a);
}`,
  (p, gl, u) => {
    gl.uniformMatrix3fv(u("u_filter"), true, photoFilterMatrix(p));
    gl.uniform1i(u("u_preserve"), p.bool(4, true) ? 1 : 0);
  },
);

registerStraight(
  "ADBE SelectiveColor",
  `uniform vec4 u_adjust[${SELECTIVE_GROUPS.length}];
uniform int u_relative;
vec4 adjust(vec4 s) {
  vec3 c = s.rgb;
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float md = c.r + c.g + c.b - mx - mn;
  bool chroma = mx > mn;
  float w[${SELECTIVE_GROUPS.length}];
  w[0] = chroma && c.r == mx ? mx - md : 0.0;
  w[1] = chroma && c.b == mn ? md - mn : 0.0;
  w[2] = chroma && c.g == mx ? mx - md : 0.0;
  w[3] = chroma && c.r == mn ? md - mn : 0.0;
  w[4] = chroma && c.b == mx ? mx - md : 0.0;
  w[5] = chroma && c.g == mn ? md - mn : 0.0;
  w[6] = mn > 0.5 ? (mn - 0.5) * 2.0 : 0.0;
  w[7] = 1.0 - (abs(mx - 0.5) + abs(mn - 0.5));
  w[8] = mx < 0.5 ? (0.5 - mx) * 2.0 : 0.0;
  vec3 d = vec3(0.0);
  for (int k = 0; k < ${SELECTIVE_GROUPS.length}; k++) {
    vec4 a = u_adjust[k];
    vec3 change = (-1.0 - a.rgb) * a.a - a.rgb;
    if (u_relative == 1) change *= 1.0 - c;
    d += w[k] * clamp(change, -c, 1.0 - c);
  }
  return vec4(c + d, s.a);
}`,
  (p, gl, u) => {
    gl.uniform4fv(u("u_adjust"), SELECTIVE_GROUPS.flatMap((n) => [0, 1, 2, 3].map((k) => p.num(n + k, 0) / 100)));
    gl.uniform1i(u("u_relative"), p.choice(1, 1) === 1 ? 1 : 0);
  },
);

const KEY_GLSL = `
uniform vec3 u_key;
uniform float u_tolerance;
uniform float u_softness;
uniform int u_metric;
uniform float u_softScale;
float keyDistance(vec3 c) {
  if (u_metric == 2) {
    float d = abs(rgb2hsl(c).x - rgb2hsl(u_key).x);
    return 2.0 * min(d, 1.0 - d);
  }
  if (u_metric == 3) {
    mat3 uv = mat3(-0.147, 0.615, 0.0, -0.289, -0.515, 0.0, 0.436, -0.1, 0.0);
    return length((uv * (c - u_key)).xy) / ${CHROMA_SCALE.toFixed(4)};
  }
  return length(c - u_key) * ${(RGB_KEY_SCALE / Math.sqrt(3)).toFixed(8)};
}
float keyMatch(vec3 c) {
  float d = keyDistance(c);
  if (d <= u_tolerance) return 1.0;
  if (u_softness <= 0.0) return 0.0;
  return 1.0 - clamp((d * d - u_tolerance * u_tolerance) / (u_softScale * u_softness), 0.0, 1.0);
}`;

function setKey(gl: WebGL2RenderingContext, u: (name: string) => WebGLUniformLocation | null, key: number[], tolerance: number, softness: number, metric: number): void {
  gl.uniform3f(u("u_key"), key[0], key[1], key[2]);
  gl.uniform1f(u("u_tolerance"), tolerance);
  gl.uniform1f(u("u_softness"), softness);
  gl.uniform1i(u("u_metric"), metric);
  gl.uniform1f(u("u_softScale"), KEY_SOFTNESS[metric] ?? KEY_SOFTNESS[1]);
}

registerStraight(
  "ADBE Leave Color",
  `${KEY_GLSL}
uniform float u_amount;
vec4 adjust(vec4 s) {
  float f = u_amount * (1.0 - keyMatch(s.rgb));
  return vec4(mix(s.rgb, vec3(dot(s.rgb, vec3(${KEY_LUMA.join(", ")}))), f), s.a);
}`,
  (p, gl, u) => {
    gl.uniform1f(u("u_amount"), Math.min(1, Math.max(0, p.num(1, 0) / 100)));
    setKey(gl, u, p.rgb(2, [1, 0, 0]), p.num(3, 15) / 100, p.num(4, 0) / 100, p.choice(5, 1));
  },
);

registerStraight(
  "ADBE Change Color",
  `${KEY_GLSL}
uniform int u_view;
uniform vec3 u_shift;
uniform int u_invert;
vec4 adjust(vec4 s) {
  float m = keyMatch(s.rgb);
  if (u_invert == 1) m = 1.0 - m;
  if (u_view == 2) return m >= 0.5 / 255.0 ? vec4(vec3(m), s.a) : vec4(0.0);
  vec3 hsl = rgb2hsl(s.rgb);
  vec3 t = hsl2rgb(vec3(hsl.x + u_shift.x, clamp(hsl.y + u_shift.y, 0.0, 1.0), clamp(hsl.z + u_shift.z, 0.0, 1.0)));
  return vec4(mix(s.rgb, t, m), s.a);
}`,
  (p, gl, u) => {
    gl.uniform1i(u("u_view"), p.choice(1, 1));
    gl.uniform3f(u("u_shift"), p.num(2, 0) / 360, p.num(4, 0) / 100, p.num(3, 0) / 100);
    gl.uniform1i(u("u_invert"), p.bool(9, false) ? 1 : 0);
    setKey(gl, u, p.rgb(5, [1, 0, 0]), p.num(6, 15) / 100, p.num(7, 0) / 100, p.choice(8, 1));
  },
);

registerStraight(
  "ADBE Change To Color",
  `uniform vec3 u_from;
uniform vec3 u_to;
uniform vec3 u_tolerance;
uniform float u_softness;
uniform bvec2 u_change;
uniform int u_transform;
uniform int u_view;
vec4 adjust(vec4 s) {
  vec3 hsl = rgb2hsl(s.rgb);
  float dh = abs(hsl.x - u_from.x);
  vec3 d = vec3(min(dh, 1.0 - dh), abs(hsl.z - u_from.z), abs(hsl.y - u_from.y)) / max(u_tolerance, 1e-6);
  float k = 2.0 * d.x + (d.y + d.z) / 8.0;
  float m = u_softness <= 0.0 ? step(k, 1.0) : clamp((1.0 - k) / u_softness, 0.0, 1.0);
  if (u_view == 1) return vec4(vec3(m), s.a);
  vec3 t = u_transform == 1
    ? vec3(hsl.x + u_to.x - u_from.x, u_change.y ? clamp(hsl.y + u_to.y - u_from.y, 0.0, 1.0) : hsl.y,
        u_change.x ? clamp(hsl.z + u_to.z - u_from.z, 0.0, 1.0) : hsl.z)
    : vec3(u_to.x, u_change.y ? u_to.y : hsl.y, u_change.x ? u_to.z : hsl.z);
  return vec4(mix(s.rgb, hsl2rgb(t), m), s.a);
}`,
  (p, gl, u) => {
    gl.uniform3fv(u("u_from"), rgbToHsl(p.rgb(1, [1, 0, 0])));
    gl.uniform3fv(u("u_to"), rgbToHsl(p.rgb(2, [0, 0, 1])));
    gl.uniform3f(u("u_tolerance"), p.num(5, 0.05), p.num(6, 0.5), p.num(7, 0.5));
    gl.uniform1f(u("u_softness"), p.num(8, 0.5));
    const [light, sat] = CHANGE_TO_COLOR_CHANNELS[p.choice(3, 1)] ?? CHANGE_TO_COLOR_CHANNELS[1];
    gl.uniform2i(u("u_change"), light ? 1 : 0, sat ? 1 : 0);
    gl.uniform1i(u("u_transform"), p.choice(4, 1) === 2 ? 1 : 0);
    gl.uniform1i(u("u_view"), p.bool(9, false) ? 1 : 0);
  },
);

/** The most output cycle entries Colorama stores. */
const MAX_CYCLE = 64;

register("APC Colorama", (input, p, ctx, _layer, _time, effect) => {
  const cycle = coloramaCycle(instanceData(effect, 12));
  const at = new Float32Array(MAX_CYCLE);
  const rgba = new Float32Array(MAX_CYCLE * 4);
  cycle.forEach((e, k) => {
    at[k] = e.at;
    rgba.set(e.rgba, k * 4);
  });
  return straightPass(
    ctx,
    input,
    `uniform int u_count;
uniform float u_at[${MAX_CYCLE}];
uniform vec4 u_rgba[${MAX_CYCLE}];
uniform int u_phaseFrom;
uniform float u_shift;
uniform float u_repeats;
uniform int u_interpolate;
uniform int u_modify;
uniform float u_blend;
float phase(vec4 s) {
  vec3 hsl = rgb2hsl(s.rgb);
  if (u_phaseFrom == 1) return (s.r + s.g + s.b) / 3.0;
  if (u_phaseFrom == 2) return s.r;
  if (u_phaseFrom == 3) return s.g;
  if (u_phaseFrom == 4) return s.b;
  if (u_phaseFrom == 5) return hsl.x;
  if (u_phaseFrom == 6) return hsl.z;
  if (u_phaseFrom == 7) return hsl.y;
  if (u_phaseFrom == 8) return max(s.r, max(s.g, s.b));
  if (u_phaseFrom == 9) return s.a;
  return 0.0;
}
vec4 cycleAt(float t) {
  if (u_count == 0) return vec4(0.0, 0.0, 0.0, 1.0);
  t = fract(t);
  int k = u_count - 1;
  for (int i = 0; i < ${MAX_CYCLE}; i++) if (i < u_count && u_at[i] <= t) k = i;
  int n = k + 1 == u_count ? 0 : k + 1;
  float span = u_at[n] - u_at[k];
  float d = t - u_at[k];
  if (span <= 0.0) span += 1.0;
  if (d < 0.0) d += 1.0;
  float w = span > 0.0 ? d / span : 0.0;
  if (u_interpolate == 0) return w < 0.5 ? u_rgba[k] : u_rgba[n];
  return mix(u_rgba[k], u_rgba[n], w);
}
vec3 modify(vec3 c, vec3 o) {
  if (u_modify < 8) return mix(c, o, vec3(notEqual(ivec3(u_modify) & ivec3(1, 2, 4), ivec3(0))));
  vec3 a = rgb2hsl(c);
  vec3 b = rgb2hsl(o);
  return hsl2rgb(vec3((u_modify & 8) != 0 ? b.x : a.x, (u_modify & 32) != 0 ? b.y : a.y, (u_modify & 16) != 0 ? b.z : a.z));
}
vec4 adjust(vec4 s) {
  vec3 o = modify(s.rgb, cycleAt((phase(s) * ${COLORAMA_PHASE_SCALE} + u_shift) * u_repeats).rgb);
  return vec4(mix(o, s.rgb, u_blend), s.a);
}`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform1i(u("u_count"), cycle.length);
      gl.uniform1fv(u("u_at"), at);
      gl.uniform4fv(u("u_rgba"), rgba);
      gl.uniform1i(u("u_phaseFrom"), Math.round(p.num(2, 1)));
      gl.uniform1f(u("u_shift"), p.num(8, 0) / 360);
      gl.uniform1f(u("u_repeats"), p.num(38, 1));
      gl.uniform1i(u("u_interpolate"), p.bool(14, true) ? 1 : 0);
      gl.uniform1i(u("u_modify"), COLORAMA_MODIFY[p.choice(16, 1)] ?? 7);
      gl.uniform1f(u("u_blend"), Math.min(1, Math.max(0, p.num(36, 0) / 100)));
    },
  );
});

// CC Kernel: a 3 x 3 convolution of straight colour (line 1 is the row above, the layer's edge pixels repeated past
// it, transparent pixels black), divided by Divider, optionally made absolute, blended with the original, then
// clamped. Alpha is kept.
const KERNEL_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_pad;
uniform float u_k[9];
uniform float u_divider;
uniform int u_absolute;
uniform float u_blend;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 lo = ivec2(int(u_pad));
  ivec2 hi = ivec2(u_size) - 1 - lo;
  if (any(lessThan(p, lo)) || any(greaterThan(p, hi))) {
    outColor = vec4(0.0);
    return;
  }
  vec4 c = texelFetch(u_source, p, 0);
  vec3 centre = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 3; j++)
    for (int i = 0; i < 3; i++) {
      vec4 s = texelFetch(u_source, clamp(p + ivec2(i - 1, 1 - j), lo, hi), 0);
      sum += u_k[j * 3 + i] * (s.a > 0.0 ? s.rgb / s.a : vec3(0.0));
    }
  sum /= u_divider;
  if (u_absolute == 1) sum = abs(sum);
  vec3 r = clamp(mix(sum, centre, u_blend), 0.0, 1.0);
  outColor = vec4(r * c.a, c.a);
}`;

register("CS Kernel", (input, p, ctx) =>
  mapPass(ctx, input, KERNEL_FS, (u) => {
    const gl = ctx.gl;
    gl.uniform1fv(u("u_k"), [2, 3, 4, 7, 8, 9, 12, 13, 14].map((n) => p.num(n, n === 8 ? 1 : 0)));
    gl.uniform1f(u("u_divider"), Math.max(0.01, p.num(16, 1)));
    gl.uniform1i(u("u_absolute"), p.bool(17, false) ? 1 : 0);
    gl.uniform1f(u("u_blend"), Math.min(1, Math.max(0, p.num(18, 0) / 100)));
  }),
);
