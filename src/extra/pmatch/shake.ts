// How a reference video's picture shakes, and Sapphire S_Shake settings that shake like it.
//
// Measuring: per frame, the GPU averages 8×8 blocks of the frame's grey levels (only that small copy
// comes back), and Gauss–Newton over a three-level pyramid finds the shift, rotation and scale about
// the frame centre that carry the previous frame's copy onto this one's (inverse compositional), with
// Cauchy weights so that particles, bars and lettering moving on their own count little. Each level is
// normalized to zero mean and unit spread first, so brightness pulses are not motion. A frame the
// previous one does not match (a cut, a flash) moves nothing.
//
// Learning: the motions add up to the picture's path; less its one-second running mean (camera moves,
// drift), that is the shake. How fast it changes gives S_Shake's Frequency: the look-alike's noise
// (sapphireShake.ts), sampled and filtered the same way, is matched by how soon its autocorrelation
// falls to one half. Its strength over time is the Amplitude (the shake's running RMS, scaled so that
// its 95th percentile is 1), and its X, Y and Tilt give the random amplitudes. The Amplitude follows
// the music by a ridge regression on the audio features at the best lag, as the clock does (fit.ts).
import { shakeNoise, stillShake, type ShakeParams } from "../../render/effects/sapphireShake.ts";
import type { AudioFeatures } from "./audio.ts";
import { featuresAt, r2, ridge, solve } from "./fit.ts";
import { readFloats, type Gpu, type Surface } from "./gpu.ts";

/** Frame pixels per thumbnail pixel. */
const BLOCK = 8;
const LEVELS = 3;
/** Gauss–Newton steps per pyramid level, finest first. */
const STEPS = [2, 3, 6];
/** Thumbnail pixels left out along the edges (letterboxing, blocks the frame edge cuts). */
const BORDER = 2;
/** Cauchy tuning constant (95 % efficiency), in robust spreads of the residuals. */
const CAUCHY = 2.385;
/** Mean Cauchy weight below which a frame does not match the previous one. */
const MIN_AGREEMENT = 0.35;
/** Seconds the running mean that separates the shake from slow motion spans. */
const SLOW_WINDOW = 1;
/** Shake below this RMS (source pixels) is no shake. */
const MIN_SHAKE = 0.75;
/** Frequencies tried, shakes per second. */
const FREQUENCIES = Array.from({ length: 49 }, (_, i) => 0.25 * 2 ** (i / 8));
/** Lags tried between the music and the shake, seconds. */
const LAGS = Array.from({ length: 19 }, (_, i) => -0.05 + i / 60);
/** Regression R² (held back fifth) below which the Amplitude is taken not to follow the music. */
const MIN_R2 = 0.1;

