// AE's expression math: vector helpers, interpolation, color conversion.
import { add, div, mul, sub, unwrap } from "./sandbox.ts";

export type Scalarish = number | number[];

/** A numeric argument: property objects stand for their values, arrays are copied. */
export function num(v: unknown, what = "argument"): Scalarish {
  const u = unwrap(v);
  if (typeof u === "number") return u;
  if (typeof u === "boolean") return Number(u);
  if (Array.isArray(u)) return u.map((x) => Number(unwrap(x)));
  if (typeof u === "string" && u.trim() !== "" && !Number.isNaN(Number(u))) return Number(u);
  throw new TypeError(`${what} must be a number or an array of numbers`);
}

export function vec(v: unknown, what = "argument"): number[] {
  const n = num(v, what);
  return Array.isArray(n) ? n : [n];
}

export function scalar(v: unknown, what = "argument"): number {
  const n = num(v, what);
  return Array.isArray(n) ? (n[0] ?? 0) : n;
}

const lerp = (a: Scalarish, b: Scalarish, f: number): Scalarish => add(a, mul(sub(b, a), f)) as Scalarish;

/** Cubic bezier easing through (0,0), (x1,y1), (x2,y2), (1,1), solved for x by bisection-refined Newton steps. */
export function cubicEase(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const err = sx(u) - t;
      if (Math.abs(err) < 1e-12) return sy(u);
      const d = dx(u);
      if (Math.abs(d) < 1e-9) break;
      u -= err / d;
    }
    let lo = 0;
    let hi = 1;
    u = t;
    for (let i = 0; i < 60; i++) {
      const x = sx(u);
      if (Math.abs(x - t) < 1e-13) break;
      if (x < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return sy(u);
  };
}

/** Easing curves of ease(), easeIn() and easeOut() (progress in, progress out). */
export const EASES = {
  linear: (t: number) => t,
  ease: cubicEase(1 / 3, 0, 2 / 3, 1),
  easeIn: cubicEase(1 / 3, 0, 5 / 6, 5 / 6),
  easeOut: cubicEase(1 / 6, 1 / 6, 2 / 3, 1),
};

/** linear/ease/easeIn/easeOut with AE's argument forms: (t, v1, v2) over [0, 1] or (t, tMin, tMax, v1, v2). */
export function interpolate(curve: (t: number) => number, args: unknown[]): Scalarish {
  let t: number;
  let tMin: number;
  let tMax: number;
  let v1: Scalarish;
  let v2: Scalarish;
  if (args.length >= 5) {
    t = scalar(args[0], "t");
    tMin = scalar(args[1], "tMin");
    tMax = scalar(args[2], "tMax");
    v1 = num(args[3], "value1");
    v2 = num(args[4], "value2");
  } else if (args.length >= 3) {
    t = scalar(args[0], "t");
    tMin = 0;
    tMax = 1;
    v1 = num(args[1], "value1");
    v2 = num(args[2], "value2");
  } else {
    throw new TypeError("interpolation needs 3 or 5 arguments");
  }
  if (tMin > tMax) {
    [tMin, tMax] = [tMax, tMin];
    [v1, v2] = [v2, v1];
  }
  if (t <= tMin) return Array.isArray(v1) ? [...v1] : v1;
  if (t >= tMax) return Array.isArray(v2) ? [...v2] : v2;
  return lerp(v1, v2, curve((t - tMin) / (tMax - tMin)));
}

export function clamp(value: unknown, limit1: unknown, limit2: unknown): Scalarish {
  const v = num(value, "value");
  const a = num(limit1, "limit1");
  const b = num(limit2, "limit2");
  const one = (x: number, lo: number, hi: number) => Math.min(Math.max(x, Math.min(lo, hi)), Math.max(lo, hi));
  if (!Array.isArray(v)) return one(v, scalar(a), scalar(b));
  return v.map((x, i) => one(x, Array.isArray(a) ? (a[i] ?? a[a.length - 1]) : a, Array.isArray(b) ? (b[i] ?? b[b.length - 1]) : b));
}

export function length(a: unknown, b?: unknown): number {
  const v = b === undefined ? vec(a) : (sub(vec(a), vec(b)) as number[]);
  return Math.hypot(...v);
}

export function normalize(a: unknown): number[] {
  const v = vec(a);
  const n = Math.hypot(...v);
  return n > 0 ? (div(v, n) as number[]) : v.map(() => 0);
}

export function dot(a: unknown, b: unknown): number {
  const x = vec(a);
  const y = vec(b);
  let s = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) s += x[i] * y[i];
  return s;
}

export function cross(a: unknown, b: unknown): number[] {
  const [x1, y1, z1 = 0] = vec(a);
  const [x2, y2, z2 = 0] = vec(b);
  return [y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2];
}

const DEG = 180 / Math.PI;

/** Orientation (degrees) that turns a layer's +Z axis from `from` toward `at`, with no roll. */
export function lookAt(from: unknown, at: unknown): number[] {
  const [dx, dy, dz] = normalize(sub(vec(at), vec(from)));
  const y = Math.asin(Math.max(-1, Math.min(1, dx ?? 0)));
  const x = Math.atan2(-(dy ?? 0), dz ?? 0);
  return [x * DEG, y * DEG, 0];
}

export function rgbToHsl(rgba: unknown): number[] {
  const [r, g, b, a = 1] = vec(rgba);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l, a];
}

export function hslToRgb(hsla: unknown): number[] {
  const [h, s, l, a = 1] = vec(hsla);
  if (s === 0) return [l, l, l, a];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3), a];
}

export function hexToRgb(hex: unknown): number[] {
  let s = String(unwrap(hex)).trim().replace(/^#|^0x/i, "");
  if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join("");
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16) / 255;
  if (s.length === 8) return [n(2), n(4), n(6), n(0)];
  return [n(0), n(2), n(4), 1];
}
