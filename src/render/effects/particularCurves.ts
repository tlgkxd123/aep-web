// Trapcode Particular's "over Life" curves (Size, Opacity...) as its arbitrary data
// (aRbp) stores them, read from projects After Effects saved: a 24-byte header, a
// float that is 1 when the curve was drawn through control points, 201 samples from
// birth to death, then up to 25 control points as their x (a sample index, 255 when
// unused) followed by their y, and one trailing byte. Floats are little endian. The
// curve follows its parameter's name (tdmn) in the instance, as LIST:aRbs holding an aRbp.
import { findChild, type Chunk } from "../../aep/riff.ts";

export const PARTICULAR = "tc Particular";
export const SIZE_OVER_LIFE = 569;
export const OPACITY_OVER_LIFE = 570;
/** Size over Life and Opacity over Life of the main system. */
export const OVER_LIFE = new Set([SIZE_OVER_LIFE, OPACITY_OVER_LIFE]);
export const CURVE_SAMPLES = 201;
const DRAWN = 24;
const SAMPLES = 28;
const POINTS = 25;
const POINTS_X = SAMPLES + CURVE_SAMPLES * 4;
const POINTS_Y = POINTS_X + POINTS * 4;
const UNUSED = 255;
export const CURVE_BYTES = POINTS_Y + POINTS * 4 + 1;
/** The most control points a curve stores. */
export const MAX_CURVE_POINTS = POINTS;
const LAST = CURVE_SAMPLES - 1;

/** A control point of an over Life curve: [life share, 0 at birth and 1 at death; value 0–1]. */
export type CurvePoint = readonly [number, number];

/** The curve's samples, null when the data is not a curve. */
export function curveSamples(data: Uint8Array): Float32Array | null {
  if (data.length < SAMPLES + CURVE_SAMPLES * 4) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Float32Array.from({ length: CURVE_SAMPLES }, (_, i) => view.getFloat32(SAMPLES + i * 4, true));
}

const tdmnText = (c: Chunk) => new TextDecoder().decode(c.data).replace(/\0[\s\S]*$/, "");
const curveChunks = new WeakMap<Chunk, Map<number, Chunk | null>>();

/** The aRbp holding over Life curve `n` of a Particular instance (its LIST:sspc), if it stores one. */
export function curveChunk(sspc: Chunk, n: number): Chunk | undefined {
  let found = curveChunks.get(sspc);
  if (!found) curveChunks.set(sspc, (found = new Map()));
  const known = found.get(n);
  if (known !== undefined) return known ?? undefined;
  const name = `${PARTICULAR}-${String(n).padStart(4, "0")}`;
  let result: Chunk | undefined;
  const visit = (children: Chunk[]) => {
    let current = "";
    for (const c of children) {
      if (result) return;
      if (c.type === "tdmn") current = tdmnText(c);
      else if (c.type === "LIST" && c.listType === "aRbs" && current === name) result = findChild(c, "aRbp");
      else if (c.children && c.listType !== "parT") visit(c.children);
    }
  };
  visit(sspc.children ?? []);
  // Edits replace the aRbp's data, never the chunk itself.
  if (result) found.set(n, result);
  return result;
}

const samplesByData = new WeakMap<Uint8Array, Float32Array | null>();

/** The current samples of over Life curve `n` of a Particular instance, null when it stores none. */
export function overLifeCurve(sspc: Chunk | undefined, n: number): Float32Array | null {
  const data = sspc && curveChunk(sspc, n)?.data;
  if (!data) return null;
  let samples = samplesByData.get(data);
  if (samples === undefined) samplesByData.set(data, (samples = curveSamples(data)));
  return samples;
}

/** A curve's value at life share `u` (0 at birth, 1 at death), 1 without a curve. */
export function sampleCurve(curve: Float32Array | null, u: number): number {
  if (!curve) return 1;
  const x = Math.max(0, Math.min(1, u)) * (CURVE_SAMPLES - 1);
  const i = Math.min(CURVE_SAMPLES - 2, Math.floor(x));
  return Math.max(0, curve[i] + (curve[i + 1] - curve[i]) * (x - i));
}

function withCurve(data: Uint8Array, fill: (view: DataView) => void): Uint8Array {
  if (data.length < CURVE_BYTES) throw new Error("not an over Life curve");
  const out = data.slice();
  fill(new DataView(out.buffer, out.byteOffset, out.byteLength));
  return out;
}

