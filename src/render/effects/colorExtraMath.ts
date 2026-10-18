// Per-pixel models of the Color Correction effects in colorExtra.ts, on straight colour
// fractions (alpha last): the formulas the shaders follow, as measured against After
// Effects renders (scripts/check-color2-probe.ts).
import type { Layer, PropertyGroup } from "../../aep/model.ts";
import { findChild, type Chunk } from "../../aep/riff.ts";
import type { Params } from "./stockUtil.ts";

export type Rgba = [number, number, number, number];
export type ColorModel = (p: Params, layer: Layer, time: number, effect: PropertyGroup) => (c: Rgba) => Rgba;

export const COLOR_MODELS: Record<string, ColorModel> = {};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const tdmnText = (c: Chunk) => new TextDecoder().decode(c.data).replace(/\0[\s\S]*$/, "");

/** The arbitrary data (aRbp) an effect instance stores for parameter `n`, not its definition's default. */
export function instanceData(effect: PropertyGroup, n: number): Uint8Array | undefined {
  const name = `${effect.matchName}-${String(n).padStart(4, "0")}`;
  let found: Uint8Array | undefined;
  const visit = (children: Chunk[]) => {
    let current = "";
    for (const c of children) {
      if (found) return;
      if (c.type === "tdmn") current = tdmnText(c);
      else if (c.type === "LIST" && c.listType === "aRbs" && current === name) found = findChild(c, "aRbp")?.data;
      else if (c.children && c.listType !== "parT") visit(c.children);
    }
  };
  visit(effect.chunk?.children ?? []);
  return found;
}

/** Curves' tables: five of 256 bytes after a 4-byte header, in the order of CURVES_TABLE. */
export const CURVES_TABLES = 5;
export const CURVES_HEADER = 4;

export function curvesTables(data: Uint8Array | undefined): Uint8Array {
  const out = new Uint8Array(CURVES_TABLES * 256);
  if (data && data.length >= CURVES_HEADER + out.length) out.set(data.subarray(CURVES_HEADER, CURVES_HEADER + out.length));
  else for (let t = 0; t < CURVES_TABLES; t++) for (let i = 0; i < 256; i++) out[t * 256 + i] = i;
  return out;
}

/** Which table applies to which channel, and in which order (RGB master, red, green, blue, alpha). */
export const CURVES_TABLE = { rgb: 0, red: 1, green: 2, blue: 3, alpha: 4 } as const;

const lut = (tables: Uint8Array, t: number, v: number) => tables[t * 256 + Math.round(clamp01(v) * 255)] / 255;

COLOR_MODELS["ADBE CurvesCustom"] = (_p, _l, _t, effect) => {
  const tables = curvesTables(instanceData(effect, 1));
  const T = CURVES_TABLE;
  return ([r, g, b, a]) => [lut(tables, T.rgb, lut(tables, T.red, r)), lut(tables, T.rgb, lut(tables, T.green, g)), lut(tables, T.rgb, lut(tables, T.blue, b)), lut(tables, T.alpha, a)];
};

/** A Colorama output cycle entry: its place in the cycle (0..1) and straight RGBA. */
export interface CycleEntry {
  at: number;
  rgba: Rgba;
}

