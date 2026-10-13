// After Effects effects Avee Player has no element for, as Avee Custom Shaders
// (GLSL ES 1.00, as Avee Player runs them): the effect's formula, ported from the
// app's renderer (src/render/effects/), over the composition the shader draws.
// The shader works in that composition's pixels (y down, as After Effects
// measures), so effect points and lengths keep their meaning; scalar settings are
// Avee variables (uniform floats a template's user can change), colours and points
// are written into the code. Its first line names the effect and its settings, so
// converting the template back restores the effect itself (convert.ts).
//
// Avee's interface, as its templates' shaders use it: the drawn composition is
// `u_texture`, the fragment's texture coordinate `vTexCoord`; the vertex shader
// gets `u_projView` and the attributes Position, TexCoord and Color. Which way
// vTexCoord's y runs is not known; it is taken as GL's (0 at the bottom).

/** What a setting was, for restoring the effect: a number, a colour (0–1 RGB), or a point (shares of the size). */
export type SettingKind = "number" | "color" | "point";
export type Settings = Record<string, { kind: SettingKind; value: number | number[] }>;

export interface AveeShader {
  fragment: string;
  /** Uniform floats the fragment declares, with their values: Avee variables. */
  variables: [string, number][];
}

/** The effect's settings at the comp's start, read by parameter number. */
export interface EffectReader {
  num(n: number, fallback: number): number;
  rgb(n: number, fallback: number[]): number[];
  /** A point in the drawn composition's pixels. */
  point(n: number, fallback: number[]): number[];
  /** Pixel lengths in the drawn composition per pixel of the layer. */
  scale: number;
}

export const SHADER_VERTEX = `uniform mat4 u_projView;
attribute vec3 Position;
attribute vec2 TexCoord;
attribute vec4 Color;
varying vec4 vColor;
varying vec2 vTexCoord;
void main() {
  vColor = Color;
  vTexCoord = TexCoord;
  gl_Position = u_projView * vec4(Position, 1.0);
}
`;

const MARKER = "// aep-web effect: ";

/** The effect a shader of this file stands for, from its first line. */
export function shaderEffect(fragment: string): { matchName: string; settings: Settings } | undefined {
  const first = fragment.split("\n", 1)[0];
  if (!first.startsWith(MARKER)) return undefined;
  const rest = first.slice(MARKER.length);
  const bar = rest.indexOf(" | ");
  if (bar < 0) return undefined;
  try {
    return { matchName: rest.slice(0, bar), settings: JSON.parse(rest.slice(bar + 3)) as Settings };
  } catch {
    return undefined;
  }
}

const f = (v: number) => {
  const s = Number.isFinite(v) ? String(Number(v.toFixed(6))) : "0";
  return /[.e]/.test(s) ? s : `${s}.0`;
};
const vec = (v: number[]) => `vec${v.length}(${v.map(f).join(", ")})`;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const pct = (v: number) => v / 100;
const DEG = Math.PI / 180;

/** Pixel-space helpers: here() is the fragment in composition pixels, at(q) samples there (transparent outside). */
const space = (size: number[]) => `const vec2 SIZE = ${vec(size)};
vec2 here() { return vec2(vTexCoord.x, 1.0 - vTexCoord.y) * SIZE; }
vec4 at(vec2 q) {
  if (q.x < 0.0 || q.y < 0.0 || q.x > SIZE.x || q.y > SIZE.y) return vec4(0.0);
  return texture2D(u_texture, vec2(q.x / SIZE.x, 1.0 - q.y / SIZE.y));
}
`;

const COLOR_LIB = `vec3 straight(vec4 c) { return c.a > 0.0 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0); }
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
vec3 lighten(vec3 c, float l) { return l >= 0.0 ? c + (1.0 - c) * l : c * (1.0 + l); }
`;

/** A colour effect: `adjust` maps straight colour to straight colour, the alpha kept. */
const color = (decls: string, adjust: string) => `${COLOR_LIB}${decls}
vec3 adjust(vec3 s) {
${adjust}
}
void main() {
  vec4 c = texture2D(u_texture, vTexCoord);
  vec3 s = straight(c);
  gl_FragColor = vec4(clamp(adjust(s), 0.0, 1.0) * c.a, c.a);
}`;

