// Fits the world model's clock, dynamics and population to tracked particles
// (track.ts). A track is a stretch of one particle's straight flight seen through
// a pinhole: relative to the emitter, q(τ) = (A + B a) / (1 − w a) with a = τ − τ0
// the particle time since its first point, A its offset there, B its sideways
// velocity and w its approach rate. Track fits and the clock (the particle time
// each frame advances) are estimated in turn: a frame's clock step is the one that
// best explains all particle steps of that frame given their fits.
import { FEATURES, type AudioFeatures } from "./audio.ts";
import { dynamicsWeightCount, LIFE_SAMPLES, P_AMP, P_LIFE, P_OX, P_SIZE, P_VX, PROTO_STRIDE, type Dynamics } from "./model.ts";
import { random } from "./sample.ts";
import type { Track, TrackPoint } from "./track.ts";

export interface ProjectiveFit {
  /** Offset from the emitter at the first point (px). */
  ax: number;
  ay: number;
  /** Sideways velocity (px per clock second) and approach rate (per clock second). */
  bx: number;
  by: number;
  w: number;
  /** Clock time of the first point and the track's clock duration. */
  tau0: number;
  span: number;
  /** Root mean square distance of the points from the fit (px). */
  rms: number;
}

/** Solves M x = v (n × n, row-major) by Gaussian elimination with partial pivoting; null when singular. */
export function solve(m: Float64Array, v: Float64Array, n: number): Float64Array | null {
  const a = Float64Array.from(m);
  const b = Float64Array.from(v);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r * n + c]) > Math.abs(a[p * n + c])) p = r;
    if (Math.abs(a[p * n + c]) < 1e-12) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) [a[c * n + k], a[p * n + k]] = [a[p * n + k], a[c * n + k]];
      [b[c], b[p]] = [b[p], b[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = a[r * n + c] / a[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) a[r * n + k] -= f * a[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let c = n - 1; c >= 0; c--) {
    let s = b[c];
    for (let k = c + 1; k < n; k++) s -= a[c * n + k] * x[k];
    x[c] = s / a[c * n + c];
  }
  return x;
}

export function fitPosition(f: ProjectiveFit, a: number): [number, number] {
  const d = 1 - f.w * a;
  return [(f.ax + f.bx * a) / d, (f.ay + f.by * a) / d];
}

/** dq/dτ at particle time a since the first point. */
export function fitVelocity(f: ProjectiveFit, a: number): [number, number] {
  const d = 1 - f.w * a;
  return [(f.bx + f.w * f.ax) / (d * d), (f.by + f.w * f.ay) / (d * d)];
}

/** The particle stays in front of the camera over its track: 1 − w a ≥ this. */
const MIN_DEPTH = 0.1;
/**
 * Prior on B for extrapolating a track: (point noise / spread of B)² with the noise about 0.6 px and B
 * within about 20 px per clock second (B = −w × the point a particle's flight comes from, which lies near
 * the emitter). Over a short track an outward step is explained as well by B as by approach (w), and only
 * the prior tells them apart. The clock is fitted without it: the free fit's curvature follows the clock
 * better.
 */
export const B_PRIOR = (0.6 / 20) ** 2;

/** Least-squares projective fit of a track's points, with particle time `tau(frame)` and a ridge on B; null when degenerate. */
export function fitTrack(points: readonly TrackPoint[], tau: (frame: number) => number, cx: number, cy: number, ridge = 0): ProjectiveFit | null {
  const tau0 = tau(points[0].frame);
  const span = tau(points[points.length - 1].frame) - tau0;
  if (!(span > 1e-6)) return null;
  // Unknowns ax, ay, bx, by, w: q = A + B a + w a q.
  const m = new Float64Array(25);
  const v = new Float64Array(5);
  const add = (row: number[], value: number) => {
    for (let i = 0; i < 5; i++) {
      v[i] += row[i] * value;
      for (let j = 0; j < 5; j++) m[i * 5 + j] += row[i] * row[j];
    }
  };
  for (const p of points) {
    const a = tau(p.frame) - tau0;
    const x = p.x - cx;
    const y = p.y - cy;
    add([1, 0, a, 0, a * x], x);
    add([0, 1, 0, a, a * y], y);
  }
  m[12] += ridge;
  m[18] += ridge;
  let x = solve(m, v, 5);
  if (!x) return null;
  let [ax, ay, bx, by, w] = x;
  // Particles fly towards the camera or across, never away: slowing down is the clock's.
  if (w < 0 || w * span > 1 - MIN_DEPTH) {
    // Refit A, B with w held at the limit (q (1 − w a) = A + B a, per axis).
    w = w < 0 ? 0 : (1 - MIN_DEPTH) / span;
    const m2 = new Float64Array(4);
    const vx = new Float64Array(2);
    const vy = new Float64Array(2);
    for (const p of points) {
      const a = tau(p.frame) - tau0;
      const d = 1 - w * a;
      m2[0] += 1;
      m2[1] += a;
      m2[3] += a * a;
      vx[0] += (p.x - cx) * d;
      vx[1] += (p.x - cx) * d * a;
      vy[0] += (p.y - cy) * d;
      vy[1] += (p.y - cy) * d * a;
    }
    m2[2] = m2[1];
    m2[3] += ridge;
    const sx = solve(m2, vx, 2);
    const sy = solve(m2, vy, 2);
    if (!sx || !sy) return null;
    [ax, bx] = sx;
    [ay, by] = sy;
  }
  const fit: ProjectiveFit = { ax, ay, bx, by, w, tau0, span, rms: 0 };
  let sq = 0;
  for (const p of points) {
    const [qx, qy] = fitPosition(fit, tau(p.frame) - tau0);
    sq += (p.x - cx - qx) ** 2 + (p.y - cy - qy) ** 2;
  }
  fit.rms = Math.sqrt(sq / points.length);
  return Number.isFinite(fit.rms) ? fit : null;
}

export interface ClockFit {
  /** Frame index of tau[0]. */
  first: number;
  /** Particle time at each frame of the window (clock seconds, tau[0] = 0). */
  tau: Float64Array;
  /** Clock speed over each frame's step from the previous one (clock seconds per second; speed[0] repeats speed[1]). */
  speed: Float64Array;
  fits: (ProjectiveFit | null)[];
}

export interface ClockOptions {
  iterations: number;
  /** Tracks shorter than this do not take part. */
  minPoints: number;
}

/**
 * Alternates track fits and per-frame clock steps. The clock is scaled so that it runs at one clock
 * second per second on average over the window.
 */
export function fitClock(tracks: readonly Track[], first: number, frames: number, center: [number, number], frameRate: number, options: ClockOptions = { iterations: 6, minPoints: 8 }): ClockFit {
  const [cx, cy] = center;
  const tau = Float64Array.from({ length: frames }, (_, k) => k / frameRate);
  const step = new Float64Array(frames).fill(1 / frameRate);
  const used = tracks.filter((t) => t.points.length >= options.minPoints);
  const at = (frame: number) => tau[Math.max(0, Math.min(frames - 1, frame - first))];
  let fits: (ProjectiveFit | null)[] = [];
  for (let iteration = 0; iteration < options.iterations; iteration++) {
    fits = used.map((t) => fitTrack(t.points, at, cx, cy));
    const num = new Float64Array(frames);
    const den = new Float64Array(frames);
    used.forEach((t, i) => {
      const f = fits[i];
      if (!f || f.rms > 3) return;
      for (let j = 1; j < t.points.length; j++) {
        const p = t.points[j - 1];
        const q = t.points[j];
        if (q.frame - p.frame !== 1) continue;
        const k = q.frame - first;
        if (k < 1 || k >= frames) continue;
        const a = 0.5 * (tau[k] + tau[k - 1]) - f.tau0;
        const [gx, gy] = fitVelocity(f, a);
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        // Huber weight on the step's misfit at the current clock.
        const miss = Math.hypot(dx - gx * step[k], dy - gy * step[k]);
        const weight = iteration === 0 ? 1 : Math.min(1, 1 / Math.max(1e-6, miss));
        num[k] += weight * (dx * gx + dy * gy);
        den[k] += weight * (gx * gx + gy * gy);
      }
    });
    let known = 0;
    let sum = 0;
    for (let k = 1; k < frames; k++) {
      if (den[k] > 1e-9) {
        step[k] = Math.max(0, num[k] / den[k]);
        known++;
        sum += step[k];
      } else {
        step[k] = NaN;
      }
    }
    const mean = known ? sum / known : 1 / frameRate;
    for (let k = 1; k < frames; k++) if (!Number.isFinite(step[k])) step[k] = mean;
    const scale = (frames - 1) / frameRate / Math.max(1e-9, step.subarray(1).reduce((s, v) => s + v, 0));
    tau[0] = 0;
    for (let k = 1; k < frames; k++) {
      step[k] *= scale;
      tau[k] = tau[k - 1] + step[k];
    }
  }
  // The fits must use the final clock: their tau0 and span are in its time.
  fits = used.map((t) => fitTrack(t.points, at, cx, cy));
  const speed = new Float64Array(frames);
  for (let k = 1; k < frames; k++) speed[k] = step[k] * frameRate;
  speed[0] = speed[1] ?? 1;
  const all: (ProjectiveFit | null)[] = [];
  const index = new Map(used.map((t, i) => [t, i]));
  for (const t of tracks) {
    const i = index.get(t);
    all.push(i === undefined ? null : fits[i]);
  }
  return { first, tau, speed, fits: all };
}

// ---------------------------------------------------------------------------
// Audio → clock speed.

export interface DynamicsReport {
  lag: number;
  /** Share of the log clock speed's variance explained on the training part and the held-back last fifth. */
  r2Train: number;
  r2Valid: number;
  /** Whether the network beat the linear map on the held-back part. */
  network: boolean;
}

/** Feature vector at time t seconds (linear interpolation between feature frames; zero outside). */
/** The features at `t` seconds, interpolated between frames (zero outside the track). */
export function featuresAt(f: AudioFeatures, t: number, out: Float64Array): void {
  const x = t * f.rate;
  const k = Math.floor(x);
  const u = x - k;
  for (let i = 0; i < f.dims; i++) {
    const a = k >= 0 && k < f.frames ? f.data[k * f.dims + i] : 0;
    const b = k + 1 >= 0 && k + 1 < f.frames ? f.data[(k + 1) * f.dims + i] : 0;
    out[i] = a + (b - a) * u;
  }
}

/** Coefficient of determination of `pred` for `y` over rows [from, to). */
export function r2(pred: ArrayLike<number>, y: ArrayLike<number>, from: number, to: number): number {
  let mean = 0;
  for (let i = from; i < to; i++) mean += y[i];
  mean /= Math.max(1, to - from);
  let res = 0;
  let tot = 0;
  for (let i = from; i < to; i++) {
    res += (y[i] - pred[i]) ** 2;
    tot += (y[i] - mean) ** 2;
  }
  return tot > 0 ? 1 - res / tot : 0;
}

/** Ridge regression of y on [1, x] over rows [0, n); returns the coefficients (bias first). */
export function ridge(x: Float64Array[], y: Float64Array, n: number, lambda: number): Float64Array {
  const d = x[0].length + 1;
  const m = new Float64Array(d * d);
  const v = new Float64Array(d);
  const row = new Float64Array(d);
  for (let r = 0; r < n; r++) {
    row[0] = 1;
    row.set(x[r], 1);
    for (let i = 0; i < d; i++) {
      v[i] += row[i] * y[r];
      for (let j = 0; j < d; j++) m[i * d + j] += row[i] * row[j];
    }
  }
  for (let i = 1; i < d; i++) m[i * d + i] += lambda * n;
  return solve(m, v, d) ?? new Float64Array(d);
}

export interface DynamicsOptions {
  hidden: number;
  /** Lags tried, seconds (the picture follows the audio by this much). */
  lags: number[];
  steps: number;
  seed: number;
}

export const DEFAULT_DYNAMICS: DynamicsOptions = {
  hidden: 8,
  lags: Array.from({ length: 31 }, (_, i) => -0.1 + i / 60),
  steps: 1500,
  seed: 1,
};

/**
 * Learns log clock speed from the audio features: a linear map (ridge) at the best lag, then a small
 * network on top of it, kept only if it predicts the held-back last fifth better. The zoom output stays
 * at zero. `speed[k]` is the clock speed of frame k of a window starting at `start` seconds.
 */
export function fitDynamics(features: AudioFeatures | null, speed: Float64Array, start: number, frameRate: number, options: DynamicsOptions = DEFAULT_DYNAMICS): { dynamics: Dynamics; report: DynamicsReport } {
  const inputs = FEATURES;
  const hidden = options.hidden;
  const weights = new Float32Array(dynamicsWeightCount(inputs, hidden));
  const b2 = hidden * inputs + hidden + 2 * hidden;
  const skip = b2 + 2;
  // Frame pairs: sources at 30 fps duplicated to 60 move every other frame.
  const pairs = Math.max(0, speed.length - 2);
  const y = new Float64Array(pairs);
  for (let k = 0; k < pairs; k++) y[k] = Math.log(Math.max(0.03, 0.5 * (speed[k + 1] + speed[k + 2])));
  const meanY = pairs ? y.reduce((s, v) => s + v, 0) / pairs : 0;
  const dynamics: Dynamics = { rate: features?.rate ?? 100, inputs, hidden, lag: 0, weights };
  if (!features || features.dims !== inputs || pairs < 50) {
    weights[b2] = meanY;
    return { dynamics, report: { lag: 0, r2Train: 0, r2Valid: 0, network: false } };
  }
  const split = Math.floor(pairs * 0.8);
  const time = (k: number) => start + (k + 1) / frameRate;
  const rows = (lag: number) =>
    Array.from({ length: pairs }, (_, k) => {
      const f = new Float64Array(inputs);
      featuresAt(features, time(k) - lag, f);
      return f;
    });
  const predictLinear = (c: Float64Array, x: Float64Array[]) => x.map((f) => f.reduce((s, v, i) => s + v * c[i + 1], c[0]));
  let best: { lag: number; score: number; coef: Float64Array; x: Float64Array[] } = { lag: 0, score: -Infinity, coef: new Float64Array(inputs + 1), x: [] };
  for (const lag of options.lags) {
    const x = rows(lag);
    const coef = ridge(x, y, split, 0.05);
    const score = r2(predictLinear(coef, x), y, split, pairs);
    if (score > best.score) best = { lag, score, coef, x };
  }
  const { x, coef } = best;
  const linearPred = predictLinear(coef, x);
  // Network: out = W2 tanh(W1 f + b1) + b2 + skip f, starting from the linear map; Adam on the training part.
  const rand = random(options.seed);
  const n1 = hidden * inputs;
  const p = new Float64Array(weights.length);
  for (let i = 0; i < n1; i++) p[i] = (rand() * 2 - 1) * (1 / Math.sqrt(inputs));
  p[b2] = coef[0];
  for (let i = 0; i < inputs; i++) p[skip + i] = coef[i + 1];
  const w2 = n1 + hidden;
  const trainable = (i: number) => i < w2 + hidden || i === b2 || (i >= skip && i < skip + inputs);
  const m = new Float64Array(p.length);
  const v = new Float64Array(p.length);
  const grad = new Float64Array(p.length);
  const h = new Float64Array(hidden);
  const forward = (f: Float64Array) => {
    let out = p[b2];
    for (let j = 0; j < hidden; j++) {
      let a = p[n1 + j];
      for (let i = 0; i < inputs; i++) a += p[j * inputs + i] * f[i];
      h[j] = Math.tanh(a);
      out += p[w2 + j] * h[j];
    }
    for (let i = 0; i < inputs; i++) out += p[skip + i] * f[i];
    return out;
  };
  const validLoss = () => {
    let s = 0;
    for (let k = split; k < pairs; k++) s += (forward(x[k]) - y[k]) ** 2;
    return s / Math.max(1, pairs - split);
  };
  let bestLoss = validLoss();
  let bestParams = Float64Array.from(p);
  const lr = 0.01;
  const decay = 1e-4;
  for (let s = 1; s <= options.steps; s++) {
    grad.fill(0);
    for (let k = 0; k < split; k++) {
      const f = x[k];
      const e = (2 * (forward(f) - y[k])) / split;
      grad[b2] += e;
      for (let i = 0; i < inputs; i++) grad[skip + i] += e * f[i];
      for (let j = 0; j < hidden; j++) {
        grad[w2 + j] += e * h[j];
        const back = e * p[w2 + j] * (1 - h[j] * h[j]);
        grad[n1 + j] += back;
        for (let i = 0; i < inputs; i++) grad[j * inputs + i] += back * f[i];
      }
    }
    for (let i = 0; i < p.length; i++) {
      if (!trainable(i)) continue;
      const g = grad[i] + (i < n1 || (i >= w2 && i < w2 + hidden) ? decay * p[i] : 0);
      m[i] = 0.9 * m[i] + 0.1 * g;
      v[i] = 0.999 * v[i] + 0.001 * g * g;
      p[i] -= (lr * (m[i] / (1 - 0.9 ** s))) / (Math.sqrt(v[i] / (1 - 0.999 ** s)) + 1e-8);
    }
    if (s % 25 === 0) {
      const loss = validLoss();
      if (loss < bestLoss) {
        bestLoss = loss;
        bestParams = Float64Array.from(p);
      }
    }
  }
  p.set(bestParams);
  const netPred = x.map((f) => forward(f));
  const network = r2(netPred, y, split, pairs) > best.score + 0.01;
  if (!network) {
    p.fill(0);
    p[b2] = coef[0];
    for (let i = 0; i < inputs; i++) p[skip + i] = coef[i + 1];
  }
  weights.set(p);
  dynamics.lag = best.lag;
  const pred = network ? netPred : linearPred;
  return { dynamics, report: { lag: best.lag, r2Train: r2(pred, y, 0, split), r2Valid: r2(pred, y, split, pairs), network } };
}

// ---------------------------------------------------------------------------
// Population.

/** Where particles can be seen: frame size, analysed region and per-frame tile masks. */
export interface Visibility {
  width: number;
  height: number;
  region: [number, number, number, number];
  tile: number;
  columns: number;
  rows: number;
  /** Frame index of masks[0]. */
  first: number;
  masks: Uint8Array[];
}

/** Mean distance a track's particle moves per frame (px). */
export function pathSpeed(track: Track): number {
  const p = track.points;
  let path = 0;
  for (let k = 1; k < p.length; k++) path += Math.hypot(p[k].x - p[k - 1].x, p[k].y - p[k - 1].y);
  return path / Math.max(1, p[p.length - 1].frame - p[0].frame);
}

/**
 * Whether a fit is close enough to its track: within `maxRms` px, or within `maxLag` frames of the
 * particle's motion (errors in the clock move fast particles off their fits in proportion to their speed).
 */
export function fitsWell(track: Track, f: ProjectiveFit, maxRms: number, maxLag: number): boolean {
  return f.rms <= Math.max(maxRms, maxLag * pathSpeed(track));
}

/** Track fits for extrapolation (with the prior on B) in the clock's time; null for tracks shorter than `minPoints`. */
export function extrapolationFits(tracks: readonly Track[], clock: ClockFit, center: [number, number], minPoints: number): (ProjectiveFit | null)[] {
  const at = (frame: number) => clock.tau[Math.max(0, Math.min(clock.tau.length - 1, frame - clock.first))];
  return tracks.map((t) => (t.points.length >= minPoints ? fitTrack(t.points, at, center[0], center[1], B_PRIOR) : null));
}

export interface StitchOptions {
  /** Longest gap bridged (frames). */
  maxGap: number;
  /** Fragments need this many points to predict across a gap. */
  minPoints: number;
  /** Gate: px plus this share of the distance across the gap. */
  gateBase: number;
  gateShare: number;
  /** Joined tracks that do not fit well (see fitsWell) fall apart into their fragments again. */
  maxRms: number;
  maxLag: number;
}

export const DEFAULT_STITCH: StitchOptions = { maxGap: 90, minPoints: 4, gateBase: 3, gateShare: 0.05, maxRms: 2, maxLag: 2.5 };

/**
 * Joins the fragments of one particle's flight, broken where it passed behind something or where the
 * tracker lost it on a sudden speed-up: a fragment's end joins a later fragment's start when each one's
 * fit predicts the other across the gap. Extrapolating fragments instead would draw the same flight twice.
 */
export function stitchTracks(tracks: readonly Track[], clock: ClockFit, center: [number, number], options: StitchOptions = DEFAULT_STITCH): { tracks: Track[]; links: number } {
  const [cx, cy] = center;
  const at = (frame: number) => clock.tau[Math.max(0, Math.min(clock.tau.length - 1, frame - clock.first))];
  const fits = extrapolationFits(tracks, clock, center, options.minPoints);
  const starts = new Map<number, number[]>();
  tracks.forEach((t, j) => {
    if (!fits[j]) return;
    const frame = t.points[0].frame;
    (starts.get(frame) ?? starts.set(frame, []).get(frame)!).push(j);
  });
  const predict = (f: ProjectiveFit, frame: number): [number, number] | null => {
    const a = at(frame) - f.tau0;
    if (1 - f.w * a < MIN_DEPTH) return null;
    const [x, y] = fitPosition(f, a);
    return [x + cx, y + cy];
  };
  const pairs: { i: number; j: number; cost: number }[] = [];
  tracks.forEach((t, i) => {
    const f = fits[i];
    if (!f) return;
    const last = t.points[t.points.length - 1];
    for (let frame = last.frame + 1; frame <= last.frame + options.maxGap; frame++) {
      const candidates = starts.get(frame);
      if (!candidates) continue;
      const ahead = predict(f, frame);
      if (!ahead) break;
      for (const j of candidates) {
        const first = tracks[j].points[0];
        const gate = options.gateBase + options.gateShare * Math.hypot(first.x - last.x, first.y - last.y);
        const d1 = Math.hypot(ahead[0] - first.x, ahead[1] - first.y);
        if (d1 > gate) continue;
        const back = predict(fits[j]!, last.frame);
        if (!back) continue;
        const d2 = Math.hypot(back[0] - last.x, back[1] - last.y);
        if (d2 <= gate) pairs.push({ i, j, cost: (d1 + d2) / gate });
      }
    }
  });
  pairs.sort((a, b) => a.cost - b.cost);
  const next = new Int32Array(tracks.length).fill(-1);
  const previous = new Int32Array(tracks.length).fill(-1);
  for (const { i, j } of pairs) {
    if (next[i] >= 0 || previous[j] >= 0) continue;
    next[i] = j;
    previous[j] = i;
  }
  const out: Track[] = [];
  let links = 0;
  tracks.forEach((t, i) => {
    if (previous[i] >= 0) return;
    const chain = [i];
    while (next[chain[chain.length - 1]] >= 0) chain.push(next[chain[chain.length - 1]]);
    if (chain.length === 1) {
      out.push(t);
      return;
    }
    const joined: Track = { id: t.id, points: chain.flatMap((k) => tracks[k].points) };
    const f = fitTrack(joined.points, at, cx, cy, B_PRIOR);
    if (f && fitsWell(joined, f, options.maxRms, options.maxLag)) {
      out.push(joined);
      links += chain.length - 1;
    } else for (const k of chain) out.push(tracks[k]);
  });
  return { tracks: out, links };
}

/** Whether frame `frame` was analysed around (x, y): every tile within `reach` tiles is analysed. */
export function clearAround(v: Visibility, frame: number, x: number, y: number, reach: number): boolean {
  const mask = v.masks[frame - v.first];
  if (!mask) return false;
  const tx = Math.floor((x - v.region[0]) / v.tile);
  const ty = Math.floor((y - v.region[1]) / v.tile);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const cx = tx + dx;
      const cy = ty + dy;
      if (cx < 0 || cy < 0 || cx >= v.columns || cy >= v.rows || !mask[cy * v.columns + cx]) return false;
    }
  }
  return true;
}