/** Colorama's output cycle: up to 64 entries of 8 bytes (a big-endian u32 place of 65536ths, then A, R, G, B), their count at 512. */
export function coloramaCycle(data: Uint8Array | undefined): CycleEntry[] {
  if (!data || data.length < 516) return [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = Math.min(64, view.getUint32(512, false));
  const out: CycleEntry[] = [];
  for (let k = 0; k < n; k++) {
    const o = k * 8;
    out.push({ at: view.getUint32(o, false) / 65536, rgba: [data[o + 5] / 255, data[o + 6] / 255, data[o + 7] / 255, data[o + 4] / 255] });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function rgbToHsl([r, g, b]: readonly number[]): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d <= 1e-6) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

const hue2rgb = (p: number, q: number, t: number) => {
  t -= Math.floor(t);
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 0.5) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};

export function hslToRgb([h, s, l]: readonly number[]): [number, number, number] {
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

/** Colorama's Get Phase From sources (1-based popup): intensity, red, green, blue, hue, lightness, saturation, value, alpha, zero. */
export function coloramaPhase(source: number, [r, g, b, a]: Rgba): number {
  switch (source) {
    case 1:
      return (r + g + b) / 3;
    case 2:
      return r;
    case 3:
      return g;
    case 4:
      return b;
    case 5:
      return rgbToHsl([r, g, b])[0];
    case 6:
      return rgbToHsl([r, g, b])[2];
    case 7:
      return rgbToHsl([r, g, b])[1];
    case 8:
      return Math.max(r, g, b);
    case 9:
      return a;
    default:
      return 0;
  }
}

/** The cycle's colour at `t` (0..1, wrapping), interpolated between entries or the nearest entry's. */
export function cycleAt(cycle: CycleEntry[], t: number, interpolate: boolean): Rgba {
  if (!cycle.length) return [0, 0, 0, 1];
  t -= Math.floor(t);
  let k = cycle.length - 1;
  for (let i = 0; i < cycle.length; i++) if (cycle[i].at <= t) k = i;
  const a = cycle[k];
  const b = cycle[(k + 1) % cycle.length];
  let span = b.at - a.at;
  let d = t - a.at;
  if (span <= 0) span += 1;
  if (d < 0) d += 1;
  const w = span > 0 ? d / span : 0;
  if (!interpolate) return w < 0.5 ? a.rgba : b.rgba;
  return a.rgba.map((v, i) => v + (b.rgba[i] - v) * w) as Rgba;
}

/** Colorama's input phase spans 255.5 8-bit steps per cycle, so white stays just short of a whole cycle. */
export const COLORAMA_PHASE_SCALE = 255 / 255.5;

/**
 * Colorama's Modify popup: the RGB channels (bits 1, 2, 4) or HSL components (bits 8 hue, 16 lightness,
 * 32 saturation) the output cycle replaces.
 */
export const COLORAMA_MODIFY: Record<number, number> = { 1: 7, 2: 1, 3: 2, 4: 4, 5: 3, 6: 6, 7: 5, 8: 8, 9: 16, 10: 32, 11: 24, 12: 48, 13: 40, 14: 0 };

export function coloramaModify(mask: number, c: readonly number[], out: readonly number[]): number[] {
  if (mask < 8) return [0, 1, 2].map((i) => (mask & (1 << i) ? out[i] : c[i]));
  const a = rgbToHsl(c);
  const b = rgbToHsl(out);
  return hslToRgb([mask & 8 ? b[0] : a[0], mask & 32 ? b[1] : a[1], mask & 16 ? b[2] : a[2]]);
}

COLOR_MODELS["APC Colorama"] = (p, _l, _t, effect) => {
  const cycle = coloramaCycle(instanceData(effect, 12));
  const source = p.num(2, 1);
  const shift = p.num(8, 0) / 360;
  const repeats = p.num(38, 1);
  const interpolate = p.bool(14, true);
  const modify = COLORAMA_MODIFY[p.choice(16, 1)] ?? 7;
  const blend = p.num(36, 0) / 100;
  return (c) => {
    const phase = (coloramaPhase(source, c) * COLORAMA_PHASE_SCALE + shift) * repeats;
    const out = coloramaModify(modify, c, cycleAt(cycle, phase, interpolate));
    return [0, 1, 2].map((i) => out[i] + (c[i] - out[i]) * blend).concat(c[3]) as Rgba;
  };
};

export const luma601 = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** CC Toner's tones from dark to light for its Tones popup (1 duotone, 2 tritone, 3 pentone, 5 solid). */
export function tonerStops(p: Params): number[][] {
  const hi = p.rgb(1, [1, 1, 1]);
  const bright = p.rgb(6, [0.75, 0.67, 0.47]);
  const mid = p.rgb(2, [0.5, 0.39, 0.27]);
  const dark = p.rgb(7, [0.25, 0.2, 0.04]);
  const shadow = p.rgb(3, [0, 0, 0]);
  switch (p.choice(5, 2)) {
    case 1:
      return [shadow, hi];
    case 3:
      return [shadow, dark, mid, bright, hi];
    case 4:
      return [mid];
    default:
      return [shadow, mid, hi];
  }
}

export function tonerAt(stops: number[][], l: number): number[] {
  if (stops.length === 1) return stops[0];
  const x = clamp01(l) * (stops.length - 1);
  const k = Math.min(stops.length - 2, Math.floor(x));
  const w = x - k;
  return stops[k].map((v, i) => v + (stops[k + 1][i] - v) * w);
}

COLOR_MODELS["CC Toner"] = (p) => {
  const stops = tonerStops(p);
  const blend = clamp01(p.num(4, 0));
  return ([r, g, b, a]) => {
    const t = tonerAt(stops, luma601(r, g, b));
    return [t[0] + (r - t[0]) * blend, t[1] + (g - t[1]) * blend, t[2] + (b - t[2]) * blend, a];
  };
};

/**
 * CC Color Offset on one channel, shifted by `phase` turns: wrapped (1), folded back (2, solarize), or as the angle
 * acos(1 - 2v) turned by half the phase (3, polarize).
 */
export function colorOffset(v: number, phase: number, overflow: number): number {
  if (overflow === 3) return (1 - Math.cos(Math.acos(1 - 2 * clamp01(v)) + Math.PI * phase)) / 2;
  const x = v + phase;
  if (overflow === 1) return x > 1 ? x - Math.ceil(x - 1) : x < 0 ? x - Math.floor(x) : x;
  const f = x - 2 * Math.floor(x / 2);
  return f <= 1 ? f : 2 - f;
}

COLOR_MODELS["CC Color Offset"] = (p) => {
  const phases = [1, 2, 3].map((n) => p.num(n, 0) / 360);
  const overflow = p.choice(4, 2);
  return ([r, g, b, a]) => [colorOffset(r, phases[0], overflow), colorOffset(g, phases[1], overflow), colorOffset(b, phases[2], overflow), a];
};

/** Gamma/Pedestal/Gain's Black Stretch: shadows below 0.5 lifted with slope `stretch` at black. */
export const blackStretch = (v: number, stretch: number) => (v >= 0 && v < 0.5 ? v + (stretch - 1) * v * (1 - 2 * v) ** 2 : v);

COLOR_MODELS["ADBE Gamma/Pedestal/Gain2"] = (p) => {
  const stretch = p.num(1, 1);
  const ch = [2, 5, 8].map((n) => [p.num(n, 1), p.num(n + 1, 0), p.num(n + 2, 1)]);
  return ([r, g, b, a]) => {
    const f = (v: number, [gamma, ped, gain]: number[]) => blackStretch(ped + (gain - ped) * v ** (1 / gamma), stretch);
    return [f(r, ch[0]), f(g, ch[1]), f(b, ch[2]), a];
  };
};

/** The slope of a Color Balance power below which its curve leaves x^p for the toe of `balancePow`. */
export const BALANCE_TOE_SLOPE = 1.4;

/**
 * Color Balance's power curve: x^p, except that a power below 1 turns, where its slope reaches BALANCE_TOE_SLOPE,
 * into the parabola through 0 tangent to it there.
 */
export function balancePow(x: number, p: number): number {
  if (p >= 1) return x ** p;
  const x0 = (BALANCE_TOE_SLOPE / p) ** (1 / (p - 1));
  if (x >= x0) return x ** p;
  return (2 - p) * x0 ** (p - 1) * x + (p - 1) * x0 ** (p - 2) * x * x;
}

/**
 * Color Balance on one channel from its shadow, midtone and highlight balances (-1..1): the linear stretches of
 * negative shadows and positive highlights, then one toed power, the product of the highlight, midtone and shadow
 * powers. Preserve Luminosity drops the shadow and highlight powers.
 */
export function colorBalanceChannel(v: number, shadow: number, mid: number, high: number, preserve = false): number {
  const lo = -0.4 * Math.min(shadow, 0);
  const hi = 1 - 0.4 * Math.max(high, 0);
  const x = clamp01((clamp01(v) - lo) / (hi - lo));
  return balancePow(x, preserve ? 2 ** -mid : 1.4 ** -high * 2 ** -mid * 1.4 ** -shadow);
}

/**
 * Color Balance's nine balances (shadow RGB, midtone RGB, highlight RGB, -1..1). Preserve Luminosity shifts each
 * range's three balances: shadows by their largest, highlights by their smallest, midtones by the midpoint of both.
 */
export function colorBalanceSliders(p: Params): number[] {
  const v = Array.from({ length: 9 }, (_, i) => p.num(i + 1, 0) / 100);
  if (!p.bool(10, false)) return v;
  return v.map((x, i) => {
    const range = v.slice(i - (i % 3), i - (i % 3) + 3);
    const hi = Math.max(...range), lo = Math.min(...range);
    return x - (i < 3 ? hi : i < 6 ? (hi + lo) / 2 : lo);
  });
}

COLOR_MODELS["ADBE Color Balance 2"] = (p) => {
  const v = colorBalanceSliders(p);
  const preserve = p.bool(10, false);
  return ([r, g, b, a]) => {
    const out = [r, g, b].map((c, i) => colorBalanceChannel(c, v[i], v[3 + i], v[6 + i], preserve));
    return [out[0], out[1], out[2], a];
  };
};

const smoothstep01 = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Color Neutralizer's shadow, midtone and highlight weights at a pixel's RGB mean, between its black and white points. */
export function neutralizerWeights(mean: number, black = 0, white = 1): [number, number, number] {
  const x = (mean - black) / Math.max(white - black, 1e-6);
  const shadow = smoothstep01(1 - 2 * x);
  const high = smoothstep01(2 * x - 1);
  return [shadow, 1 - shadow - high, high];
}

/**
 * Color Neutralizer's offsets per range (shadows, midtones, highlights; RGB each), zero-sum within a range and
 * scaled down by Blend w. Original.
 */
export function neutralizerOffsets(p: Params): number[][] {
  const keep = 1 - clamp01(p.num(20, 0) / 100);
  return [3, 9, 15].map((n) => {
    const v = [0, 1, 2].map((k) => p.num(n + k, 0) / 200);
    const mean = (v[0] + v[1] + v[2]) / 3;
    return v.map((x) => (x - mean) * keep);
  });
}

COLOR_MODELS["CS Color Neutralizer"] = (p) => {
  const offsets = neutralizerOffsets(p);
  const black = p.num(23, 0) / 100;
  const white = p.num(24, 100) / 100;
  return ([r, g, b, a]) => {
    const w = neutralizerWeights((r + g + b) / 3, black, white);
    const out = [r, g, b].map((c, i) => clamp01(c + w[0] * offsets[0][i] + w[1] * offsets[1][i] + w[2] * offsets[2][i]));
    return [out[0], out[1], out[2], a];
  };
};

export const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** sRGB (linear) to XYZ adapted to D50, rows X, Y, Z. */
const SRGB_D50 = [
  [0.4361, 0.3851, 0.1431],
  [0.2225, 0.7169, 0.0606],
  [0.0139, 0.0971, 0.7141],
];

function invert3(m: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

const SRGB_D50_INVERSE = invert3(SRGB_D50);

/** A colour's filter at full density: its D50 XYZ relative to white's. */
const xyzFilter = (rgb: readonly number[]) => {
  const lin = rgb.map((v) => srgbToLinear(clamp01(v)));
  return SRGB_D50.map((row) => (row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]) / (row[0] + row[1] + row[2]));
};

/**
 * Photo Filter's presets (1-based popup, Custom past them) at full density, as XYZ relative to white: an 8-bit sRGB
 * colour where one renders like the preset, measured factors where the preset lies outside sRGB.
 */
export const PHOTO_FILTER_PRESETS: readonly (readonly number[])[] = [
  [0.4743, 0.367, 0],
  [0.546, 0.4277, 0.002],
  xyzFilter([235 / 255, 177 / 255, 19 / 255]),
  [0.1777, 0.1457, 1.4847],
  [0.2723, 0.1683, 1.5757],
  [0.1627, 0.2927, 1.9943],
  xyzFilter([234 / 255, 26 / 255, 26 / 255]),
  xyzFilter([243 / 255, 132 / 255, 23 / 255]),
  xyzFilter([249 / 255, 227 / 255, 28 / 255]),
  xyzFilter([25 / 255, 201 / 255, 25 / 255]),
  xyzFilter([29 / 255, 203 / 255, 234 / 255]),
  xyzFilter([29 / 255, 53 / 255, 234 / 255]),
  xyzFilter([155 / 255, 29 / 255, 234 / 255]),
  xyzFilter([227 / 255, 24 / 255, 227 / 255]),
  xyzFilter([172 / 255, 122 / 255, 51 / 255]),
  [0.533, 0.196, 0],
  [0.0352, 0.0183, 0.5307],
  [0.022, 0.149, 0.001],
  [0.7144, 0.7001, 0.024],
  [0.2714, 0.4077, 0.4414],
];

/**
 * Photo Filter's colour as a matrix on linear sRGB, row-major: the filter (mixed with white by Density, in linear
 * light) multiplies XYZ relative to the white.
 */
export function photoFilterMatrix(p: Params): number[] {
  const full = PHOTO_FILTER_PRESETS[p.choice(1, 1) - 1] ?? xyzFilter(p.rgb(2, [0.93, 0.54, 0]));
  const d = clamp01(p.num(3, 25) / 100);
  const s = full.map((v) => 1 - d + d * v);
  const out: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) out.push(SRGB_D50_INVERSE[i].reduce((sum, v, k) => sum + v * s[k] * SRGB_D50[k][j], 0));
  return out;
}

/** The luminance weights of Preserve Luminosity, on encoded values. */
export const PHOTO_FILTER_LUMA = [0.3, 0.59, 0.11] as const;

/** `c` given the luminance `l` (on PHOTO_FILTER_LUMA), its hue kept and clipped toward grey into 0..1. */
export function setLuminance(c: number[], l: number): number[] {
  const lum = (x: number[]) => x[0] * PHOTO_FILTER_LUMA[0] + x[1] * PHOTO_FILTER_LUMA[1] + x[2] * PHOTO_FILTER_LUMA[2];
  const d = l - lum(c);
  let out = c.map((v) => v + d);
  const m = lum(out);
  const lo = Math.min(...out);
  const hi = Math.max(...out);
  if (lo < 0) out = out.map((v) => m + ((v - m) * m) / (m - lo));
  if (hi > 1) out = out.map((v) => m + ((v - m) * (1 - m)) / (hi - m));
  return out;
}

COLOR_MODELS["ADBE PhotoFilterPS"] = (p) => {
  const m = photoFilterMatrix(p);
  const preserve = p.bool(4, true);
  return ([r, g, b, a]) => {
    const lin = [r, g, b].map(srgbToLinear);
    let out = [0, 1, 2].map((i) => linearToSrgb(clamp01(m[i * 3] * lin[0] + m[i * 3 + 1] * lin[1] + m[i * 3 + 2] * lin[2])));
    if (preserve) {
      const l = r * PHOTO_FILTER_LUMA[0] + g * PHOTO_FILTER_LUMA[1] + b * PHOTO_FILTER_LUMA[2];
      out = setLuminance(out, l);
    }
    return [out[0], out[1], out[2], a];
  };
};

/** Selective Color's groups (reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks) start at these parameters. */
export const SELECTIVE_GROUPS = [9, 15, 21, 27, 33, 39, 45, 51, 57] as const;

/** How much each of Selective Color's groups holds of a colour. */
export function selectiveWeights([r, g, b]: readonly number[]): number[] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const md = r + g + b - mx - mn;
  const primary = (c: number) => (c === mx && mx > mn ? mx - md : 0);
  const secondary = (c: number) => (c === mn && mx > mn ? md - mn : 0);
  return [
    primary(r),
    secondary(b),
    primary(g),
    secondary(r),
    primary(b),
    secondary(g),
    mn > 0.5 ? (mn - 0.5) * 2 : 0,
    1 - (Math.abs(mx - 0.5) + Math.abs(mn - 0.5)),
    mx < 0.5 ? (0.5 - mx) * 2 : 0,
  ];
}

