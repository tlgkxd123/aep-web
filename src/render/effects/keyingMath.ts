// Per-pixel models of the Keying effects (keying.ts mirrors them in GLSL), fitted to After Effects' renders of the
// keying fixtures' palette (scripts/check-keying-fit.ts). Colours are straight RGB 0-1; a model returns the share
// of the pixel's alpha it keeps.

export type RGB = [number, number, number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function rgbToHsl([r, g, b]: number[]): RGB {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d <= 1e-6) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

export const luma = ([r, g, b]: number[]) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Rec. 601 luma of an 8-bit colour in 16-bit fixed point, rounded to a whole step. */
export const luma8 = ([r, g, b]: number[]) => Math.floor((19595 * r + 38470 * g + 7471 * b + 32768) / 65536);

/** Linear Color Key's Match Colors popup. */
export const MatchColors = { RGB: 1, HUE: 2, CHROMA: 3 } as const;

export interface LinearKeySettings {
  key: number[];
  match: number;
  /** Matching Tolerance and Softness, 0-1. */
  tolerance: number;
  softness: number;
  /** Key Operation = Keep Colors. */
  keep: boolean;
}

/** How far a colour is from the key in Linear Color Key's space, 0-1. */
export function linearKeyDistance(s: number[], key: number[], match: number): number {
  if (match === MatchColors.HUE) {
    // Hues are compared in whole 1/255 turns.
    const h = Math.round(rgbToHsl(s)[0] * 255);
    const k = Math.round(rgbToHsl(key)[0] * 255);
    const d = Math.abs(h - k) % 255;
    return (Math.min(d, 255 - d) * 2) / 255;
  }
  if (match === MatchColors.CHROMA) {
    // Differences between channels only: adding grey to a colour does not move it.
    const d = [s[0] - key[0], s[1] - key[1], s[2] - key[2]];
    const [rg, rb, gb] = CHROMA_WEIGHTS;
    return Math.sqrt(rg * (d[0] - d[1]) ** 2 + rb * (d[0] - d[2]) ** 2 + gb * (d[1] - d[2]) ** 2);
  }
  return Math.hypot(s[0] - key[0], s[1] - key[1], s[2] - key[2]) / Math.sqrt(3);
}

/**
 * Using Chroma's weights of the red-green, red-blue and green-blue differences. After Effects' own distance depends
 * on the key a little (within about 5/255 of the matte over a ramp); these fit keys across the hue circle.
 */
export const CHROMA_WEIGHTS = [0.10902, 0.03745, 0.04379];

/** Per Match Colors: the squared distance past the tolerance at which Matching Softness 100 % turns opaque. */
export const LINEAR_SOFTNESS: Record<number, number> = {
  [MatchColors.RGB]: 0.672,
  [MatchColors.HUE]: 1.1636,
  [MatchColors.CHROMA]: 0.41231,
};
/** Per Match Colors: Matching Tolerance 100 % as a distance. */
export const LINEAR_TOLERANCE: Record<number, number> = {
  [MatchColors.RGB]: 255.5 / 255,
  [MatchColors.HUE]: 1,
  [MatchColors.CHROMA]: 1.00806,
};

/** The share of the colour Linear Color Key keys out: 0 matches the key, 1 does not. */
export function linearKey(s: number[], o: LinearKeySettings): number {
  const d = linearKeyDistance(s, o.key, o.match);
  // Without softness a hue difference matches up to the tolerance's next whole step.
  const t = o.tolerance * LINEAR_TOLERANCE[o.match] + (o.match === MatchColors.HUE && o.softness <= 0 ? 1 / 255 : 0);
  const e = d * d - t * t;
  return o.softness > 0 ? clamp01(e / (LINEAR_SOFTNESS[o.match] * o.softness)) : e > 0 ? 1 : 0;
}

/** The alpha Linear Color Key leaves: Key Colors keeps `m` of it, Keep Colors restores the matching colours. */
export function linearKeyAlpha(alpha: number, m: number, keep: boolean): number {
  return keep ? alpha + (1 - alpha) * (1 - m) : alpha * m;
}

/**
 * Color Key: the colours within Color Tolerance of the key, as a distance in 0-255 RGB, are keyed out. `alpha` is the
 * pixel's: a partly transparent 8-bit pixel's straight colour is only known to within half a step of its premultiplied
 * value, and the nearest colour of that range is compared.
 */
export function colorKey(s: number[], alpha: number, key: number[], tolerance: number): number {
  const spread = alpha < 1 ? 0.5 / alpha : 0;
  const d = Math.hypot(...[0, 1, 2].map((c) => Math.max(0, Math.abs(s[c] - key[c]) * 255 - spread)));
  return d <= tolerance + 1e-3 ? 0 : 1;
}

/** Luma Key's Key Type popup. */
export const LumaKeyType = { BRIGHTER: 1, DARKER: 2, SIMILAR: 3, DISSIMILAR: 4 } as const;

/** Luma Key's luminance of an 8-bit colour, times 100: whole numbers, so that ties with the threshold are exact. */
export const keyLuma100 = ([r, g, b]: number[]) => 30 * r + 59 * g + 11 * b;

/** Luma Key with Threshold and Tolerance in 0-255, on the straight colour rounded to whole 8-bit steps. */
export function lumaKey(s: number[], type: number, threshold: number, tolerance: number): number {
  const l = keyLuma100(s.map((v) => Math.round(clamp01(v) * 255)));
  const t = threshold * 100;
  if (type === LumaKeyType.BRIGHTER) return l > t ? 0 : 1;
  if (type === LumaKeyType.DARKER) return l < t ? 0 : 1;
  const d = Math.abs(l - t);
  return type === LumaKeyType.SIMILAR ? (d < tolerance * 100 ? 0 : 1) : d > tolerance * 100 ? 0 : 1;
}

/** Extract's Channel popup. */
export const ExtractChannel = { LUMINANCE: 1, RED: 2, GREEN: 3, BLUE: 4, ALPHA: 5 } as const;

export interface ExtractSettings {
  channel: number;
  /** Black and White Point and their softness, 0-255. */
  black: number;
  white: number;
  blackSoftness: number;
  whiteSoftness: number;
  invert: boolean;
}

/**
 * Extract keeps the channel values (whole 8-bit steps) between the black and white points, ramped over the softness
 * outside them. The white point's ramp wins from the white point up, even when the black point is above it.
 */
export function extract(s: number[], alpha: number, o: ExtractSettings): number {
  const s8 = s.map((c) => Math.round(clamp01(c) * 255));
  const v = o.channel === ExtractChannel.ALPHA ? Math.round(alpha * 255) : o.channel === ExtractChannel.LUMINANCE ? luma8(s8) : s8[o.channel - 2];
  let m: number;
  if (v >= o.white) m = v === o.white ? 1 : o.whiteSoftness > 0 ? clamp01(1 - (v - o.white) / o.whiteSoftness) : 0;
  else if (v < o.black) m = o.blackSoftness > 0 ? clamp01(1 - (o.black - v) / o.blackSoftness) : 0;
  else m = 1;
  return o.invert ? 1 - m : m;
}

/** Color Range's Color Space popup. */
export const RangeSpace = { LAB: 1, YUV: 2, RGB: 3 } as const;

/** A colour in Color Range's space, each channel 0-255. */
export function rangeCoordinates(s: number[], space: number): RGB {
  if (space === RangeSpace.RGB) return [s[0] * 255, s[1] * 255, s[2] * 255];
  if (space === RangeSpace.YUV) {
    const y = luma(s);
    return [y * 255, ((s[2] - y) * 0.565 + 0.5) * 255, ((s[0] - y) * 0.713 + 0.5) * 255];
  }
  const lin = s.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047;
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const L = 116 * f(y) - 16;
  return [(L / 100) * 255, 500 * (f(x) - f(y)) + 128, 200 * (f(y) - f(z)) + 128];
}

/** Color Range's ease from keyed to kept over Fuzziness, `x` the distance outside the box over Fuzziness. */
const rangeEase = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x));

