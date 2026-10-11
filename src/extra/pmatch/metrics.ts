// Statistics that say whether a model's particles look like its reference video's.
// Both are seen the same way: found by the same detector through the video's own
// masks and linked by the same tracker, so the statistics compare like with like.
import { DETECTION_FLOATS, D_PEAK, D_SPREAD, D_X, D_Y } from "./detect.ts";
import type { SpriteBank } from "./model.ts";
import { canonical, correlation, cropLight, type Crop } from "./sprites.ts";
import { particleDetection, type FrameDetections, type Track } from "./track.ts";

export interface Measures {
  frames: number;
  /** Particles found per frame. */
  count: number;
  peaks: number[];
  spreads: number[];
  /** Distance from the emitter (px). */
  radii: number[];
  /** Outward steps over two frames (sources at 30 fps move every other frame): frame of the later point, radius between, px per frame. */
  steps: { frame: number; r: number; speed: number }[];
}

export function measure(frames: readonly FrameDetections[], tracks: readonly Track[], center: readonly [number, number]): Measures {
  const [cx, cy] = center;
  const peaks: number[] = [];
  const spreads: number[] = [];
  const radii: number[] = [];
  for (const f of frames) {
    for (let at = 0; at < f.data.length; at += DETECTION_FLOATS) {
      if (!particleDetection(f.data, at)) continue;
      peaks.push(f.data[at + D_PEAK]);
      spreads.push(f.data[at + D_SPREAD]);
      radii.push(Math.hypot(f.data[at + D_X] - cx, f.data[at + D_Y] - cy));
    }
  }
  const steps: Measures["steps"] = [];
  for (const t of tracks) {
    const byFrame = new Map(t.points.map((p) => [p.frame, p]));
    for (const p of t.points) {
      const q = byFrame.get(p.frame + 2);
      if (!q) continue;
      const r0 = Math.hypot(p.x - cx, p.y - cy);
      const r1 = Math.hypot(q.x - cx, q.y - cy);
      steps.push({ frame: q.frame, r: 0.5 * (r0 + r1), speed: (r1 - r0) / 2 });
    }
  }
  return { frames: frames.length, count: frames.length ? peaks.length / frames.length : 0, peaks, spreads, radii, steps };
}

/** Two-sample Kolmogorov–Smirnov statistic (largest gap between the two empirical distributions). */
export function ks(a: readonly number[], b: readonly number[]): number {
  if (!a.length || !b.length) return 1;
  const x = a.slice().sort((p, q) => p - q);
  const y = b.slice().sort((p, q) => p - q);
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i], y[j]);
    while (i < x.length && x[i] <= v) i++;
    while (j < y.length && y[j] <= v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  return d;
}

export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

export function median(values: readonly number[]): number {
  if (!values.length) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

export interface Comparison {
  /** Ours over the reference's particles per frame. */
  countRatio: number;
  ksPeak: number;
  ksSpread: number;
  ksRadius: number;
  /** Ours over the reference's median outward speed in each quarter of the reference's radii. */
  quartileSpeed: number[];
  /** Correlation of the median outward speed per quarter second, and over how many quarter seconds. */
  speedSeries: number;
  bins: number;
  /** Median outward speed of the reference and the model in tenths of the reference's radii (upper radius of each). */
  profile: { r: number; reference: number; model: number }[];
}

export interface SpriteMatch {
  /** Crops nearest to the class's template, and the correlation of their mean with it. */
  crops: number;
  correlation: number;
}

/**
 * Crops resampled to a bank's templates, each with the class whose template it correlates with most. The
 * crop's own mean and spread scale every correlation alike, so the class is the one whose centred, unit
 * template has the largest dot product with the crop.
 */
function classified(bank: SpriteBank, crops: readonly Crop[]): { template: Float32Array; best: number }[] {
  const n = bank.size * bank.size;
  const units = Array.from({ length: bank.count }, (_, k) => {
    const t = bank.data.subarray(k * n, (k + 1) * n);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += t[i];
    mean /= n;
    const unit = new Float64Array(n);
    let norm = 0;
    for (let i = 0; i < n; i++) {
      unit[i] = t[i] - mean;
      norm += unit[i] * unit[i];
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < n; i++) unit[i] = norm > 0 ? unit[i] / norm : 0;
    return unit;
  });
  const out: { template: Float32Array; best: number }[] = [];
  for (const crop of crops) {
    const c = canonical(crop, bank.size, bank.size / 2 / bank.reach);
    if (!c) continue;
    let best = 0;
    let bestScore = -Infinity;
    units.forEach((unit, k) => {
      let score = 0;
      for (let i = 0; i < n; i++) score += c.template[i] * unit[i];
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    });
    out.push({ template: c.template, best });
  }
  return out;
}

/** Each sprite class's template against the mean of the crops that look most like it. */
export function spriteMatch(bank: SpriteBank, crops: readonly Crop[]): SpriteMatch[] {
  const n = bank.size * bank.size;
  const sums = Array.from({ length: bank.count }, () => new Float32Array(n));
  const counts = sums.map(() => 0);
  for (const { template, best } of classified(bank, crops)) {
    for (let i = 0; i < n; i++) sums[best][i] += template[i];
    counts[best]++;
  }
  return sums.map((sum, k) => ({ crops: counts[k], correlation: counts[k] ? correlation(sum, bank.data.subarray(k * n, (k + 1) * n)) : NaN }));
}

/** The share of crops that look most like each of the bank's sprites. */
export function classShares(bank: SpriteBank, crops: readonly Crop[]): number[] {
  const counts = new Array<number>(bank.count).fill(0);
  const sorted = classified(bank, crops);
  for (const { best } of sorted) counts[best]++;
  return counts.map((c) => (sorted.length ? c / sorted.length : 0));
}

/** Reach (px) of the radial light profiles: a particle's halo. */
const HALO = 16;

/** Mean light at whole-pixel radii 0..HALO around the crops' centres over their peak, by thirds of `edges`. */
function radialProfiles(crops: readonly Crop[], edges: readonly number[]): number[][] {
  const sums = [0, 1, 2].map(() => new Float64Array(HALO + 1));
  const counts = [0, 1, 2].map(() => new Float64Array(HALO + 1));
  for (const crop of crops) {
    const { lum, peak } = cropLight(crop);
    if (!(peak > 1e-3)) continue;
    const third = peak < edges[0] ? 0 : peak < edges[1] ? 1 : 2;
    const side = Math.round(Math.sqrt(lum.length));
    const half = (side - 1) / 2;
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const r = Math.round(Math.hypot(x - half, y - half));
        if (r > HALO) continue;
        sums[third][r] += lum[y * side + x] / peak;
        counts[third][r]++;
      }
    }
  }
  return sums.map((s, t) => Array.from(s, (v, r) => (counts[t][r] ? v / counts[t][r] : 0)));
}

