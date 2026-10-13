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

/**
 * A popup's choice (1-based) among its menu's entries: the value a project stores also counts the separators
 * ("(-") between them. Values past the menu count one choice each.
 */
export function popupChoice(value: number, menu: readonly string[]): number {
  const v = Math.round(value);
  let choice = 0;
  for (let i = 0; i < v; i++) if (i >= menu.length || !menu[i].startsWith("(-")) choice++;
  return Math.max(1, choice);
}

/** Fractal Noise's and Turbulent Displace's noise planes per radian of Evolution. */
export const EVOLUTION_PLANES_PER_RADIAN = 0.25;

/**
 * The two noise planes an Evolution (degrees) blends, and the weight of the second. With Cycle Evolution the planes
 * repeat after Cycle (in Revolutions) turns, rounded to a whole number of planes so the cycle closes seamlessly.
 */
export function evolutionPlanes(evolution: number, cycle: boolean, revolutions: number): { planes: [number, number]; weight: number } {
  const turns = Math.max(1, Math.round(revolutions)) * 2 * Math.PI;
  const period = cycle ? Math.max(1, Math.round(turns * EVOLUTION_PLANES_PER_RADIAN)) : Infinity;
  const e = evolution * DEG * (cycle ? period / turns : EVOLUTION_PLANES_PER_RADIAN);
  const base = Math.floor(e);
  const wrap = (v: number) => (cycle ? v - period * Math.floor(v / period) : v);
  return { planes: [wrap(base), wrap(base + 1)], weight: e - base };
}

/**
 * Optics Compensation's focal lengths for a Field Of View (degrees) across a half extent (pixels): a rectilinear
 * lens's and an equidistant fisheye's, both seeing that half extent at half the field of view.
 */
export function opticsFocals(fov: number, halfExtent: number): [number, number] {
  const half = (Math.min(Math.max(fov, 1e-3), 179) * DEG) / 2;
  return [halfExtent / Math.tan(half), halfExtent / half];
}

/**
 * The radius from View Center of the input point Optics Compensation shows at radius r: the rectilinear image seen
 * through the fisheye (barrel distortion), or with Reverse Lens Distortion the fisheye image straightened. Infinity
 * where the fisheye sees nothing (past a quarter turn).
 */
export function opticsSourceRadius(r: number, [rectilinear, fisheye]: [number, number], reverse: boolean): number {
  if (reverse) return fisheye * Math.atan(r / rectilinear);
  const angle = r / fisheye;
  return angle < Math.PI / 2 ? rectilinear * Math.tan(angle) : Infinity;
}

/** Where input radius r lands: the inverse of opticsSourceRadius. */
export const opticsTargetRadius = (r: number, focals: [number, number], reverse: boolean): number => opticsSourceRadius(r, focals, !reverse);

/** The bounding box of points, with `rect`. */
function boundsWith(rect: Rect, points: number[][]): Rect {
  let [x0, y0, x1, y1] = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * What Optics Compensation's Resize shows of `rect` (sampled along its edges) moved about `center`, at most `factor`
 * times its size about its middle.
 */
export function opticsBounds(rect: Rect, center: number[], focals: [number, number], reverse: boolean, factor: number): Rect {
  const steps = 16;
  const points: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    for (const [x, y] of [
      [rect.x + t * rect.width, rect.y],
      [rect.x + t * rect.width, rect.y + rect.height],
      [rect.x, rect.y + t * rect.height],
      [rect.x + rect.width, rect.y + t * rect.height],
    ]) {
      const v = [x - center[0], y - center[1]];
      const r = Math.hypot(v[0], v[1]);
      const s = r > 0 ? Math.min(1e7, opticsTargetRadius(r, focals, reverse)) / r : 1;
      points.push([center[0] + v[0] * s, center[1] + v[1] * s]);
    }
  }
  const b = boundsWith(rect, points);
  const [w, h] = [rect.width * factor, rect.height * factor];
  const [mx, my] = [rect.x + rect.width / 2, rect.y + rect.height / 2];
  const x0 = Math.max(b.x, mx - w / 2);
  const y0 = Math.max(b.y, my - h / 2);
  return { x: x0, y: y0, width: Math.min(b.x + b.width, mx + w / 2) - x0, height: Math.min(b.y + b.height, my + h / 2) - y0 };
}

/**
 * What Radial Blur draws of `rect`: its corners swept about `center` by the blur, turned by up to ±span/2 radians
 * (Spin) or scaled by up to 1 / (1 − span/2) (Zoom).
 */
export function radialBlurBounds(rect: Rect, center: number[], zoom: boolean, span: number): Rect {
  const points: number[][] = [];
  const steps = 32;
  for (const [x, y] of [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ]) {
    const [vx, vy] = [x - center[0], y - center[1]];
    if (zoom) {
      const f = 1 / Math.max(0.05, 1 - span / 2);
      points.push([center[0] + vx * f, center[1] + vy * f]);
      continue;
    }
    // The arc between two samples bulges past their chord by at most r(1 − cos(step / 2)).
    const step = span / steps;
    const bulge = 1 / Math.cos(Math.min(step / 2, 1.5));
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps - 0.5) * span;
      const [c, s] = [Math.cos(t) * bulge, Math.sin(t) * bulge];
      points.push([center[0] + c * vx - s * vy, center[1] + s * vx + c * vy]);
    }
  }
  return boundsWith(rect, points);
}