/**
 * Color Range keys out the box of `min`..`max` (0-255 per channel), softened outside it over Fuzziness on each
 * channel; a colour outside on several channels keeps what none of them keys.
 */
export function colorRange(s: number[], space: number, min: number[], max: number[], fuzziness: number): number {
  const c = rangeCoordinates(s, space);
  let keyed = 1;
  for (let i = 0; i < 3; i++) {
    const d = Math.max(min[i] - c[i], c[i] - max[i]);
    keyed *= 1 - (fuzziness > 0 ? rangeEase(d / fuzziness) : d > 0 ? 1 : 0);
  }
  return 1 - keyed;
}

/**
 * Spill Suppressor: the key colour's dominant channel lowered by Suppression / 100 times its excess over the channel
 * before it (red under blue, green under red, blue under green), past it above 100 %, down to 0.
 */
export function spillSuppress(s: number[], key: number[], suppression: number): RGB {
  const p = key[1] >= key[0] && key[1] >= key[2] ? 1 : key[2] >= key[0] ? 2 : 0;
  const out = [...s] as RGB;
  const spill = Math.max(0, s[p] - s[(p + 2) % 3]);
  out[p] = Math.max(0, s[p] - suppression * spill);
  return out;
}

/** Advanced Spill Suppressor's Standard method: green limited towards the mean of red and blue, whatever the key. */
export function spillStandard(s: number[], suppression: number): RGB {
  return [s[0], s[1] - suppression * Math.max(0, s[1] - (s[0] + s[2]) / 2), s[2]];
}