export interface LightProfiles {
  /** Peaks splitting the reference's crops into thirds (they split the model's too). */
  edges: number[];
  /** Mean light over the peak at radii 0..16 px, per third. */
  reference: number[][];
  model: number[][];
  /** Per third: the summed difference of the light in each one-pixel ring, over the reference's light. */
  distance: number[];
}

/** How the light of reference and model particles falls off from their centre out to their halo, by brightness third. */
export function lightProfiles(reference: readonly Crop[], model: readonly Crop[]): LightProfiles {
  const peaks = reference.map((c) => cropLight(c).peak).filter((p) => p > 1e-3).sort((a, b) => a - b);
  const edges = [1 / 3, 2 / 3].map((q) => peaks[Math.floor(q * (peaks.length - 1))] ?? 0);
  const ours = radialProfiles(reference, edges);
  const theirs = radialProfiles(model, edges);
  // A ring of radius r holds about 2πr pixels (the centre a quarter of one).
  const ring = (r: number) => (r ? r : 0.25);
  const distance = ours.map((profile, t) => {
    let diff = 0;
    let total = 0;
    profile.forEach((v, r) => {
      diff += ring(r) * Math.abs(v - theirs[t][r]);
      total += ring(r) * v;
    });
    return total > 0 ? diff / total : NaN;
  });
  return { edges, reference: ours, model: theirs, distance };
}

export function compare(reference: Measures, ours: Measures, frameRate: number): Comparison {
  const radii = reference.steps.map((s) => s.r).sort((a, b) => a - b);
  const edges = [0.25, 0.5, 0.75].map((q) => radii[Math.floor(q * (radii.length - 1))] ?? 0);
  const quarter = (r: number) => (r < edges[0] ? 0 : r < edges[1] ? 1 : r < edges[2] ? 2 : 3);
  const quartileSpeed = [0, 1, 2, 3].map((k) => {
    const a = median(reference.steps.filter((s) => quarter(s.r) === k).map((s) => s.speed));
    const b = median(ours.steps.filter((s) => quarter(s.r) === k).map((s) => s.speed));
    return a > 0 ? b / a : NaN;
  });
  const bin = Math.max(1, Math.round(frameRate / 4));
  const series = (m: Measures) => {
    const groups = new Map<number, number[]>();
    for (const s of m.steps) {
      const k = Math.floor(s.frame / bin);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(s.speed);
    }
    return groups;
  };
  const a = series(reference);
  const b = series(ours);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [k, values] of a) {
    const other = b.get(k);
    if (values.length < 10 || !other || other.length < 10) continue;
    xs.push(median(values));
    ys.push(median(other));
  }
  const tenths = Array.from({ length: 10 }, (_, k) => radii[Math.min(radii.length - 1, Math.floor(((k + 1) / 10) * radii.length))] ?? 0);
  const tenth = (r: number) => {
    const k = tenths.findIndex((edge) => r <= edge);
    return k < 0 ? 9 : k;
  };
  const profile = tenths.map((r, k) => ({
    r,
    reference: median(reference.steps.filter((s) => tenth(s.r) === k).map((s) => s.speed)),
    model: median(ours.steps.filter((s) => tenth(s.r) === k).map((s) => s.speed)),
  }));
  return {
    profile,
    countRatio: reference.count > 0 ? ours.count / reference.count : NaN,
    ksPeak: ks(reference.peaks, ours.peaks),
    ksSpread: ks(reference.spreads, ours.spreads),
    ksRadius: ks(reference.radii, ours.radii),
    quartileSpeed,
    speedSeries: pearson(xs, ys),
    bins: xs.length,
  };
}