/**
 * Bulge's shape for a Bulge Height, in the ellipse scaled to the unit circle: a point at radius l shows the point
 * moved by two radial pulls toward the centre, to radius asin(l / R) / asin(1 / R) (a sphere's arc) and to l^(2e + 1),
 * both of which leave the rim in place; negative heights push out instead. Null when flat.
 */
export function bulgeShape(height: number): { invR: number; arcScale: number; exponent: number } | null {
  const h = Math.min(Math.abs(height), 4) / 4;
  if (h < 1e-6) return null;
  const r = (1 + h) / (2 * Math.sqrt(h));
  return { invR: 1 / r, arcScale: 1 / Math.asin(Math.min(1, 1 / r)), exponent: 1.3 * h ** 3 };
}

/** The point Bulge shows at unit-circle point v. */
export function bulgeSource([x, y]: number[], height: number): [number, number] {
  const shape = bulgeShape(height);
  const t = x * x + y * y;
  if (!shape || t >= 1 || t <= 0) return [x, y];
  const l = Math.sqrt(t);
  const arc = Math.asin(Math.min(1, l * shape.invR)) * shape.arcScale;
  const k = arc / l - 1 + (t ** shape.exponent - 1);
  const s = Math.sign(height);
  return [x + s * k * x, y + s * k * y];
}

/** The angle (radians) Twirl turns a point at distance d from Twirl Center: all of Angle there, easing to none at the radius. */
export function twirlTurn(d: number, radius: number, angle: number): number {
  if (radius <= 0 || d >= radius) return 0;
  const f = 1 - d / radius;
  return angle * DEG * f * f;
}

/** Wave Warp's periodic Wave Types (period 1, between -1 and 1): 1 Sine, 2 Square, 3 Triangle, 4 Sawtooth, 5 Circle, 6 Semicircle, 7 Uncircle. */
export function waveShape(type: number, x: number): number {
  const fract = (v: number) => v - Math.floor(v);
  const arc = (v: number) => Math.sqrt(Math.max(0, 1 - v * v));
  switch (type) {
    case 2:
      return fract(x) < 0.5 ? 1 : -1;
    case 3:
      return 4 * Math.abs(fract(x - 0.25) - 0.5) - 1;
    case 4:
      return 2 * fract(x + 0.5) - 1;
    case 5:
      return (Math.floor(2 * x) % 2 === 0 ? 1 : -1) * arc(fract(2 * x) * 2 - 1);
    case 6:
      return 2 * arc(fract(x) * 2 - 1) - 1;
    case 7:
      return 1 - 2 * arc(fract(x) * 2 - 1);
    default:
      return Math.sin(2 * Math.PI * x);
  }
}

/** 4-Color Gradient's inverse-distance power: Blend 100 gives 2; lower Blend sharpens the regions, higher evens them. */
export const fourColorPower = (blend: number) => 200 / Math.max(1, blend);

/** 4-Color Gradient's weights (summing to 1) of its four colours at a point. */
export function fourColorWeights(p: number[], points: number[][], blend: number): number[] {
  const power = fourColorPower(blend);
  const d = points.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]));
  const at = d.findIndex((v) => v < 1e-6);
  if (at >= 0) return d.map((_, i) => (i === at ? 1 : 0));
  // Relative to the nearest point, so large powers stay finite.
  const nearest = Math.min(...d);
  const w = d.map((v) => (nearest / v) ** power);
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / sum);
}

/**
 * Vibrance on straight RGB: Saturation scales every colour's distance from its luma (Rec. 601) by 1 + s; Vibrance
 * by 1 + v·(1 − saturation), so it does most to the dullest colours (v, s in -1..1).
 */
export function vibrance([r, g, b]: number[], v: number, s: number): [number, number, number] {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  const f = Math.max(0, (1 + s) * (1 + v * (1 - sat)));
  const c = (x: number) => Math.min(1, Math.max(0, l + (x - l) * f));
  return [c(r), c(g), c(b)];
}

/** Displacement Map's Use For Horizontal / Vertical Displacement popups. */
export const DisplaceChannel = { RED: 1, GREEN: 2, BLUE: 3, ALPHA: 4, LUMINANCE: 5, HUE: 6, LIGHTNESS: 7, SATURATION: 8, FULL: 9, HALF: 10, OFF: 11 } as const;

/**
 * The fraction (-1..1) of Max Displacement a map pixel (straight RGB, alpha) gives: (value − ½)·2, so mid grey
 * moves nothing; the colour channels and luminance are weighted by the map's alpha. Full is 1, Half 0, Off -1.
 */
export function displacementFraction(channel: number, [r, g, b]: number[], a: number): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  const sat = d <= 1e-6 ? 0 : l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let hue = 0;
  if (d > 1e-6) hue = (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  const signed = (v: number) => (v - 0.5) * 2;
  switch (channel) {
    case DisplaceChannel.RED:
      return signed(r) * a;
    case DisplaceChannel.GREEN:
      return signed(g) * a;
    case DisplaceChannel.BLUE:
      return signed(b) * a;
    case DisplaceChannel.ALPHA:
      return signed(a);
    case DisplaceChannel.LUMINANCE:
      return signed(0.299 * r + 0.587 * g + 0.114 * b) * a;
    case DisplaceChannel.HUE:
      return signed(hue);
    case DisplaceChannel.LIGHTNESS:
      return signed(l);
    case DisplaceChannel.SATURATION:
      return signed(sat);
    case DisplaceChannel.FULL:
      return 1;
    case DisplaceChannel.HALF:
      return 0;
    default:
      return -1;
  }
}