COLOR_MODELS["ADBE SelectiveColor"] = (p) => {
  const relative = p.choice(1, 1) === 1;
  const groups = SELECTIVE_GROUPS.map((n) => [0, 1, 2, 3].map((k) => p.num(n + k, 0) / 100));
  return ([r, g, b, a]) => {
    const w = selectiveWeights([r, g, b]);
    const out = [r, g, b].map((v, c) => {
      let d = 0;
      groups.forEach((adj, k) => {
        if (!w[k]) return;
        const change = (-1 - adj[c]) * adj[3] - adj[c];
        d += w[k] * Math.min(1 - v, Math.max(-v, relative ? change * (1 - v) : change));
      });
      return clamp01(v + d);
    });
    return [out[0], out[1], out[2], a];
  };
};

/** How colour keys (Leave Color, Change Color) measure a colour against the key colour (their Match Colors popup). */
export const KeyMetric = { Rgb: 1, Hue: 2, Chroma: 3 } as const;

const uv = ([r, g, b]: readonly number[]) => [-0.147 * r - 0.289 * g + 0.436 * b, 0.615 * r - 0.515 * g - 0.1 * b];

/** The softness falloff's scale per metric: a key fades out as (d² - tolerance²) / (scale · softness). */
export const KEY_SOFTNESS: Record<number, number> = { [KeyMetric.Rgb]: 2 / 3, [KeyMetric.Hue]: 1.16, [KeyMetric.Chroma]: 2 / 3 };
/** Chroma distances (YUV's UV plane) per unit of tolerance. */
export const CHROMA_SCALE = 1.6;