export interface PopulationOptions {
  /** Tracks with fewer points, or that their fits do not fit well (see fitsWell), are not used. */
  minPoints: number;
  maxRms: number;
  maxLag: number;
  /** Particles that come out from behind something are born where their radius was this share of the first seen one. */
  birthShare: number;
  /** Longest extrapolation before the first point and after the last (clock seconds). */
  maxBack: number;
  maxAhead: number;
  /** Adds the mirror image of every prototype (left-right). */
  mirror: boolean;
  maxPrototypes: number;
  seed: number;
}

export const DEFAULT_POPULATION: PopulationOptions = { minPoints: 8, maxRms: 1.5, maxLag: 2.5, birthShare: 0.5, maxBack: 10, maxAhead: 6, mirror: true, maxPrototypes: 1024, seed: 7 };

export interface Population {
  prototypes: Float32Array;
  weights: Float32Array;
  opacityOverLife: Float32Array;
  /** Births per clock second, from the tracks seen (before calibration). */
  rate: number;
  maxLife: number;
  /** The track each prototype came from (before mirroring), for sprite assignment. */
  sources: Track[];
  /** The tracks' extrapolation fits (aligned with the tracks given). */
  fits: (ProjectiveFit | null)[];
  stats: { used: number; emerged: number; censored: number };
}

