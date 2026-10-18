// Geometry of the transitions in transitionsExtra.ts, kept free of WebGL so it can be tested on its own. Layer
// points are in layer pixels, y down; angles are degrees clockwise from up.
import { DEG } from "./stockMath.ts";

/**
 * Iris Wipe's iris: floor(points / 2) tips at the outer radius, the first one Rotation from straight up, with the
 * notches between them at the inner radius, or on the straight line between the tips when the inner radius is not
 * used. Flat [x0, y0, x1, y1...] around the centre.
 */
export function irisVertices(center: number[], points: number, outer: number, inner: number | null, rotation: number): number[] {
  const tips = Math.max(3, Math.floor(points / 2));
  const notch = inner ?? outer * Math.cos(Math.PI / tips);
  const out: number[] = [];
  for (let i = 0; i < 2 * tips; i++) {
    const r = i % 2 ? notch : outer;
    const a = rotation * DEG + (i * Math.PI) / tips;
    out.push(center[0] + r * Math.sin(a), center[1] - r * Math.cos(a));
  }
  return out;
}

/** Iris Wipe's feather -> sigma of the Gaussian its edge falls off with, measured at these feathers (layer pixels). */
const IRIS_FEATHER: [number, number][] = [
  [0, 0.289],
  [2, 0.717],
  [5, 1.358],
  [10, 2.421],
  [20, 4.318],
  [40, 8.136],
];

/** The sigma of Iris Wipe's edge for a feather, both in layer pixels: the hard edge's 1 px ramp at 0. */
export function irisFeatherSigma(feather: number): number {
  const f = Math.max(0, feather);
  for (let i = 1; i < IRIS_FEATHER.length; i++) {
    const [f0, s0] = IRIS_FEATHER[i - 1];
    const [f1, s1] = IRIS_FEATHER[i];
    if (f <= f1 || i === IRIS_FEATHER.length - 1) return s0 + ((f - f0) * (s1 - s0)) / (f1 - f0);
  }
  return 0;
}
