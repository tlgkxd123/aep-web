// Stock Color Correction and Channel effects that change each pixel's colour on
// its own: Tint, Tritone, Brightness & Contrast (and its legacy version),
// Exposure, Hue/Saturation, Color Balance (HLS), Channel Mixer, Black & White,
// Levels, Invert, Posterize, Threshold and Shift Channels. They work on straight
// colour and keep the alpha (Invert's and Shift Channels' alpha options and
// Levels on the alpha channel aside).
//
// Look-alikes from the effects' documented behaviour, not yet measured against
// After Effects renders (no fixture suite holds them yet).
import { mapPass, PASS_HEADER } from "./fxextraUtil.ts";
import { levelsFractions } from "./stockMath.ts";
import { COLOR_LIB, colorPass, registerColor, registerStock } from "./stockUtil.ts";

const pct = (v: number) => v / 100;

registerColor(
  "ADBE Tint",
  `uniform vec3 u_black;
uniform vec3 u_white;
uniform float u_amount;
vec3 adjust(vec3 s) { return mix(s, mix(u_black, u_white, luma(s)), u_amount); }`,
  (p, gl, u) => {
    gl.uniform3fv(u("u_black"), p.rgb(1, [0, 0, 0]));
    gl.uniform3fv(u("u_white"), p.rgb(2, [1, 1, 1]));
    gl.uniform1f(u("u_amount"), Math.min(1, Math.max(0, pct(p.num(3, 100)))));
  },
);

registerColor(
  "ADBE Tritone",
  `uniform vec3 u_high;
uniform vec3 u_mid;
uniform vec3 u_shadow;
uniform float u_blend;
vec3 adjust(vec3 s) {
  float l = luma(s);
  vec3 t = l < 0.5 ? mix(u_shadow, u_mid, l * 2.0) : mix(u_mid, u_high, l * 2.0 - 1.0);
  return mix(t, s, u_blend);
}`,
  (p, gl, u) => {
    gl.uniform3fv(u("u_high"), p.rgb(1, [1, 1, 1]));
    gl.uniform3fv(u("u_mid"), p.rgb(2, [0.5, 0.4, 0.3]));
    gl.uniform3fv(u("u_shadow"), p.rgb(3, [0, 0, 0]));
    gl.uniform1f(u("u_blend"), Math.min(1, Math.max(0, pct(p.num(4, 0)))));
  },
);

/** Contrast in -100..100 as a slope around mid grey. */
const contrastSlope = (c: number) => (c >= 0 ? 100 / Math.max(1e-3, 100 - Math.min(c, 99.9)) : (100 + Math.max(c, -100)) / 100);

const BRIGHTNESS_CONTRAST = `uniform float u_brightness;
uniform float u_slope;
uniform int u_legacy;
vec3 adjust(vec3 s) {
  vec3 b = u_legacy == 1 ? s + u_brightness / 255.0 : pow(s, vec3(exp2(-u_brightness / 100.0)));
  return (clamp(b, 0.0, 1.0) - 0.5) * u_slope + 0.5;
}`;

registerColor("ADBE Brightness & Contrast 2", BRIGHTNESS_CONTRAST, (p, gl, u) => {
  gl.uniform1f(u("u_brightness"), p.num(1, 0));
  gl.uniform1f(u("u_slope"), contrastSlope(p.num(2, 0)));
  gl.uniform1i(u("u_legacy"), p.bool(3, false) ? 1 : 0);
});

registerColor("ADBE Brightness & Contrast", BRIGHTNESS_CONTRAST, (p, gl, u) => {
  gl.uniform1f(u("u_brightness"), p.num(1, 0));
  gl.uniform1f(u("u_slope"), contrastSlope(p.num(2, 0)));
  gl.uniform1i(u("u_legacy"), 1);
});