/** A copy of `data` holding the constant curve at 100 %, as a new Particular stores it. */
export function flatCurve(data: Uint8Array): Uint8Array {
  return withCurve(data, (view) => {
    view.setFloat32(DRAWN, 0, true);
    for (let i = 0; i < CURVE_SAMPLES; i++) view.setFloat32(SAMPLES + i * 4, 1, true);
    for (let i = POINTS_X; i < CURVE_BYTES; i++) view.setUint8(i, 0);
  });
}

function throughPoints(points: readonly CurvePoint[]): { xs: number[]; ys: number[]; samples: Float32Array } {
  if (points.length < 2 || points.length > POINTS) throw new Error(`a curve has 2 to ${POINTS} points`);
  const xs = points.map(([u]) => Math.round(Math.max(0, Math.min(1, u)) * (CURVE_SAMPLES - 1)));
  if (xs[0] !== 0 || xs.at(-1) !== CURVE_SAMPLES - 1 || xs.some((x, i) => i > 0 && x <= xs[i - 1])) {
    throw new Error("curve points must start at birth, end at death and advance");
  }
  const ys = points.map(([, v]) => Math.max(0, Math.min(1, v)));
  const samples = new Float32Array(CURVE_SAMPLES);
  let k = 0;
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    while (k < xs.length - 2 && i > xs[k + 1]) k++;
    const f = (i - xs[k]) / (xs[k + 1] - xs[k]);
    samples[i] = ys[k] + (ys[k + 1] - ys[k]) * Math.max(0, Math.min(1, f));
  }
  return { xs, ys, samples };
}

/** The samples of the curve drawn through `points`, as `drawnCurve` stores them. */
export const pointSamples = (points: readonly CurvePoint[]): Float32Array => throughPoints(points).samples;

/**
 * A copy of `data` holding the curve drawn through `points` ([life share 0–1, value
 * 0–1], at most 25, sorted by share, the first at 0 and the last at 1), sampled with
 * straight lines between them.
 */
export function drawnCurve(data: Uint8Array, points: readonly CurvePoint[]): Uint8Array {
  const { xs, ys, samples } = throughPoints(points);
  return withCurve(data, (view) => {
    view.setFloat32(DRAWN, 1, true);
    samples.forEach((v, i) => view.setFloat32(SAMPLES + i * 4, v, true));
    for (let p = 0; p < POINTS; p++) {
      view.setFloat32(POINTS_X + p * 4, p < xs.length ? xs[p] : UNUSED, true);
      view.setFloat32(POINTS_Y + p * 4, p < ys.length ? ys[p] : 0, true);
    }
    view.setUint8(CURVE_BYTES - 1, 0);
  });
}

/** How far the straight lines between fitted points may stray from the samples they replace. */
const FIT_TOLERANCE = 0.01;

const unit = (v: number) => Math.max(0, Math.min(1, v));
const sampleIndex = (u: number) => Math.round(unit(u) * LAST);

/** The control points `data` stores when it holds a curve drawn through them (birth to death, whole samples apart), else null. */
export function storedPoints(data: Uint8Array): CurvePoint[] | null {
  if (data.length < CURVE_BYTES) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getFloat32(DRAWN, true) !== 1) return null;
  const points: CurvePoint[] = [];
  let previous = -1;
  for (let p = 0; p < POINTS; p++) {
    const x = view.getFloat32(POINTS_X + p * 4, true);
    if (x === UNUSED) break;
    if (!Number.isInteger(x) || x <= previous || x > LAST) return null;
    points.push([x / LAST, unit(view.getFloat32(POINTS_Y + p * 4, true))]);
    previous = x;
  }
  return points.length >= 2 && points[0][0] === 0 && previous === LAST ? points : null;
}

/** Sample indices of the fewest points, birth to death, whose straight lines pass within `tolerance` of every sample. */
function fewestPoints(values: readonly number[], tolerance: number): number[] {
  const count = new Array<number>(CURVE_SAMPLES).fill(Infinity);
  const previous = new Array<number>(CURVE_SAMPLES).fill(0);
  count[0] = 0;
  for (let i = 0; i < LAST; i++) {
    // The slopes of the lines from point i that pass within the tolerance of the samples so far.
    let low = -Infinity;
    let high = Infinity;
    for (let j = i + 1; j <= LAST && low <= high; j++) {
      const slope = (values[j] - values[i]) / (j - i);
      if (slope >= low - 1e-9 && slope <= high + 1e-9 && count[i] + 1 < count[j]) [count[j], previous[j]] = [count[i] + 1, i];
      low = Math.max(low, (values[j] - tolerance - values[i]) / (j - i));
      high = Math.min(high, (values[j] + tolerance - values[i]) / (j - i));
    }
  }
  const xs = [LAST];
  while (xs[0] > 0) xs.unshift(previous[xs[0]]);
  return xs;
}

