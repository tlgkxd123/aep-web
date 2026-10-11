// Geometry and colour math of the stock After Effects effects, kept free of
// WebGL so it can be tested on its own. Layer points are in layer pixels, y down.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (as shapes.ts). */
export type Affine = [number, number, number, number, number, number];

export const DEG = Math.PI / 180;

export const mul = (m: Affine, n: Affine): Affine => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
const scaling = (x: number, y: number): Affine => [x, 0, 0, y, 0, 0];
const rotate = (rad: number): Affine => [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
export const applyPoint = (m: Affine, [x, y]: number[]): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function invert(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const [a, b, c, d, e, f] = m;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * Below this standard deviation (image pixels) blurs use an exact Gaussian kernel; above it, three box passes
 * of the same variance, whose cost does not grow with the radius.
 */
export const EXACT_SIGMA_LIMIT = 24;

/**
 * The standard deviation of a Gaussian Blur's (and Drop Shadow softness', Glow radius') kernel for a
 * Blurriness in pixels: the relation After Effects' mask feather follows (masks.ts). Not yet fitted to renders
 * of the effects themselves.
 */
export const blurrinessSigma = (blurriness: number) => Math.max(0, blurriness) / 2.4;

/** The half-width of a box whose three passes have variance sigma^2 (a box of 2r + 1 taps has variance r(r + 1) / 3). */
export const boxRadiusForSigma = (sigma: number) => (Math.sqrt(1 + 4 * sigma * sigma) - 1) / 2;

/** A direction angle (degrees, 0 = up, clockwise) as a unit vector in layer space (y down). */
export const directionVector = (degrees: number): [number, number] => [Math.sin(degrees * DEG), -Math.cos(degrees * DEG)];

/**
 * The Transform effect's (ADBE Geometry2) layer matrix: anchor to the origin, scale, skew along the skew axis,
 * rotate, then to Position (as a shape group's transform).
 */
export function geometryMatrix(anchor: number[], position: number[], scaleX: number, scaleY: number, skew: number, skewAxis: number, rotation: number): Affine {
  const s = skew * DEG;
  const axis = skewAxis * DEG;
  const skewM: Affine = s ? mul(rotate(-axis), mul([1, 0, Math.tan(-s), 1, 0, 0], rotate(axis))) : [1, 0, 0, 1, 0, 0];
  return mul(translate(position[0], position[1]), mul(rotate(rotation * DEG), mul(skewM, mul(scaling(scaleX / 100, scaleY / 100), translate(-anchor[0], -anchor[1])))));
}

/** 3x3 matrix, row-major. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** The projective map taking the unit square's corners (0,0), (1,0), (0,1), (1,1) to the four points. */
export function squareToQuad(p00: number[], p10: number[], p01: number[], p11: number[]): Mat3 {
  const [x0, y0] = p00;
  const [x1, y1] = p10;
  const [x2, y2] = p01;
  const [x3, y3] = p11;
  const dx1 = x1 - x3;
  const dy1 = y1 - y3;
  const dx2 = x2 - x3;
  const dy2 = y2 - y3;
  const sx = x0 - x1 - x2 + x3;
  const sy = y0 - y1 - y2 + y3;
  let g = 0;
  let h = 0;
  if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
    const det = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
  }
  return [x1 - x0 + g * x1, x2 - x0 + h * x2, x0, y1 - y0 + g * y1, y2 - y0 + h * y2, y0, g, h, 1];
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export function project(m: Mat3, [x, y]: number[]): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/**
 * Corner Pin: output layer point -> unit-square coordinates of the layer (u along the width, v down), the inverse
 * of the map taking the layer's corners to the pins. Null for a degenerate quad.
 */
export function cornerPinInverse(upperLeft: number[], upperRight: number[], lowerLeft: number[], lowerRight: number[]): Mat3 | null {
  return invert3(squareToQuad(upperLeft, upperRight, lowerLeft, lowerRight));
}

/**
 * Black & White's grey (as Photoshop's): the smallest channel, plus the step to the middle one weighted by the
 * secondary colour the two largest channels make, plus the step to the largest weighted by its primary.
 * Weights are fractions (Reds 40 % = 0.4), in the order reds, yellows, greens, cyans, blues, magentas.
 */
export function blackWhiteGray([r, g, b]: number[], w: number[]): number {
  const [reds, yellows, greens, cyans, blues, magentas] = w;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const md = r + g + b - mx - mn;
  let primary: number;
  let secondary: number;
  if (mx === r) {
    primary = reds;
    secondary = g >= b ? yellows : magentas;
  } else if (mx === g) {
    primary = greens;
    secondary = r >= b ? yellows : cyans;
  } else {
    primary = blues;
    secondary = r >= g ? magentas : cyans;
  }
  return Math.min(1, Math.max(0, mn + (md - mn) * secondary + (mx - md) * primary));
}

/**
 * Levels' input and output values as fractions: projects store them in 0..1, or in 0..255 when the effect was
 * set in an 8 bpc project, which any value above 1 gives away.
 */
export function levelsFractions(values: number[]): number[] {
  return values.some((v) => v > 1.0001) ? values.map((v) => v / 255) : values;
}

/** Levels on one channel value (fractions; gamma as stored). */
export function levels(v: number, inBlack: number, inWhite: number, gamma: number, outBlack: number, outWhite: number, clipBlack = true, clipWhite = true): number {
  const span = inWhite - inBlack;
  let t = span === 0 ? (v >= inWhite ? 1 : 0) : (v - inBlack) / span;
  t = Math.sign(t) * Math.abs(t) ** (1 / Math.max(gamma, 1e-3));
  let out = outBlack + t * (outWhite - outBlack);
  const lo = Math.min(outBlack, outWhite);
  const hi = Math.max(outBlack, outWhite);
  if (clipBlack) out = Math.max(out, lo);
  if (clipWhite) out = Math.min(out, hi);
  return Math.min(1, Math.max(0, out));
}

/** Posterize: `levels` evenly spaced values from 0 to 1. */
export function posterize(v: number, levelCount: number): number {
  const n = Math.max(2, Math.round(levelCount));
  return Math.min(n - 1, Math.floor(v * n)) / (n - 1);
}

/**
 * Linear Wipe: the projection on the wipe direction where the wiped part ends, for a completion fraction and the
 * feather (pixels), over the projections [lo, hi] of the layer's corners: points below it are wiped, fading over
 * the feather either side of it, so the layer is whole at 0 and gone at 1.
 */
export function linearWipeEdge(lo: number, hi: number, completion: number, feather: number): number {
  const f = Math.max(0, feather);
  return lo - f + completion * (hi - lo + 2 * f);
}

/** The projections of a rectangle's corners on a direction. */
export function projectionRange(rect: Rect, dir: [number, number]): [number, number] {
  const values = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ].map(([x, y]) => x * dir[0] + y * dir[1]);
  return [Math.min(...values), Math.max(...values)];
}
