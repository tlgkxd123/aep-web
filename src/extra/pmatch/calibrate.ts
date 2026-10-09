// Calibration by synthesis: the model, rendered over the reference's background
// and seen by the same detector and tracker, is compared with the reference, and
// its birth rate, light, size and prototype weights are adjusted until what is
// seen matches: particles per frame, their median peak and spread, and how
// outward speed is spread over distance from the emitter. Weights correct for
// the tracks that could not become prototypes (too short, or lost by the tracker)
// and for what extrapolating the others adds.
import { DETECTION_FLOATS, D_PEAK, D_SPREAD } from "./detect.ts";
import { median, type Measures } from "./metrics.ts";
import { NEAR_Z, P_AMP, P_LIFE, P_OX, P_OY, P_VX, P_VY, P_VZ, PROTO_STRIDE, type ParticleWorldModel } from "./model.ts";
import { opacityAt } from "./sample.ts";
import { particleDetection } from "./track.ts";

export interface DetectionStats {
  frames: number;
  /** Particles per frame, and their median peak and spread. */
  count: number;
  peak: number;
  spread: number;
}

export function detectionStats(frames: readonly { data: Float32Array }[]): DetectionStats {
  let count = 0;
  const peaks: number[] = [];
  const spreads: number[] = [];
  for (const f of frames) {
    for (let at = 0; at < f.data.length; at += DETECTION_FLOATS) {
      if (!particleDetection(f.data, at)) continue;
      count++;
      peaks.push(f.data[at + D_PEAK]);
      spreads.push(f.data[at + D_SPREAD]);
    }
  }
  return { frames: frames.length, count: frames.length ? count / frames.length : 0, peak: median(peaks) || 0, spread: median(spreads) || 0 };
}

/** Inner edges of the distance and outward-speed bins of two-frame steps. */
export interface StepBins {
  radius: number[];
  speed: number[];
}

type Step = Measures["steps"][number];

function quantileEdges(values: number[], bins: number): number[] {
  const s = values.slice().sort((a, b) => a - b);
  return Array.from({ length: bins - 1 }, (_, k) => s[Math.floor(((k + 1) / bins) * (s.length - 1))] ?? 0);
}

/** Bins at the reference steps' quantiles of distance and of outward speed. */
export function stepBins(steps: readonly Step[], radiusBins = 10, speedBins = 8): StepBins {
  return { radius: quantileEdges(steps.map((s) => s.r), radiusBins), speed: quantileEdges(steps.map((s) => s.speed), speedBins) };
}

function edgeIndex(edges: readonly number[], v: number): number {
  let k = 0;
  while (k < edges.length && v >= edges[k]) k++;
  return k;
}

export function binOf(bins: StepBins, r: number, speed: number): number {
  return edgeIndex(bins.radius, r) * (bins.speed.length + 1) + edgeIndex(bins.speed, speed);
}

export function binCount(bins: StepBins): number {
  return (bins.radius.length + 1) * (bins.speed.length + 1);
}

/** Share of the steps in each bin. */
export function stepHistogram(bins: StepBins, steps: readonly Step[]): Float64Array {
  const h = new Float64Array(binCount(bins));
  for (const s of steps) h[binOf(bins, s.r, s.speed)]++;
  if (steps.length) for (let b = 0; b < h.length; b++) h[b] /= steps.length;
  return h;
}

/** Where the model is drawn for the comparison: emitter and scale (frame pixels) and the analysed region. */
export interface OccupancyView {
  x: number;
  y: number;
  scale: number;
  region: readonly [number, number, number, number];
  frameRate: number;
}

/**
 * Frames each prototype spends in each bin inside the analysed region, bright enough to be found
 * (`minLight`, in the units of the prototypes' amplitude), at clock speed 1 and without jitter.
 */
export function occupancy(model: ParticleWorldModel, view: OccupancyView, bins: StepBins, minLight: number): Float32Array[] {
  const n = model.weights.length;
  const [rx, ry, rw, rh] = view.region;
  const dt = 1 / view.frameRate;
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const p = model.prototypes.subarray(i * PROTO_STRIDE, (i + 1) * PROTO_STRIDE);
    const counts = new Float32Array(binCount(bins));
    const at = (a: number): [number, number] | null => {
      const z = 1 + p[P_VZ] * a;
      if (z < NEAR_Z) return null;
      return [(view.scale * (p[P_OX] + p[P_VX] * a)) / z, (view.scale * (p[P_OY] + p[P_VY] * a)) / z];
    };
    const life = p[P_LIFE];
    for (let a = 0; a + 2 * dt <= life; a += dt) {
      const q0 = at(a);
      const q1 = at(a + 2 * dt);
      if (!q0 || !q1) break;
      const x = view.x + q0[0];
      const y = view.y + q0[1];
      if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) continue;
      const light = p[P_AMP] * (1 + p[P_VZ] * a) ** -model.lightDepth * opacityAt(model, a / life);
      if (light < minLight) continue;
      const r0 = Math.hypot(q0[0], q0[1]);
      const r1 = Math.hypot(q1[0], q1[1]);
      counts[binOf(bins, 0.5 * (r0 + r1), 0.5 * (r1 - r0))]++;
    }
    out.push(counts);
  }
  return out;
}

/** Largest change of a weight in one round (factor). */
const MAX_STEP = 3;
/** Histogram share added to every bin before taking ratios. */
const SMOOTHING = 1e-4;

/**
 * Multiplies each prototype's weight by the geometric mean, over the frames it spends in each bin, of the
 * reference's share of steps in that bin over the model's; mirrored pairs (prototypes 2k and 2k + 1) move
 * together. Weights are then scaled to a mean of 1.
 */
export function reweight(model: ParticleWorldModel, occupancies: readonly Float32Array[], reference: Float64Array, ours: Float64Array, pairs: boolean): void {
  const logRatio = Array.from(reference, (r, b) => Math.max(-Math.log(MAX_STEP), Math.min(Math.log(MAX_STEP), Math.log((r + SMOOTHING) / (ours[b] + SMOOTHING)))));
  const n = model.weights.length;
  const group = pairs ? 2 : 1;
  for (let i = 0; i < n; i += group) {
    let total = 0;
    let sum = 0;
    for (let k = i; k < Math.min(n, i + group); k++) {
      occupancies[k].forEach((c, b) => {
        total += c;
        sum += c * logRatio[b];
      });
    }
    if (!(total > 0)) continue;
    const factor = Math.exp(sum / total);
    for (let k = i; k < Math.min(n, i + group); k++) model.weights[k] *= factor;
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += model.weights[i];
  mean /= n;
  if (mean > 0) for (let i = 0; i < n; i++) model.weights[i] /= mean;
}