/** A colour's distance from the key, against tolerance: RGB over its diagonal, HSL hue per half turn, or chroma. */
export function keyDistance(metric: number, c: readonly number[], key: readonly number[]): number {
  if (metric === KeyMetric.Hue) {
    const d = Math.abs(rgbToHsl(c)[0] - rgbToHsl(key)[0]);
    return 2 * Math.min(d, 1 - d);
  }
  if (metric === KeyMetric.Chroma) {
    const a = uv(c);
    const b = uv(key);
    return Math.hypot(a[0] - b[0], a[1] - b[1]) / CHROMA_SCALE;
  }
  return (Math.hypot(c[0] - key[0], c[1] - key[1], c[2] - key[2]) * RGB_KEY_SCALE) / Math.sqrt(3);
}

/** RGB key distances are measured in 8-bit steps over 256 per unit. */
export const RGB_KEY_SCALE = 255 / 256;

/** How much a colour at `d` matches the key: 1 within tolerance, fading out over the softness. */
export function keyMatch(metric: number, d: number, tolerance: number, softness: number): number {
  if (d <= tolerance) return 1;
  if (softness <= 0) return 0;
  const scale = KEY_SOFTNESS[metric] ?? KEY_SOFTNESS[KeyMetric.Rgb];
  return 1 - clamp01((d * d - tolerance * tolerance) / (scale * softness));
}