// Exposure works in linear light (gamma 2.2) unless Bypass Linear Light Conversion is on.
registerColor(
  "ADBE Exposure2",
  `uniform vec3 u_exposure;
uniform vec3 u_offset;
uniform vec3 u_gamma;
uniform int u_bypass;
vec3 adjust(vec3 s) {
  vec3 v = u_bypass == 1 ? s : pow(s, vec3(2.2));
  v = max(v * exp2(u_exposure) + u_offset, 0.0);
  v = pow(v, 1.0 / max(u_gamma, vec3(0.01)));
  return u_bypass == 1 ? v : pow(v, vec3(1.0 / 2.2));
}`,
  (p, gl, u) => {
    const individual = p.num(1, 1) === 2;
    const channel = (base: number) => [p.num(base, 0), p.num(base + 1, 0), p.num(base + 2, 1)];
    const values = individual ? [channel(8), channel(13), channel(18)] : [channel(3), channel(3), channel(3)];
    gl.uniform3f(u("u_exposure"), values[0][0], values[1][0], values[2][0]);
    gl.uniform3f(u("u_offset"), values[0][1], values[1][1], values[2][1]);
    gl.uniform3f(u("u_gamma"), values[0][2], values[1][2], values[2][2]);
    gl.uniform1i(u("u_bypass"), p.bool(22, false) ? 1 : 0);
  },
);

/** GLSL: Lightness -100..100 towards black or white. */
const LIGHTNESS = `vec3 lighten(vec3 c, float l) { return l >= 0.0 ? c + (1.0 - c) * l : c * (1.0 + l); }`;

registerStock("ADBE HUE SATURATION", (input, p, ctx) => {
  if (p.num(2, 1) !== 1) ctx.warn("Hue/Saturation: only the Master channel's values are rendered");
  return colorPass(
    ctx,
    input,
    `${LIGHTNESS}
uniform float u_hue;
uniform float u_saturation;
uniform float u_lightness;
uniform int u_colorize;
uniform vec3 u_colorizeHsl;
vec3 adjust(vec3 s) {
  vec3 hsl = rgb2hsl(s);
  if (u_colorize == 1) return lighten(hsl2rgb(vec3(u_colorizeHsl.xy, hsl.z)), u_colorizeHsl.z);
  hsl.x = fract(hsl.x + u_hue);
  hsl.y = clamp(hsl.y * (1.0 + u_saturation), 0.0, 1.0);
  return lighten(hsl2rgb(hsl), u_lightness);
}`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform1f(u("u_hue"), p.num(4, 0) / 360);
      gl.uniform1f(u("u_saturation"), pct(p.num(5, 0)));
      gl.uniform1f(u("u_lightness"), pct(p.num(6, 0)));
      gl.uniform1i(u("u_colorize"), p.bool(7, false) ? 1 : 0);
      gl.uniform3f(u("u_colorizeHsl"), (((p.num(8, 0) / 360) % 1) + 1) % 1, pct(p.num(9, 25)), pct(p.num(10, 0)));
    },
  );
});

registerColor(
  "ADBE Color Balance (HLS)",
  `${LIGHTNESS}
uniform float u_hue;
uniform float u_lightness;
uniform float u_saturation;
vec3 adjust(vec3 s) {
  vec3 hsl = rgb2hsl(s);
  hsl.x = fract(hsl.x + u_hue);
  hsl.y = clamp(hsl.y * (1.0 + u_saturation), 0.0, 1.0);
  return lighten(hsl2rgb(hsl), u_lightness);
}`,
  (p, gl, u) => {
    gl.uniform1f(u("u_hue"), p.num(1, 0) / 360);
    gl.uniform1f(u("u_lightness"), pct(p.num(2, 0)));
    gl.uniform1f(u("u_saturation"), pct(p.num(3, 0)));
  },
);

// Channel Mixer: each output channel is a percentage mix of red, green and blue plus a constant; Monochrome
// writes the red row's mix to all three.
registerColor(
  "ADBE CHANNEL MIXER",
  `uniform mat3 u_mix;
uniform vec3 u_const;
uniform int u_mono;
vec3 adjust(vec3 s) {
  vec3 v = u_mix * s + u_const;
  return u_mono == 1 ? vec3(v.r) : v;
}`,
  (p, gl, u) => {
    const row = (base: number, own: number) => [0, 1, 2, 3].map((k) => pct(p.num(base + k, k === own ? 100 : 0)));
    const [r, g, b] = [row(1, 0), row(5, 1), row(9, 2)];
    // Column-major: column j holds the weights of input channel j.
    gl.uniformMatrix3fv(u("u_mix"), false, [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]]);
    gl.uniform3f(u("u_const"), r[3], g[3], b[3]);
    gl.uniform1i(u("u_mono"), p.bool(13, false) ? 1 : 0);
  },
);