/** Sample indices of 25 points, birth to death: birth and death, then one at a time the sample furthest from the lines so far. */
function cappedPoints(values: readonly number[]): number[] {
  const xs = [0, LAST];
  while (xs.length < POINTS) {
    let worst = -1;
    let slot = 0;
    let error = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      const [a, b] = [xs[k], xs[k + 1]];
      for (let i = a + 1; i < b; i++) {
        const off = Math.abs(values[i] - (values[a] + ((values[b] - values[a]) * (i - a)) / (b - a)));
        if (off > error) [error, worst, slot] = [off, i, k + 1];
      }
    }
    if (worst < 0) break;
    xs.splice(slot, 0, worst);
  }
  return xs;
}

/**
 * Points on samples whose straight lines redraw `samples`: the fewest that stay within
 * `tolerance` of them, or when that takes more than 25, the 25 that come closest one
 * point at a time.
 */
export function fittedPoints(samples: ArrayLike<number>, tolerance = FIT_TOLERANCE): CurvePoint[] {
  if (samples.length !== CURVE_SAMPLES) throw new Error(`a curve has ${CURVE_SAMPLES} samples`);
  const values = Array.from(samples, unit);
  const fewest = fewestPoints(values, tolerance);
  return (fewest.length <= POINTS ? fewest : cappedPoints(values)).map((i) => [i / LAST, values[i]]);
}

const pointsByData = new WeakMap<Uint8Array, CurvePoint[]>();

/**
 * The control points over Life curve `n` of a Particular instance is edited through: the
 * ones it stores when their straight lines redraw its samples, else points fitted to the
 * samples (a curve drawn freehand, or one of Particular's smooth presets). Null when it
 * stores no curve.
 */
export function overLifePoints(sspc: Chunk | undefined, n: number): CurvePoint[] | null {
  const data = sspc && curveChunk(sspc, n)?.data;
  const samples = overLifeCurve(sspc, n);
  if (!data || !samples) return null;
  let points = pointsByData.get(data);
  if (!points) {
    const stored = storedPoints(data);
    const redraws = stored && pointSamples(stored).every((v, i) => Math.abs(v - samples[i]) <= 1e-3);
    pointsByData.set(data, (points = redraws ? stored : fittedPoints(samples)));
  }
  return points;
}

/**
 * `points` with point `k` moved to life share `u` and value `v`, on whole samples: birth
 * and death keep their share, the others stay between their neighbours.
 */
export function movePoint(points: readonly CurvePoint[], k: number, u: number, v: number): CurvePoint[] {
  const x = k === 0 ? 0 : k === points.length - 1 ? LAST : Math.max(sampleIndex(points[k - 1][0]) + 1, Math.min(sampleIndex(points[k + 1][0]) - 1, sampleIndex(u)));
  const out = points.slice();
  out[k] = [x / LAST, unit(v)];
  return out;
}

/**
 * `points` with a point at life share `u` and value `v` (on a whole sample) and its index;
 * a point already on that sample moves to `v` instead. The index is -1, and the points
 * unchanged, when the curve already holds 25.
 */
export function addPoint(points: readonly CurvePoint[], u: number, v: number): { points: CurvePoint[]; index: number } {
  const x = sampleIndex(u);
  const at = points.findIndex(([pu]) => sampleIndex(pu) >= x);
  if (sampleIndex(points[at][0]) === x) return { points: movePoint(points, at, u, v), index: at };
  if (points.length >= POINTS) return { points: points.slice(), index: -1 };
  const out = points.slice();
  out.splice(at, 0, [x / LAST, unit(v)]);
  return { points: out, index: at };
}

/** `points` without point `k`; birth and death stay. */
export function removePoint(points: readonly CurvePoint[], k: number): CurvePoint[] {
  return k > 0 && k < points.length - 1 ? points.filter((_, i) => i !== k) : points.slice();
}