/** The luminance colour keys decolour toward. */
export const KEY_LUMA = [0.3, 0.59, 0.11] as const;

COLOR_MODELS["ADBE Leave Color"] = (p) => {
  const amount = clamp01(p.num(1, 0) / 100);
  const key = p.rgb(2, [1, 0, 0]);
  const tolerance = p.num(3, 15) / 100;
  const softness = p.num(4, 0) / 100;
  const metric = p.choice(5, 1);
  return ([r, g, b, a]) => {
    const f = amount * (1 - keyMatch(metric, keyDistance(metric, [r, g, b], key), tolerance, softness));
    const y = KEY_LUMA[0] * r + KEY_LUMA[1] * g + KEY_LUMA[2] * b;
    return [r + (y - r) * f, g + (y - g) * f, b + (y - b) * f, a];
  };
};

COLOR_MODELS["ADBE Change Color"] = (p) => {
  const view = p.choice(1, 1);
  const hue = p.num(2, 0) / 360;
  const lightness = p.num(3, 0) / 100;
  const saturation = p.num(4, 0) / 100;
  const key = p.rgb(5, [1, 0, 0]);
  const tolerance = p.num(6, 15) / 100;
  const softness = p.num(7, 0) / 100;
  const metric = p.choice(8, 1);
  const invert = p.bool(9, false);
  return ([r, g, b, a]) => {
    let m = keyMatch(metric, keyDistance(metric, [r, g, b], key), tolerance, softness);
    if (invert) m = 1 - m;
    if (view === 2) return m >= 0.5 / 255 ? [m, m, m, a] : [0, 0, 0, 0];
    const [h, s, l] = rgbToHsl([r, g, b]);
    const t = hslToRgb([h + hue, clamp01(s + saturation), clamp01(l + lightness)]);
    return [r + (t[0] - r) * m, g + (t[1] - g) * m, b + (t[2] - b) * m, a];
  };
};

