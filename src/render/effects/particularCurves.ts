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

function throughPoints(points: readonly (readonly [number, number])[]): { xs: number[]; ys: number[]; samples: Float32Array } {
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
export const pointSamples = (points: readonly (readonly [number, number])[]): Float32Array => throughPoints(points).samples;

/**
 * A copy of `data` holding the curve drawn through `points` ([life share 0–1, value
 * 0–1], at most 25, sorted by share, the first at 0 and the last at 1), sampled with
 * straight lines between them.
 */
export function drawnCurve(data: Uint8Array, points: readonly (readonly [number, number])[]): Uint8Array {
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

/** A copy of `data` holding the curve given by its 201 samples (0–1), drawn freehand: without control points. */
export function sampledCurve(data: Uint8Array, samples: ArrayLike<number>): Uint8Array {
  if (samples.length !== CURVE_SAMPLES) throw new Error(`a curve has ${CURVE_SAMPLES} samples`);
  return withCurve(data, (view) => {
    view.setFloat32(DRAWN, 0, true);
    for (let i = 0; i < CURVE_SAMPLES; i++) view.setFloat32(SAMPLES + i * 4, Math.max(0, Math.min(1, samples[i])), true);
    for (let i = POINTS_X; i < CURVE_BYTES; i++) view.setUint8(i, 0);
  });
}

/** Ready-made over Life curves, as control points for `drawnCurve`. */
export const CURVE_PRESETS: readonly { name: string; points: readonly (readonly [number, number])[] }[] = [
  { name: "Constant", points: [[0, 1], [1, 1]] },
  { name: "Ramp Up", points: [[0, 0], [1, 1]] },
  { name: "Ramp Down", points: [[0, 1], [1, 0]] },
  { name: "Fade In", points: [[0, 0], [0.2, 1], [1, 1]] },
  { name: "Fade Out", points: [[0, 1], [0.8, 1], [1, 0]] },
  { name: "Fade In and Out", points: [[0, 0], [0.2, 1], [0.8, 1], [1, 0]] },
  { name: "Peak", points: [[0, 0], [0.5, 1], [1, 0]] },
  { name: "Grow and Shrink", points: [[0, 0.5], [0.5, 1], [1, 0.5]] },
];