/**
 * Prototypes from fitted tracks: each one's state at birth in model units (see model.ts). A particle
 * that came out from behind a mask or the region's edge is extrapolated back to an earlier birth;
 * one that leaves the frame, goes behind a mask or outlives the window flies on until it would leave
 * the frame. `sprite(track)` gives each its sprite class.
 */
export function buildPopulation(
  tracks: readonly Track[],
  clock: ClockFit,
  center: [number, number],
  visibility: Visibility,
  sprite: (track: Track) => number,
  options: PopulationOptions = DEFAULT_POPULATION,
): Population {
  const [cx, cy] = center;
  const H = visibility.height;
  const lastFrame = clock.first + clock.tau.length - 1;
  const at = (frame: number) => clock.tau[Math.max(0, Math.min(clock.tau.length - 1, frame - clock.first))];
  const fits = extrapolationFits(tracks, clock, center, options.minPoints);
  const states: number[][] = [];
  const sources: Track[] = [];
  const curve: number[][] = Array.from({ length: LIFE_SAMPLES }, () => []);
  let emergedCount = 0;
  let censoredCount = 0;
  const inFrame = (x: number, y: number, margin: number) => x >= -margin && y >= -margin && x <= visibility.width + margin && y <= visibility.height + margin;
  tracks.forEach((track, i) => {
    const f = fits[i];
    if (!f || !fitsWell(track, f, options.maxRms, options.maxLag)) return;
    const firstPoint = track.points[0];
    const lastPoint = track.points[track.points.length - 1];
    const r0 = Math.hypot(f.ax, f.ay);
    const emerged = firstPoint.frame - clock.first < 2 || !clearAround(visibility, firstPoint.frame, firstPoint.x, firstPoint.y, 2);
    const censored = lastFrame - lastPoint.frame < 2 || !clearAround(visibility, lastPoint.frame, lastPoint.x, lastPoint.y, 2);
    const radius = (a: number) => {
      const [x, y] = fitPosition(f, a);
      return Math.hypot(x, y);
    };
    // Birth: back along the fit until the radius has shrunk to birthShare of the first seen one.
    let birth = 0;
    if (emerged) {
      emergedCount++;
      let lo = -options.maxBack;
      // Stay in front of the camera when receding (w < 0).
      if (f.w < 0) lo = Math.max(lo, -(1 - MIN_DEPTH) / -f.w);
      if (radius(lo) > options.birthShare * r0) birth = lo;
      else {
        let hi = 0;
        for (let k = 0; k < 40; k++) {
          const mid = 0.5 * (lo + hi);
          if (radius(mid) > options.birthShare * r0) hi = mid;
          else lo = mid;
        }
        birth = hi;
      }
    }
    // Death: the last point, or on along the fit until the particle leaves the frame.
    const end = at(lastPoint.frame) - f.tau0;
    let death = end + 1 / 60;
    if (censored) {
      censoredCount++;
      const limit = f.w > 0 ? Math.min(end + options.maxAhead, (1 - MIN_DEPTH) / f.w) : end + options.maxAhead;
      let a = end;
      const dt = 1 / 60;
      while (a < limit) {
        const [x, y] = fitPosition(f, a);
        if (!inFrame(x + cx, y + cy, 24)) break;
        a += dt;
      }
      death = Math.max(end + dt, Math.min(a, limit));
    }
    const life = death - birth;
    if (!(life > 0)) return;
    // State at birth, rescaled so that the particle is at depth 1 then.
    const d = 1 - f.w * birth;
    if (!(d > MIN_DEPTH)) return;
    const peaks = track.points.map((p) => p.peak).sort((a, b) => a - b);
    const spreads = track.points.map((p) => p.spread).sort((a, b) => a - b);
    const peak = peaks[peaks.length >> 1];
    const spread = spreads[spreads.length >> 1];
    states.push([
      f.bx / (d * H),
      f.by / (d * H),
      -f.w / d,
      (f.ax + f.bx * birth) / (d * H),
      (f.ay + f.by * birth) / (d * H),
      0,
      spread / H,
      peak,
      life,
      sprite(track),
    ]);
    sources.push(track);
    // Opacity over life from particles seen from birth to death.
    if (!emerged && !censored) {
      for (const p of track.points) {
        const share = (at(p.frame) - f.tau0 - birth) / life;
        const bin = Math.max(0, Math.min(LIFE_SAMPLES - 1, Math.floor(share * LIFE_SAMPLES)));
        curve[bin].push(p.peak / Math.max(1e-6, peak));
      }
    }
  });
  const used = states.length;
  // Subsample deterministically, then mirror.
  const rand = random(options.seed);
  const order = states.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const keep = order.slice(0, Math.max(1, Math.floor(options.maxPrototypes / (options.mirror ? 2 : 1)))).sort((a, b) => a - b);
  const chosen = keep.filter((i) => i < used).map((i) => states[i]);
  const keptSources = keep.filter((i) => i < used).map((i) => sources[i]);
  const all = options.mirror ? chosen.flatMap((s) => [s, mirrored(s)]) : chosen;
  const prototypes = new Float32Array(Math.max(1, all.length) * PROTO_STRIDE);
  all.forEach((s, i) => prototypes.set(s, i * PROTO_STRIDE));
  if (!all.length) {
    // Nothing usable: one dim particle at rest, so the effect still draws something sensible.
    prototypes.set([0, 0, -0.2, 0, 0, 0, 2 / H, 0.2, 2, 0], 0);
  }
  // Opacity curve: median per bin, gaps filled from neighbours, peak 1.
  const opacity = new Float32Array(LIFE_SAMPLES);
  const known: number[] = [];
  for (let b = 0; b < LIFE_SAMPLES; b++) {
    const values = curve[b].sort((a, c) => a - c);
    if (values.length >= 5) {
      opacity[b] = values[values.length >> 1];
      known.push(b);
    } else opacity[b] = NaN;
  }
  if (!known.length) opacity.fill(1);
  else {
    for (let b = 0; b < LIFE_SAMPLES; b++) {
      if (Number.isFinite(opacity[b])) continue;
      const before = known.filter((k) => k < b).pop();
      const after = known.find((k) => k > b);
      opacity[b] = before === undefined ? opacity[after!] : after === undefined ? opacity[before] : opacity[before] + ((opacity[after] - opacity[before]) * (b - before)) / (after - before);
    }
    const top = Math.max(...opacity);
    for (let b = 0; b < LIFE_SAMPLES; b++) opacity[b] = Math.max(0, opacity[b] / top);
  }
  const span = clock.tau[clock.tau.length - 1] - clock.tau[0];
  const rate = ((options.mirror ? 2 : 1) * Math.max(1, used)) / Math.max(1e-6, span);
  let maxLife = 0;
  for (let i = 0; i < all.length; i++) maxLife = Math.max(maxLife, all[i][P_LIFE]);
  return {
    prototypes,
    weights: new Float32Array(Math.max(1, all.length)).fill(1),
    opacityOverLife: opacity,
    rate,
    maxLife: maxLife || 2,
    sources: options.mirror ? keptSources.flatMap((t) => [t, t]) : keptSources,
    fits,
    stats: { used, emerged: emergedCount, censored: censoredCount },
  };
}