/**
 * Change To Color's correction matte from the HSL distances to the From colour (hue in turns, wrapped) and the
 * hue, lightness and saturation tolerances and softness (fractions).
 */
export function changeToColorMatte(dh: number, dl: number, ds: number, tol: readonly number[], softness: number): number {
  const d = (2 * dh) / Math.max(tol[0], 1e-6) + (dl / Math.max(tol[1], 1e-6) + ds / Math.max(tol[2], 1e-6)) / 8;
  if (softness <= 0) return d <= 1 ? 1 : 0;
  return clamp01((1 - d) / softness);
}

/** Change To Color's Change menu: which of hue, lightness and saturation move toward the To colour. */
export const CHANGE_TO_COLOR_CHANNELS: Record<number, readonly [boolean, boolean]> = {
  1: [false, false],
  2: [true, false],
  3: [false, true],
  4: [true, true],
};

COLOR_MODELS["ADBE Change To Color"] = (p) => {
  const from = rgbToHsl(p.rgb(1, [1, 0, 0]));
  const to = rgbToHsl(p.rgb(2, [0, 0, 1]));
  const [light, sat] = CHANGE_TO_COLOR_CHANNELS[p.choice(3, 1)] ?? CHANGE_TO_COLOR_CHANNELS[1];
  const transform = p.choice(4, 1) === 2;
  const tol = [p.num(5, 0.05), p.num(6, 0.5), p.num(7, 0.5)];
  const softness = p.num(8, 0.5);
  const view = p.bool(9, false);
  return ([r, g, b, a]) => {
    const [h, s, l] = rgbToHsl([r, g, b]);
    const dh = Math.abs(h - from[0]);
    const m = changeToColorMatte(Math.min(dh, 1 - dh), Math.abs(l - from[2]), Math.abs(s - from[1]), tol, softness);
    if (view) return [m, m, m, a];
    const t = transform
      ? hslToRgb([h + (to[0] - from[0]), sat ? clamp01(s + to[1] - from[1]) : s, light ? clamp01(l + to[2] - from[2]) : l])
      : hslToRgb([to[0], sat ? to[1] : s, light ? to[2] : l]);
    return [r + (t[0] - r) * m, g + (t[1] - g) * m, b + (t[2] - b) * m, a];
  };
};