type Generator = (p: EffectReader, size: number[]) => { body: string; variables: [string, number][] } | undefined;

/** Gaussian taps on rings around the fragment: weights for sigma, offsets in pixels. GLSL ES 1.00 needs constant loop bounds. */
const RING_TAPS = `const int RINGS = 4;
const int PER_RING = 12;
`;

const GENERATORS: Record<string, Generator> = {
  "ADBE Tint": (p) => ({
    body: color(`const vec3 BLACK = ${vec(p.rgb(1, [0, 0, 0]))};\nconst vec3 WHITE = ${vec(p.rgb(2, [1, 1, 1]))};\nuniform float u_amount;`, "  return mix(s, mix(BLACK, WHITE, luma(s)), u_amount);"),
    variables: [["u_amount", clamp01(pct(p.num(3, 100)))]],
  }),
  "ADBE Tritone": (p) => ({
    body: color(
      `const vec3 HIGH = ${vec(p.rgb(1, [1, 1, 1]))};\nconst vec3 MID = ${vec(p.rgb(2, [0.5, 0.4, 0.3]))};\nconst vec3 SHADOW = ${vec(p.rgb(3, [0, 0, 0]))};\nuniform float u_blend;`,
      "  float l = luma(s);\n  vec3 t = l < 0.5 ? mix(SHADOW, MID, l * 2.0) : mix(MID, HIGH, l * 2.0 - 1.0);\n  return mix(t, s, u_blend);",
    ),
    variables: [["u_blend", clamp01(pct(p.num(4, 0)))]],
  }),
  "ADBE Brightness & Contrast 2": (p) => {
    const c = p.num(2, 0);
    const slope = c >= 0 ? 100 / Math.max(1e-3, 100 - Math.min(c, 99.9)) : (100 + Math.max(c, -100)) / 100;
    const legacy = p.num(3, 0) !== 0;
    return {
      body: color(
        "uniform float u_brightness;\nuniform float u_slope;",
        `  vec3 b = ${legacy ? "s + u_brightness / 255.0" : "pow(s, vec3(exp2(-u_brightness / 100.0)))"};\n  return (clamp(b, 0.0, 1.0) - 0.5) * u_slope + 0.5;`,
      ),
      variables: [
        ["u_brightness", p.num(1, 0)],
        ["u_slope", slope],
      ],
    };
  },
  "ADBE Exposure2": (p) => {
    const bypass = p.num(22, 0) !== 0;
    return {
      body: color(
        "uniform float u_exposure;\nuniform float u_offset;\nuniform float u_gamma;",
        `  vec3 v = ${bypass ? "s" : "pow(s, vec3(2.2))"};\n  v = max(v * exp2(u_exposure) + u_offset, 0.0);\n  v = pow(v, vec3(1.0 / max(u_gamma, 0.01)));\n  return ${bypass ? "v" : "pow(v, vec3(1.0 / 2.2))"};`,
      ),
      variables: [
        ["u_exposure", p.num(3, 0)],
        ["u_offset", p.num(4, 0)],
        ["u_gamma", p.num(5, 1)],
      ],
    };
  },
  "ADBE HUE SATURATION": (p) => {
    const colorize = p.num(7, 0) !== 0;
    const hsl = [((((p.num(8, 0) / 360) % 1) + 1) % 1), pct(p.num(9, 25)), pct(p.num(10, 0))];
    return {
      body: color(
        `uniform float u_hue;\nuniform float u_saturation;\nuniform float u_lightness;\nconst vec3 COLORIZE = ${vec(hsl)};`,
        colorize
          ? "  vec3 hsl = rgb2hsl(s);\n  return lighten(hsl2rgb(vec3(COLORIZE.xy, hsl.z)), COLORIZE.z);"
          : "  vec3 hsl = rgb2hsl(s);\n  hsl.x = fract(hsl.x + u_hue);\n  hsl.y = clamp(hsl.y * (1.0 + u_saturation), 0.0, 1.0);\n  return lighten(hsl2rgb(hsl), u_lightness);",
      ),
      variables: [
        ["u_hue", p.num(4, 0) / 360],
        ["u_saturation", pct(p.num(5, 0))],
        ["u_lightness", pct(p.num(6, 0))],
      ],
    };
  },
  "ADBE Invert": (p) => {
    const channel = Math.round(p.num(1, 1));
    const map: Record<number, string> = {
      1: "1.0 - s",
      2: "vec3(1.0 - s.r, s.g, s.b)",
      3: "vec3(s.r, 1.0 - s.g, s.b)",
      4: "vec3(s.r, s.g, 1.0 - s.b)",
      5: "hsl2rgb(vec3(fract(h.x + 0.5), 1.0 - h.y, 1.0 - h.z))",
      6: "hsl2rgb(vec3(fract(h.x + 0.5), h.y, h.z))",
      7: "hsl2rgb(vec3(h.x, h.y, 1.0 - h.z))",
      8: "hsl2rgb(vec3(h.x, 1.0 - h.y, h.z))",
    };
    const inverted = channel === 13 ? "vec4(s * (1.0 - c.a), 1.0 - c.a)" : `vec4(clamp(${map[channel] ?? map[1]}, 0.0, 1.0) * c.a, c.a)`;
    return {
      body: `${COLOR_LIB}uniform float u_blend;
void main() {
  vec4 c = texture2D(u_texture, vTexCoord);
  vec3 s = straight(c);
  vec3 h = rgb2hsl(s);
  gl_FragColor = mix(${inverted}, c, u_blend);
}`,
      variables: [["u_blend", clamp01(pct(p.num(2, 0)))]],
    };
  },
  "ADBE Posterize": (p) => ({
    body: color("uniform float u_levels;", "  return min(vec3(u_levels - 1.0), floor(s * u_levels)) / (u_levels - 1.0);"),
    variables: [["u_levels", Math.max(2, Math.round(p.num(1, 7)))]],
  }),
  "ADBE Threshold2": (p) => ({
    body: color("uniform float u_level;", "  return vec3(luma(s) * 255.0 + 1e-3 >= u_level ? 1.0 : 0.0);"),
    variables: [["u_level", p.num(1, 128)]],
  }),
  "ADBE Fill": (p) => ({
    body: `const vec3 FILL = ${vec(p.rgb(2, [1, 0, 0]))};
uniform float u_opacity;
void main() {
  vec4 c = texture2D(u_texture, vTexCoord);
  gl_FragColor = mix(c, vec4(FILL * c.a, c.a), u_opacity);
}`,
    variables: [["u_opacity", clamp01(p.num(5, 1))]],
  }),
  "ADBE Black&White": (p) => {
    const weights = [40, 60, 40, 60, 20, 80].map((d, i) => pct(p.num(i + 1, d)));
    const tint = p.num(7, 0) !== 0;
    const [r, g, b] = p.rgb(8, [0.87, 0.8, 0.65]);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    const d = mx - mn;
    const s = d <= 1e-6 ? 0 : l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = d <= 1e-6 ? 0 : (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
    return {
      body: color(
        `const float W0 = ${f(weights[0])};\nconst float W1 = ${f(weights[1])};\nconst float W2 = ${f(weights[2])};\nconst float W3 = ${f(weights[3])};\nconst float W4 = ${f(weights[4])};\nconst float W5 = ${f(weights[5])};\nconst vec3 TINT = ${vec([h, s, l])};`,
        `  float mx = max(s.r, max(s.g, s.b));
  float mn = min(s.r, min(s.g, s.b));
  float md = s.r + s.g + s.b - mx - mn;
  float primary;
  float secondary;
  if (mx == s.r) { primary = W0; secondary = s.g >= s.b ? W1 : W5; }
  else if (mx == s.g) { primary = W2; secondary = s.r >= s.b ? W1 : W3; }
  else { primary = W4; secondary = s.r >= s.g ? W5 : W3; }
  float gray = clamp(mn + (md - mn) * secondary + (mx - md) * primary, 0.0, 1.0);
  return ${tint ? "hsl2rgb(vec3(TINT.xy, gray))" : "vec3(gray)"};`,
      ),
      variables: [],
    };
  },
  "ADBE Easy Levels2": (p) => {
    const channel = p.num(1, 1);
    const level = (v: number) => (v > 1 ? v / 255 : v);
    const mask = channel === 2 ? "vec3(1.0, 0.0, 0.0)" : channel === 3 ? "vec3(0.0, 1.0, 0.0)" : channel === 4 ? "vec3(0.0, 0.0, 1.0)" : "vec3(1.0)";
    if (channel === 5) return undefined;
    return {
      body: color(
        `uniform float u_inBlack;\nuniform float u_inWhite;\nuniform float u_gamma;\nuniform float u_outBlack;\nuniform float u_outWhite;\nconst vec3 MASK = ${mask};
float level(float v) {
  float span = u_inWhite - u_inBlack;
  float t = span == 0.0 ? step(u_inWhite, v) : (v - u_inBlack) / span;
  t = sign(t) * pow(abs(t), 1.0 / max(u_gamma, 1e-3));
  float o = u_outBlack + t * (u_outWhite - u_outBlack);
  ${p.num(8, 1) !== 0 ? "o = max(o, min(u_outBlack, u_outWhite));" : ""}
  ${p.num(9, 1) !== 0 ? "o = min(o, max(u_outBlack, u_outWhite));" : ""}
  return clamp(o, 0.0, 1.0);
}`,
        "  return mix(s, vec3(level(s.r), level(s.g), level(s.b)), MASK);",
      ),
      variables: [
        ["u_inBlack", level(p.num(3, 0))],
        ["u_inWhite", level(p.num(4, 1))],
        ["u_gamma", p.num(5, 1)],
        ["u_outBlack", level(p.num(6, 0))],
        ["u_outWhite", level(p.num(7, 1))],
      ],
    };
  },
  "ADBE Ramp": (p, size) => ({
    body: `${space(size)}const vec2 START = ${vec(p.point(1, [0, 0]))};
const vec2 END = ${vec(p.point(3, [0, size[1]]))};
const vec3 START_COLOR = ${vec(p.rgb(2, [0, 0, 0]))};
const vec3 END_COLOR = ${vec(p.rgb(4, [1, 1, 1]))};
uniform float u_blend;
void main() {
  vec4 original = texture2D(u_texture, vTexCoord);
  vec2 q = here();
  vec2 axis = END - START;
  float len2 = max(dot(axis, axis), 1e-6);
  float t = ${p.num(5, 1) === 2 ? "length(q - START) / sqrt(len2)" : "dot(q - START, axis) / len2"};
  vec3 ramp = mix(START_COLOR, END_COLOR, clamp(t, 0.0, 1.0));
  gl_FragColor = mix(vec4(ramp * original.a, original.a), original, u_blend);
}`,
    variables: [["u_blend", clamp01(p.num(7, 0) / 100)]],
  }),
  "ADBE Offset": (p, size) => {
    const [sx, sy] = p.point(1, [size[0] / 2, size[1] / 2]);
    return {
      body: `${space(size)}const vec2 SHIFT = ${vec([sx - size[0] / 2, sy - size[1] / 2])};
uniform float u_blend;
void main() {
  vec2 q = here();
  vec2 from = clamp(mod(q - SHIFT, SIZE), vec2(0.5), SIZE - 0.5);
  gl_FragColor = mix(at(from), at(q), u_blend);
}`,
      variables: [["u_blend", clamp01(p.num(2, 0) / 100)]],
    };
  },
  "ADBE Mosaic": (p, size) => {
    const blocks = [Math.max(1, Math.round(p.num(1, 10))), Math.max(1, Math.round(p.num(2, 10)))];
    const sharp = p.num(3, 0) !== 0;
    return {
      body: `${space(size)}const vec2 BLOCK = ${vec([size[0] / blocks[0], size[1] / blocks[1]])};
const int SAMPLES = 8;
void main() {
  vec2 cell = floor(here() / BLOCK) * BLOCK;
  ${
    sharp
      ? "gl_FragColor = at(cell + 0.5 * BLOCK);"
      : `vec4 sum = vec4(0.0);
  for (int j = 0; j < SAMPLES; j++)
    for (int i = 0; i < SAMPLES; i++)
      sum += at(cell + (vec2(float(i), float(j)) + 0.5) / float(SAMPLES) * BLOCK);
  gl_FragColor = sum / float(SAMPLES * SAMPLES);`
  }
}`,
      variables: [],
    };
  },
  "ADBE Polar Coordinates": (p, size) => ({
    body: `${space(size)}const float TAU = 6.283185307179586;
uniform float u_amount;
void main() {
  vec2 q = here() - 0.5;
  vec2 c = SIZE * 0.5;
  vec2 from;
  ${
    p.num(2, 1) === 2
      ? `float a = q.x / SIZE.x * TAU;
  float r = q.y / SIZE.y * length(c);
  from = c - r * vec2(cos(a), sin(a));`
      : `vec2 d = q - c;
  float a = atan(-d.x, -d.y);
  if (d.x == 0.0) a = d.y > 0.0 ? 0.5 * TAU : TAU;
  else if (a < 0.0) a += TAU;
  from = vec2(a / TAU * (SIZE.x - 1.0), 2.0 * length(d));`
  }
  gl_FragColor = at(mix(q, from, u_amount) + 0.5);
}`,
    variables: [["u_amount", clamp01(p.num(1, 0))]],
  }),
  "ADBE Motion Blur": (p, size) => {
    const length = Math.max(0, p.num(2, 0)) * p.scale;
    const angle = p.num(1, 0) * DEG;
    return {
      body: `${space(size)}const vec2 HALF = ${vec([(Math.sin(angle) * length) / 2, (-Math.cos(angle) * length) / 2])};
const int TAPS = 33;
void main() {
  vec2 q = here();
  vec4 sum = vec4(0.0);
  for (int i = 0; i < TAPS; i++) sum += at(q + HALF * (float(i) / float(TAPS - 1) * 2.0 - 1.0));
  gl_FragColor = sum / float(TAPS);
}`,
      variables: [],
    };
  },
  "ADBE Glo2": (p, size) => {
    const sigma = (Math.max(0, p.num(3, 10)) / 2.4) * p.scale;
    const composite = p.num(5, 2);
    const operation = p.num(6, 3);
    const blend =
      composite === 3
        ? "g"
        : composite === 1
          ? "o + g * (1.0 - o.a)"
          : operation === 6
            ? "vec4(o.rgb + g.rgb - o.rgb * g.rgb, o.a + g.a - o.a * g.a)"
            : operation === 2
              ? "vec4(g.rgb + o.rgb * (1.0 - g.a), o.a + g.a - o.a * g.a)"
              : "vec4(o.rgb + g.rgb, min(1.0, o.a + g.a))";
    return {
      body: `${space(size)}${RING_TAPS}const float SIGMA = ${f(sigma)};
const int BASED_ON_ALPHA = ${p.num(1, 2) === 1 ? 1 : 0};
uniform float u_threshold;
uniform float u_intensity;
vec4 bright(vec2 q) {
  vec4 c = at(q);
  vec3 s = c.a > 0.0 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0);
  float level = BASED_ON_ALPHA == 1 ? c.a : max(s.r, max(s.g, s.b));
  return c * clamp((level - u_threshold) / max(1.0 - u_threshold, 1e-3), 0.0, 1.0);
}
void main() {
  vec2 q = here();
  vec4 sum = bright(q);
  float total = 1.0;
  for (int r = 1; r <= RINGS; r++) {
    float radius = SIGMA * 2.5 * float(r) / float(RINGS);
    float w = exp(-0.5 * radius * radius / max(SIGMA * SIGMA, 1e-6)) * float(r);
    for (int k = 0; k < PER_RING; k++) {
      float a = (float(k) + 0.5 * float(r)) / float(PER_RING) * 6.283185307179586;
      sum += w * bright(q + radius * vec2(cos(a), sin(a)));
      total += w;
    }
  }
  vec4 g = clamp(sum / total * u_intensity, 0.0, 1.0);
  g.rgb = min(g.rgb, vec3(g.a));
  vec4 o = at(q);
  vec4 result = ${blend};
  gl_FragColor = vec4(min(clamp(result.rgb, 0.0, 1.0), vec3(result.a)), clamp(result.a, 0.0, 1.0));
}`,
      variables: [
        ["u_threshold", clamp01(p.num(2, 153) / 255)],
        ["u_intensity", Math.max(0, p.num(4, 1))],
      ],
    };
  },
  "ADBE Drop Shadow": (p, size) => {
    const angle = p.num(3, 135) * DEG;
    const distance = Math.max(0, p.num(4, 5)) * p.scale;
    const sigma = (Math.max(0, p.num(5, 0)) / 2.4) * p.scale;
    return {
      body: `${space(size)}${RING_TAPS}const vec2 OFFSET = ${vec([Math.sin(angle) * distance, -Math.cos(angle) * distance])};
const vec3 SHADOW = ${vec(p.rgb(1, [0, 0, 0]))};
const float SIGMA = ${f(sigma)};
const int ONLY = ${p.num(6, 0) !== 0 ? 1 : 0};
uniform float u_opacity;
void main() {
  vec2 q = here();
  float sum = at(q - OFFSET).a;
  float total = 1.0;
  for (int r = 1; r <= RINGS; r++) {
    float radius = SIGMA * 2.5 * float(r) / float(RINGS);
    float w = exp(-0.5 * radius * radius / max(SIGMA * SIGMA, 1e-6)) * float(r);
    for (int k = 0; k < PER_RING; k++) {
      float a = (float(k) + 0.5 * float(r)) / float(PER_RING) * 6.283185307179586;
      sum += w * at(q - OFFSET + radius * vec2(cos(a), sin(a))).a;
      total += w;
    }
  }
  float a = sum / total * u_opacity;
  vec4 s = vec4(SHADOW * a, a);
  vec4 o = at(q);
  gl_FragColor = ONLY == 1 ? s : o + s * (1.0 - o.a);
}`,
      variables: [["u_opacity", clamp01(p.num(2, 127.5) / 255)]],
    };
  },
  "ADBE Sharpen": (p, size) => ({
    body: `${space(size)}uniform float u_amount;
void main() {
  vec2 q = here();
  vec4 c = at(q);
  vec4 n = at(q + vec2(0.0, 1.0)) + at(q - vec2(0.0, 1.0)) + at(q + vec2(1.0, 0.0)) + at(q - vec2(1.0, 0.0));
  vec4 r = clamp(c + u_amount * (4.0 * c - n), 0.0, 1.0);
  gl_FragColor = vec4(min(r.rgb, vec3(r.a)), r.a);
}`,
    variables: [["u_amount", Math.max(0, p.num(1, 0)) / 100]],
  }),
};
GENERATORS["ADBE Threshold"] = GENERATORS["ADBE Threshold2"];

/** Effects this file draws as Avee shaders. */
export const SHADER_EFFECTS = new Set(Object.keys(GENERATORS));

/**
 * The Avee shader for an effect, over a composition of `size` pixels, or
 * undefined for effects it cannot draw. `settings` collects what the shader
 * read, for restoring the effect.
 */
export function effectShader(matchName: string, p: EffectReader, size: number[]): AveeShader | undefined {
  const generator = GENERATORS[matchName];
  if (!generator) return undefined;
  const settings: Settings = {};
  const recording: EffectReader = {
    scale: p.scale,
    num: (n, fallback) => {
      const v = p.num(n, fallback);
      settings[n] = { kind: "number", value: v };
      return v;
    },
    rgb: (n, fallback) => {
      const v = p.rgb(n, fallback).slice(0, 3);
      settings[n] = { kind: "color", value: v };
      return v;
    },
    point: (n, fallback) => {
      const v = p.point(n, fallback).slice(0, 2);
      settings[n] = { kind: "point", value: [v[0] / size[0], v[1] / size[1]] };
      return v;
    },
  };
  const made = generator(recording, size);
  if (!made) return undefined;
  const header = `${MARKER}${matchName} | ${JSON.stringify(settings)}
precision highp float;
uniform sampler2D u_texture;
varying vec2 vTexCoord;
`;
  return { fragment: `${header}${made.body}\n`, variables: made.variables };
}