const THUMB_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform int u_blocks;
out vec4 outColor;
float block(int bx, int by) {
  if (bx >= u_blocks) return 0.0;
  ivec2 o = ivec2(bx, by) * ${BLOCK};
  float sum = 0.0;
  for (int j = 0; j < ${BLOCK}; j++)
    for (int i = 0; i < ${BLOCK}; i++) sum += dot(texelFetch(u_src, o + ivec2(i, j), 0).rgb, vec3(0.2126, 0.7152, 0.0722));
  return sum / ${BLOCK * BLOCK}.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = vec4(block(p.x * 4, p.y), block(p.x * 4 + 1, p.y), block(p.x * 4 + 2, p.y), block(p.x * 4 + 3, p.y));
}`;

/** A pyramid level: normalized grey levels and their gradients, rows top first. */
export interface Level {
  width: number;
  height: number;
  value: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
}

/** How the picture moved since the previous frame, about the frame centre. */
export interface FrameMotion {
  /** Shift, frame pixels (y down). */
  dx: number;
  dy: number;
  /** Rotation (radians, clockwise on screen) and log scale. */
  angle: number;
  logScale: number;
  /** Mean Cauchy weight: the share of the picture that moved together. */
  agreement: number;
}

function normalized(raw: Float32Array, width: number, height: number): Level {
  let sum = 0;
  let squares = 0;
  let n = 0;
  for (let y = BORDER; y < height - BORDER; y++) {
    for (let x = BORDER; x < width - BORDER; x++) {
      const v = raw[y * width + x];
      sum += v;
      squares += v * v;
      n++;
    }
  }
  const mean = n ? sum / n : 0;
  const spread = Math.sqrt(Math.max(1e-10, n ? squares / n - mean * mean : 0));
  const value = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) value[i] = (raw[i] - mean) / spread;
  const gx = new Float32Array(raw.length);
  const gy = new Float32Array(raw.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      gx[i] = 0.5 * (value[i + 1] - value[i - 1]);
      gy[i] = 0.5 * (value[i + width] - value[i - width]);
    }
  }
  return { width, height, value, gx, gy };
}

/** The pyramid of a grey picture (rows top first), finest level first. */
export function pyramid(grey: Float32Array, width: number, height: number): Level[] {
  const levels: Level[] = [];
  let raw = grey;
  let w = width;
  let h = height;
  for (let l = 0; l < LEVELS; l++) {
    levels.push(normalized(raw, w, h));
    if (l === LEVELS - 1) break;
    const hw = w >> 1;
    const hh = h >> 1;
    const half = new Float32Array(hw * hh);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        const i = 2 * y * w + 2 * x;
        half[y * hw + x] = 0.25 * (raw[i] + raw[i + 1] + raw[i + w] + raw[i + w + 1]);
      }
    }
    raw = half;
    w = hw;
    h = hh;
  }
  return levels;
}

/**
 * The similarity (about the picture centre) that carries `from` onto `to`, as the 2×3 matrix
 * [a, -b, tx, b, a, ty] in finest-level pixels, and the share of the picture that agrees with it.
 */
export function register(from: Level[], to: Level[]): { matrix: number[]; agreement: number } {
  // m maps `from`'s centred coordinates to `to`'s.
  const m = [1, 0, 0, 0, 1, 0];
  let agreement = 0;
  const hessian = new Float64Array(16);
  const gradient = new Float64Array(4);
  for (let l = LEVELS - 1; l >= 0; l--) {
    if (l < LEVELS - 1) {
      m[2] *= 2;
      m[5] *= 2;
    }
    const t = from[l];
    const im = to[l];
    const cx = t.width / 2;
    const cy = t.height / 2;
    let scale = 0;
    for (let step = 0; step < STEPS[l]; step++) {
      const residual = (x: number, y: number): number => {
        const ux = x + 0.5 - cx;
        const uy = y + 0.5 - cy;
        const qx = m[0] * ux + m[1] * uy + m[2] + cx - 0.5;
        const qy = m[3] * ux + m[4] * uy + m[5] + cy - 0.5;
        if (!(qx >= 0 && qy >= 0 && qx < im.width - 1 && qy < im.height - 1)) return NaN;
        const x0 = Math.floor(qx);
        const y0 = Math.floor(qy);
        const fx = qx - x0;
        const fy = qy - y0;
        const i = y0 * im.width + x0;
        const top = im.value[i] + (im.value[i + 1] - im.value[i]) * fx;
        const bottom = im.value[i + im.width] + (im.value[i + im.width + 1] - im.value[i + im.width]) * fx;
        return top + (bottom - top) * fy - t.value[y * t.width + x];
      };
      if (step === 0) {
        // Robust spread of the residuals from every third pixel.
        const sample: number[] = [];
        for (let y = BORDER; y < t.height - BORDER; y += 3) {
          for (let x = BORDER; x < t.width - BORDER; x += 3) {
            const e = residual(x, y);
            if (e === e) sample.push(Math.abs(e));
          }
        }
        sample.sort((a, b) => a - b);
        scale = CAUCHY * Math.max(0.02, 1.4826 * (sample[sample.length >> 1] ?? 1));
      }
      let h00 = 0, h01 = 0, h02 = 0, h03 = 0, h11 = 0, h12 = 0, h13 = 0, h22 = 0, h23 = 0, h33 = 0;
      let g0 = 0, g1 = 0, g2 = 0, g3 = 0;
      let weights = 0;
      let count = 0;
      for (let y = BORDER; y < t.height - BORDER; y++) {
        const uy = y + 0.5 - cy;
        for (let x = BORDER; x < t.width - BORDER; x++) {
          const e = residual(x, y);
          if (e !== e) continue;
          const ux = x + 0.5 - cx;
          const i = y * t.width + x;
          // Steepest descent images: ∇T · ∂W/∂p at p = 0.
          const s0 = t.gx[i];
          const s1 = t.gy[i];
          const s2 = s0 * ux + s1 * uy;
          const s3 = s1 * ux - s0 * uy;
          const r = e / scale;
          const w = 1 / (1 + r * r);
          const we = w * e;
          g0 += s0 * we;
          g1 += s1 * we;
          g2 += s2 * we;
          g3 += s3 * we;
          const w0 = w * s0;
          const w1 = w * s1;
          const w2 = w * s2;
          h00 += w0 * s0;
          h01 += w0 * s1;
          h02 += w0 * s2;
          h03 += w0 * s3;
          h11 += w1 * s1;
          h12 += w1 * s2;
          h13 += w1 * s3;
          h22 += w2 * s2;
          h23 += w2 * s3;
          h33 += w * s3 * s3;
          weights += w;
          count++;
        }
      }
      if (count < 16) return { matrix: [1, 0, 0, 0, 1, 0], agreement: 0 };
      hessian.set([h00, h01, h02, h03, h01, h11, h12, h13, h02, h12, h22, h23, h03, h13, h23, h33]);
      gradient.set([g0, g1, g2, g3]);
      agreement = weights / count;
      const delta = solve(hessian, gradient, 4);
      if (!delta) break;
      // m ← m ∘ W(delta)⁻¹, W(p): u ↦ [[1 + p2, -p3], [p3, 1 + p2]] u + (p0, p1).
      const a = 1 + delta[2];
      const b = delta[3];
      const det = a * a + b * b;
      const i00 = a / det;
      const i01 = b / det;
      const i10 = -b / det;
      const i11 = a / det;
      const itx = -(i00 * delta[0] + i01 * delta[1]);
      const ity = -(i10 * delta[0] + i11 * delta[1]);
      const [m0, m1, m2, m3, m4, m5] = m;
      m[0] = m0 * i00 + m1 * i10;
      m[1] = m0 * i01 + m1 * i11;
      m[2] = m0 * itx + m1 * ity + m2;
      m[3] = m3 * i00 + m4 * i10;
      m[4] = m3 * i01 + m4 * i11;
      m[5] = m3 * itx + m4 * ity + m5;
      if (Math.abs(delta[0]) + Math.abs(delta[1]) < 1e-3 && Math.abs(delta[2]) + Math.abs(delta[3]) < 1e-5) break;
    }
  }
  return { matrix: m, agreement };
}

/** The motion `register` found, in frame pixels. */
export function motionOf(matrix: number[], agreement: number, block = BLOCK): FrameMotion {
  return {
    dx: matrix[2] * block,
    dy: matrix[5] * block,
    angle: Math.atan2(matrix[3], matrix[0]),
    logScale: 0.5 * Math.log(Math.max(1e-6, matrix[0] * matrix[4] - matrix[1] * matrix[3])),
    agreement,
  };
}

/** Measures each frame's motion since the frame before it. */
export class ShakeMeter {
  private readonly gpu: Gpu;
  private readonly blocks: [number, number];
  private readonly thumb: Surface;
  private readonly pixels: Float32Array;
  private readonly grey: Float32Array;
  private previous: Level[] | null = null;

  constructor(gpu: Gpu, width: number, height: number) {
    this.gpu = gpu;
    this.blocks = [Math.floor(width / BLOCK), Math.floor(height / BLOCK)];
    const columns = Math.ceil(this.blocks[0] / 4);
    this.thumb = gpu.surface(columns, this.blocks[1], gpu.gl.RGBA32F);
    this.pixels = new Float32Array(columns * this.blocks[1] * 4);
    this.grey = new Float32Array(this.blocks[0] * this.blocks[1]);
  }

  /** The motion of `frame` (rows top first) since the previous call's frame; null for the first. */
  measure(frame: WebGLTexture): FrameMotion | null {
    const { gpu, thumb, pixels, grey } = this;
    const [bw, bh] = this.blocks;
    gpu.pass(gpu.program(THUMB_FS), thumb, [frame], (u) => {
      gpu.gl.uniform1i(u("u_src"), 0);
      gpu.gl.uniform1i(u("u_blocks"), bw);
    });
    readFloats(gpu.gl, thumb.framebuffer, 0, thumb.width, thumb.height, pixels);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) grey[y * bw + x] = pixels[(y * thumb.width + (x >> 2)) * 4 + (x & 3)];
    const levels = pyramid(grey, bw, bh);
    const previous = this.previous;
    this.previous = levels;
    if (!previous) return null;
    const { matrix, agreement } = register(previous, levels);
    return motionOf(matrix, agreement);
  }

  dispose(): void {
    this.gpu.release(this.thumb);
  }
}

/** The shake of a window: per frame, the picture's offset from its running mean. */
export interface ShakeTrack {
  /** Frame pixels, y down. */
  x: Float64Array;
  y: Float64Array;
  /** Degrees, clockwise on screen. */
  tilt: Float64Array;
  /** Frames whose motion was measured. */
  valid: Uint8Array;
}

/** Centred running mean over `half` frames each side (fewer at the ends). */
function runningMean(v: Float64Array, half: number): Float64Array {
  const n = v.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + v[i];
  return Float64Array.from({ length: n }, (_, i) => {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    return (prefix[b] - prefix[a]) / (b - a);
  });
}

/** The shake in `motions` (frame k's motion since frame k − 1; null where not measured). */
export function shakeTrack(motions: readonly (FrameMotion | null)[], frameRate: number): ShakeTrack {
  const n = motions.length;
  const path = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const valid = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const m = motions[k];
    const ok = !!m && m.agreement >= MIN_AGREEMENT;
    valid[k] = ok ? 1 : 0;
    const step = ok ? [m.dx, m.dy, (m.angle * 180) / Math.PI] : [0, 0, 0];
    for (let c = 0; c < 3; c++) path[c][k] = (k ? path[c][k - 1] : 0) + step[c];
  }
  const half = Math.max(1, Math.round((frameRate * SLOW_WINDOW) / 2));
  const [x, y, tilt] = path.map((p) => {
    const slow = runningMean(p, half);
    return p.map((v, k) => v - slow[k]);
  });
  return { x, y, tilt, valid };
}

/** How S_Shake shakes the picture, learned from a reference. */
export interface ShakeModel {
  /** S_Shake Frequency: new random positions per second. */
  frequency: number;
  /** X and Y Rand Amp at Amplitude 1, source pixels, and Tilt Rand Amp, degrees. */
  x: number;
  y: number;
  tilt: number;
  /** Amplitude from the music: bias + weights · features(t − lag), at least 0. */
  bias: number;
  weights: number[];
  lag: number;
  /** Amplitude without a soundtrack. */
  level: number;
}

export interface ShakeReport {
  /** RMS of the shake, source pixels and degrees. */
  rms: number;
  tiltRms: number;
  /** R² of the Amplitude from the music on the held-back last fifth (0 without music). */
  r2: number;
}

/** Lag (frames, interpolated) at which a signal's autocorrelation first falls to one half. */
function halfLife(signals: readonly Float64Array[], valid: Uint8Array | null): number {
  const n = signals[0].length;
  let zero = 0;
  let previous = 1;
  for (let lag = 0; lag < Math.min(n - 1, 600); lag++) {
    let sum = 0;
    for (const s of signals) for (let k = 0; k + lag < n; k++) if (!valid || (valid[k] && valid[k + lag])) sum += s[k] * s[k + lag];
    if (lag === 0) {
      zero = sum;
      if (zero <= 0) return 0;
      continue;
    }
    const r = sum / zero;
    if (r <= 0.5) return lag - 1 + (previous - 0.5) / Math.max(1e-9, previous - r);
    previous = r;
  }
  return Math.min(n - 1, 600);
}

/** The look-alike's X and Y noise at `frequency`, sampled at `frameRate` and filtered as `shakeTrack` does. */
function filteredNoise(frequency: number, frameRate: number, frames: number): Float64Array[] {
  const half = Math.max(1, Math.round((frameRate * SLOW_WINDOW) / 2));
  return [0, 5].map((stream) => {
    const v = Float64Array.from({ length: frames }, (_, k) => shakeNoise((k / frameRate) * frequency, stream));
    const slow = runningMean(v, half);
    return v.map((x, k) => x - slow[k]);
  });
}

const rms = (values: Iterable<number>): number => {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    sum += v * v;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
};

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const x = q * (sorted.length - 1);
  const i = Math.floor(x);
  return sorted[i] + ((sorted[Math.min(sorted.length - 1, i + 1)] ?? sorted[i]) - sorted[i]) * (x - i);
}

/**
 * S_Shake settings that shake like `track` (frames of a window starting at `start` seconds), with the
 * Amplitude following `features`; null when the picture does not shake.
 */
export function fitShake(track: ShakeTrack, frameRate: number, start: number, features: AudioFeatures | null): { shake: ShakeModel | null; report: ShakeReport } {
  const n = track.x.length;
  const kept = Array.from({ length: n }, (_, k) => k).filter((k) => track.valid[k]);
  const motion = rms(kept.map((k) => Math.hypot(track.x[k], track.y[k])));
  const tiltRms = rms(kept.map((k) => track.tilt[k]));
  const none = { shake: null, report: { rms: motion, tiltRms, r2: 0 } };
  if (kept.length < 2 * frameRate || motion < MIN_SHAKE) return none;

  // Frequency: the look-alike's noise whose autocorrelation falls to one half after as many frames.
  const measured = halfLife([track.x, track.y], track.valid);
  const frames = Math.max(n, Math.round(60 * frameRate));
  let frequency = FREQUENCIES[0];
  let noiseRms = 0.5;
  let bestGap = Infinity;
  for (const f of FREQUENCIES) {
    const noise = filteredNoise(f, frameRate, frames);
    const gap = Math.abs(Math.log(Math.max(1e-3, halfLife(noise, null)) / Math.max(1e-3, measured)));
    if (gap < bestGap) {
      bestGap = gap;
      frequency = f;
      noiseRms = rms([...noise[0], ...noise[1]]);
    }
  }

  // Amplitude: the running RMS over about one and a half shakes, 1 at its 95th percentile.
  const half = Math.max(1, Math.min(Math.round(frameRate / 4), Math.round((0.75 * frameRate) / frequency)));
  const power = Float64Array.from({ length: n }, (_, k) => (track.valid[k] ? track.x[k] ** 2 + track.y[k] ** 2 : 0));
  const counts = runningMean(Float64Array.from(track.valid), half);
  const envelope = runningMean(power, half).map((p, k) => (counts[k] > 0 ? Math.sqrt(p / counts[k]) : 0));
  const peak = Math.max(1e-6, quantile(kept.map((k) => envelope[k]), 0.95));
  const amplitude = envelope.map((e) => e / peak);
  const rx = rms(kept.map((k) => track.x[k]));
  const ry = rms(kept.map((k) => track.y[k]));
  const size = peak / noiseRms;
  const amplitudeRms = Math.max(1e-6, rms(kept.map((k) => amplitude[k])));
  const tilt = tiltRms / (amplitudeRms * noiseRms);
  const level = kept.reduce((s, k) => s + amplitude[k], 0) / kept.length;
  const shake: ShakeModel = {
    frequency,
    x: (size * rx) / Math.hypot(rx, ry),
    y: (size * ry) / Math.hypot(rx, ry),
    tilt: tilt >= 0.05 ? tilt : 0,
    bias: level,
    weights: new Array(features?.dims ?? 0).fill(0),
    lag: 0,
    level,
  };
  if (!features || kept.length < 50) return { shake, report: { rms: motion, tiltRms, r2: 0 } };

  // The music: ridge regression of the Amplitude on the features, trained on the first four fifths.
  const y = Float64Array.from(kept, (k) => amplitude[k]);
  const split = Math.floor(kept.length * 0.8);
  let best: { score: number; lag: number; coef: Float64Array } = { score: -Infinity, lag: 0, coef: new Float64Array(features.dims + 1) };
  for (const lag of LAGS) {
    const rows = kept.map((k) => {
      const f = new Float64Array(features.dims);
      featuresAt(features, start + k / frameRate - lag, f);
      return f;
    });
    const coef = ridge(rows, y, split, 0.05);
    const pred = rows.map((f) => Math.max(0, f.reduce((s, v, i) => s + v * coef[i + 1], coef[0])));
    const score = r2(pred, y, split, kept.length);
    if (score > best.score) best = { score, lag, coef };
  }
  if (best.score >= MIN_R2) {
    shake.bias = best.coef[0];
    shake.weights = Array.from(best.coef.subarray(1));
    shake.lag = best.lag;
  }
  return { shake, report: { rms: motion, tiltRms, r2: Math.max(0, best.score) } };
}

/** S_Shake's Amplitude over time for a soundtrack's features (or none). */
export class ShakeEnvelope {
  private readonly shake: ShakeModel;
  private readonly features: AudioFeatures | null;
  private readonly row: Float64Array;

  constructor(shake: ShakeModel, features: AudioFeatures | null) {
    this.shake = shake;
    this.features = features && features.dims === shake.weights.length && shake.weights.some((w) => w !== 0) ? features : null;
    this.row = new Float64Array(shake.weights.length);
  }

  amplitudeAt(t: number): number {
    const { shake, features, row } = this;
    if (!features) return shake.level;
    featuresAt(features, t - shake.lag, row);
    let v = shake.bias;
    for (let i = 0; i < row.length; i++) v += shake.weights[i] * row[i];
    return Math.max(0, v);
  }
}

/** S_Shake's settings for `shake` in a picture `scale` times the source's size, at Amplitude `amplitude`. */
export function shakeParams(shake: ShakeModel, scale: number, amplitude: number): ShakeParams {
  const p = stillShake();
  p.frequency = shake.frequency;
  p.amplitude = amplitude;
  p.axes[0][0] = shake.x * scale;
  p.axes[1][0] = shake.y * scale;
  p.axes[3][0] = shake.tilt;
  return p;
}