/** One channel's Levels: input black and white, gamma, output black and white (fractions). */
export type LevelsChannel = [number, number, number, number, number];

export function levelsValue(v: number, [inBlack, inWhite, gamma, outBlack, outWhite]: LevelsChannel): number {
  const span = inWhite - inBlack;
  let t = span === 0 ? (v >= inWhite ? 1 : 0) : (v - inBlack) / span;
  t = clamp01(t) ** (1 / Math.max(gamma, 1e-3));
  return clamp01(outBlack + t * (outWhite - outBlack));
}

/** Levels (Individual Controls): RGB, red, green, blue and alpha groups start at these parameters. */
export const PRO_LEVELS_GROUPS = [4, 11, 18, 25, 32] as const;

export function proLevelsChannels(p: Params): LevelsChannel[] {
  return PRO_LEVELS_GROUPS.map((b) => [p.num(b, 0), p.num(b + 1, 1), p.num(b + 2, 1), p.num(b + 3, 0), p.num(b + 4, 1)]);
}

COLOR_MODELS["ADBE Pro Levels2"] = (p) => {
  const [rgb, red, green, blue, alpha] = proLevelsChannels(p);
  return ([r, g, b, a]) => [levelsValue(levelsValue(r, red), rgb), levelsValue(levelsValue(g, green), rgb), levelsValue(levelsValue(b, blue), rgb), levelsValue(a, alpha)];
};