function mirrored(s: number[]): number[] {
  const m = s.slice();
  m[P_VX] = -s[P_VX];
  m[P_OX] = -s[P_OX];
  return m;
}

/**
 * How sprite size and light follow depth: the slopes of log spread and log peak against −log depth
 * within tracks (depth 1 − w a relative to the first point), over tracks that come nearer by at least a tenth.
 */
export function depthExponents(tracks: readonly Track[], fits: readonly (ProjectiveFit | null)[], clock: ClockFit): { size: number; light: number; tracks: number } {
  const at = (frame: number) => clock.tau[Math.max(0, Math.min(clock.tau.length - 1, frame - clock.first))];
  let sxx = 0, sxs = 0, sxl = 0;
  let used = 0;
  tracks.forEach((track, i) => {
    const f = fits[i];
    if (!f || f.rms > 2 || track.points.length < 8 || 1 - f.w * f.span > 0.9) return;
    const xs: number[] = [];
    const ss: number[] = [];
    const ls: number[] = [];
    for (const p of track.points) {
      const depth = 1 - f.w * (at(p.frame) - f.tau0);
      if (!(p.spread > 0 && p.peak > 0 && depth >= MIN_DEPTH)) continue;
      xs.push(-Math.log(depth));
      ss.push(Math.log(p.spread));
      ls.push(Math.log(p.peak));
    }
    if (xs.length < 4) return;
    used++;
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    const mx = mean(xs), ms = mean(ss), ml = mean(ls);
    for (let k = 0; k < xs.length; k++) {
      sxx += (xs[k] - mx) ** 2;
      sxs += (xs[k] - mx) * (ss[k] - ms);
      sxl += (xs[k] - mx) * (ls[k] - ml);
    }
  });
  const clampExponent = (v: number) => Math.max(-1, Math.min(2, v));
  return sxx > 1e-6 ? { size: clampExponent(sxs / sxx), light: clampExponent(sxl / sxx), tracks: used } : { size: 0, light: 0, tracks: used };
}

/** Multiplies every prototype's size and amplitude. */
export function scalePrototypes(prototypes: Float32Array, size: number, amplitude: number): void {
  for (let i = 0; i < prototypes.length; i += PROTO_STRIDE) {
    prototypes[i + P_SIZE] *= size;
    prototypes[i + P_AMP] *= amplitude;
  }
}