// Black & White's grey is blackWhiteGray's (stockMath.ts).
registerColor(
  "ADBE Black&White",
  `uniform float u_w[6];
uniform int u_tint;
uniform vec3 u_tintHsl;
vec3 adjust(vec3 s) {
  float mx = max(s.r, max(s.g, s.b));
  float mn = min(s.r, min(s.g, s.b));
  float md = s.r + s.g + s.b - mx - mn;
  float primary;
  float secondary;
  if (mx == s.r) { primary = u_w[0]; secondary = s.g >= s.b ? u_w[1] : u_w[5]; }
  else if (mx == s.g) { primary = u_w[2]; secondary = s.r >= s.b ? u_w[1] : u_w[3]; }
  else { primary = u_w[4]; secondary = s.r >= s.g ? u_w[5] : u_w[3]; }
  float gray = clamp(mn + (md - mn) * secondary + (mx - md) * primary, 0.0, 1.0);
  return u_tint == 1 ? hsl2rgb(vec3(u_tintHsl.xy, gray)) : vec3(gray);
}`,
  (p, gl, u) => {
    const defaults = [40, 60, 40, 60, 20, 80];
    gl.uniform1fv(u("u_w"), defaults.map((d, i) => pct(p.num(i + 1, d))));
    gl.uniform1i(u("u_tint"), p.bool(7, false) ? 1 : 0);
    const [r, g, b] = p.rgb(8, [0.87, 0.8, 0.65]);
    const hsl = rgbToHsl(r, g, b);
    gl.uniform3f(u("u_tintHsl"), hsl[0], hsl[1], hsl[2]);
  },
);

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d <= 1e-6) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

const LEVELS_FS = `${PASS_HEADER}${COLOR_LIB}
uniform vec4 u_mask;
uniform float u_inBlack;
uniform float u_inWhite;
uniform float u_gamma;
uniform float u_outBlack;
uniform float u_outWhite;
uniform int u_clipBlack;
uniform int u_clipWhite;
float level(float v) {
  float span = u_inWhite - u_inBlack;
  float t = span == 0.0 ? step(u_inWhite, v) : (v - u_inBlack) / span;
  t = sign(t) * pow(abs(t), 1.0 / max(u_gamma, 1e-3));
  float o = u_outBlack + t * (u_outWhite - u_outBlack);
  if (u_clipBlack == 1) o = max(o, min(u_outBlack, u_outWhite));
  if (u_clipWhite == 1) o = min(o, max(u_outBlack, u_outWhite));
  return clamp(o, 0.0, 1.0);
}
void main() {
  vec4 c = texture(u_source, v_uv);
  vec4 s = vec4(straight(c), c.a);
  vec4 l = vec4(level(s.r), level(s.g), level(s.b), level(s.a));
  s = mix(s, l, u_mask);
  outColor = vec4(s.rgb * s.a, s.a);
}`;

// Levels: the values shown are those of the selected channel; the other channels' settings live in the
// effect's histogram data, which is not read.
registerStock("ADBE Easy Levels2", (input, p, ctx) => {
  const channel = p.num(1, 1);
  const [inBlack, inWhite, outBlack, outWhite] = levelsFractions([p.num(3, 0), p.num(4, 1), p.num(6, 0), p.num(7, 1)]);
  const mask = channel === 2 ? [1, 0, 0, 0] : channel === 3 ? [0, 1, 0, 0] : channel === 4 ? [0, 0, 1, 0] : channel === 5 ? [0, 0, 0, 1] : [1, 1, 1, 0];
  return mapPass(ctx, input, LEVELS_FS, (u) => {
    const gl = ctx.gl;
    gl.uniform4fv(u("u_mask"), mask);
    gl.uniform1f(u("u_inBlack"), inBlack);
    gl.uniform1f(u("u_inWhite"), inWhite);
    gl.uniform1f(u("u_gamma"), p.num(5, 1));
    gl.uniform1f(u("u_outBlack"), outBlack);
    gl.uniform1f(u("u_outWhite"), outWhite);
    gl.uniform1i(u("u_clipBlack"), p.bool(8, true) ? 1 : 0);
    gl.uniform1i(u("u_clipWhite"), p.bool(9, true) ? 1 : 0);
  });
});

/** Invert's Channel popup. */
const InvertChannel = { RGB: 1, RED: 2, GREEN: 3, BLUE: 4, HLS: 5, HUE: 6, LIGHTNESS: 7, SATURATION: 8, YIQ: 9, LUMINANCE: 10, IN_PHASE: 11, QUADRATURE: 12, ALPHA: 13 } as const;

