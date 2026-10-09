// Trapcode Particular's "over Life" curves (Size, Opacity...) as its arbitrary data
// (aRbp) stores them, read from projects After Effects saved: a 24-byte header, a
// float that is 1 when the curve was drawn through control points, 201 samples from
// birth to death, then up to 25 control points as their x (a sample index, 255 when
// unused) followed by their y, and one trailing byte. Floats are little endian.

/** Size over Life and Opacity over Life of the main system. */
export const OVER_LIFE = new Set([569, 570]);
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

/**
 * A copy of `data` holding the curve drawn through `points` ([life share 0–1, value
 * 0–1], at most 25, sorted by share, the first at 0 and the last at 1), sampled with
 * straight lines between them.
 */
export function drawnCurve(data: Uint8Array, points: readonly (readonly [number, number])[]): Uint8Array {
  if (points.length < 2 || points.length > POINTS) throw new Error(`a curve has 2 to ${POINTS} points`);
  const xs = points.map(([u]) => Math.round(Math.max(0, Math.min(1, u)) * (CURVE_SAMPLES - 1)));
  if (xs[0] !== 0 || xs.at(-1) !== CURVE_SAMPLES - 1 || xs.some((x, i) => i > 0 && x <= xs[i - 1])) {
    throw new Error("curve points must start at birth, end at death and advance");
  }
  const ys = points.map(([, v]) => Math.max(0, Math.min(1, v)));
  return withCurve(data, (view) => {
    view.setFloat32(DRAWN, 1, true);
    let k = 0;
    for (let i = 0; i < CURVE_SAMPLES; i++) {
      while (k < xs.length - 2 && i > xs[k + 1]) k++;
      const f = (i - xs[k]) / (xs[k + 1] - xs[k]);
      view.setFloat32(SAMPLES + i * 4, ys[k] + (ys[k + 1] - ys[k]) * Math.max(0, Math.min(1, f)), true);
    }
    for (let p = 0; p < POINTS; p++) {
      view.setFloat32(POINTS_X + p * 4, p < xs.length ? xs[p] : UNUSED, true);
      view.setFloat32(POINTS_Y + p * 4, p < ys.length ? ys[p] : 0, true);
    }
    view.setUint8(CURVE_BYTES - 1, 0);
  });
}