const INVERT_FS = `${PASS_HEADER}${COLOR_LIB}
uniform int u_channel;
uniform float u_blend;
void main() {
  vec4 c = texture(u_source, v_uv);
  vec3 s = straight(c);
  float a = c.a;
  vec3 r = s;
  if (u_channel == 1) r = 1.0 - s;
  else if (u_channel == 2) r.r = 1.0 - s.r;
  else if (u_channel == 3) r.g = 1.0 - s.g;
  else if (u_channel == 4) r.b = 1.0 - s.b;
  else if (u_channel >= 5 && u_channel <= 8) {
    vec3 hsl = rgb2hsl(s);
    if (u_channel == 5 || u_channel == 6) hsl.x = fract(hsl.x + 0.5);
    if (u_channel == 5 || u_channel == 7) hsl.z = 1.0 - hsl.z;
    if (u_channel == 5 || u_channel == 8) hsl.y = 1.0 - hsl.y;
    r = hsl2rgb(hsl);
  } else if (u_channel >= 9 && u_channel <= 12) {
    vec3 yiq = RGB2YIQ * s;
    if (u_channel == 9 || u_channel == 10) yiq.x = 1.0 - yiq.x;
    if (u_channel == 9 || u_channel == 11) yiq.y = -yiq.y;
    if (u_channel == 9 || u_channel == 12) yiq.z = -yiq.z;
    r = YIQ2RGB * yiq;
  } else if (u_channel == 13) a = 1.0 - c.a;
  vec4 inverted = vec4(clamp(r, 0.0, 1.0) * a, a);
  outColor = mix(inverted, c, u_blend);
}`;

registerStock("ADBE Invert", (input, p, ctx) => {
  const channel = Math.round(p.num(1, InvertChannel.RGB));
  const blend = Math.min(1, Math.max(0, pct(p.num(2, 0))));
  return mapPass(ctx, input, INVERT_FS, (u) => {
    ctx.gl.uniform1i(u("u_channel"), channel);
    ctx.gl.uniform1f(u("u_blend"), blend);
  });
});

registerColor(
  "ADBE Posterize",
  `uniform float u_levels;
vec3 adjust(vec3 s) { return min(vec3(u_levels - 1.0), floor(s * u_levels)) / (u_levels - 1.0); }`,
  (p, gl, u) => gl.uniform1f(u("u_levels"), Math.max(2, Math.round(p.num(1, 7)))),
);

for (const matchName of ["ADBE Threshold2", "ADBE Threshold"]) {
  registerColor(
    matchName,
    `uniform float u_level;
vec3 adjust(vec3 s) { return vec3(luma(s) * 255.0 + 1e-3 >= u_level ? 1.0 : 0.0); }`,
    (p, gl, u) => gl.uniform1f(u("u_level"), p.num(1, 128)),
  );
}

// Shift Channels' sources: 1 alpha, 2 red, 3 green, 4 blue, 5 luminance, 6 hue, 7 lightness, 8 saturation,
// 9 full, 10 half, 11 off; from straight colour.
const SHIFT_FS = `${PASS_HEADER}${COLOR_LIB}
uniform ivec4 u_from;
float pick(int from, vec4 s, vec3 hsl) {
  if (from == 1) return s.a;
  if (from == 2) return s.r;
  if (from == 3) return s.g;
  if (from == 4) return s.b;
  if (from == 5) return luma(s.rgb);
  if (from == 6) return hsl.x;
  if (from == 7) return hsl.z;
  if (from == 8) return hsl.y;
  if (from == 9) return 1.0;
  if (from == 10) return 0.5;
  return 0.0;
}
void main() {
  vec4 c = texture(u_source, v_uv);
  vec4 s = vec4(straight(c), c.a);
  vec3 hsl = rgb2hsl(s.rgb);
  vec4 r = vec4(pick(u_from.y, s, hsl), pick(u_from.z, s, hsl), pick(u_from.w, s, hsl), pick(u_from.x, s, hsl));
  outColor = vec4(r.rgb * r.a, r.a);
}`;

registerStock("ADBE Shift Channels", (input, p, ctx) =>
  mapPass(ctx, input, SHIFT_FS, (u) =>
    ctx.gl.uniform4i(u("u_from"), Math.round(p.num(1, 1)), Math.round(p.num(2, 2)), Math.round(p.num(3, 3)), Math.round(p.num(4, 4))),
  ),
);
