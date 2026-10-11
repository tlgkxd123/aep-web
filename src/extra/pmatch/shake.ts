// How a reference video's picture shakes, and Sapphire S_Shake settings that shake like it.
//
// Measuring: per frame, the GPU averages 8×8 blocks of the frame's grey levels (only that small copy
// comes back, without stalling the GPU), and workers register each copy onto the next (shakeRegister.ts).
// A frame the previous one does not match (a cut, a flash) moves nothing.
//
// Describing it: the motions add up to the picture's path; less its one-second running mean (camera
// moves, drift), that is the shake. How fast it changes gives S_Shake's Frequency: the look-alike's noise
// (sapphireShake.ts), sampled and filtered the same way, is matched by how soon its autocorrelation
// falls to one half. Its strength over time is the Amplitude (the shake's running RMS, scaled so that
// its 95th percentile is 1), and its X, Y and Tilt give the random amplitudes. How the Amplitude follows
// the music is learned by the world model's audio network (ml/pmatch), from the envelope measured here.
import { shakeNoise, stillShake, type ShakeParams } from "../../render/effects/sapphireShake.ts";
import { ReadbackQueue, type Gpu, type Surface } from "./gpu.ts";
import { BLOCK, thumbnailMotion, type FrameMotion, type ShakeJob, type ShakeReply } from "./shakeRegister.ts";

export type { FrameMotion } from "./shakeRegister.ts";

/** Workers registering thumbnails at most. */
const MAX_WORKERS = 4;
/** Mean Cauchy weight below which a frame does not match the previous one. */
const MIN_AGREEMENT = 0.35;
/** Seconds the running mean that separates the shake from slow motion spans. */
const SLOW_WINDOW = 1;
/** Shake below this RMS (source pixels) is no shake. */
const MIN_SHAKE = 0.75;
/** Frequencies tried, shakes per second. */
const FREQUENCIES = Array.from({ length: 49 }, (_, i) => 0.25 * 2 ** (i / 8));

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

interface ShakeWaiting {
  resolve: (motion: FrameMotion) => void;
  reject: (error: Error) => void;
}

const shakeWaiting = new Map<number, ShakeWaiting>();
let nextShakeJob = 1;
let shakePool: Promise<Worker[]> | undefined;

function shakeWorkers(): Promise<Worker[]> {
  shakePool ??=
    typeof Worker === "undefined"
      ? Promise.resolve([])
      : import("./shakeWorker.ts?worker&inline").then(
          ({ default: ShakeWorker }) => {
            const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4;
            return Array.from({ length: Math.max(1, Math.min(MAX_WORKERS, cores - 2)) }, () => {
              const worker = new ShakeWorker();
              worker.onmessage = ({ data }: MessageEvent<ShakeReply>) => {
                shakeWaiting.get(data.id)?.resolve(data.motion);
                shakeWaiting.delete(data.id);
              };
              worker.onerror = (event) => {
                event.preventDefault();
                for (const job of shakeWaiting.values()) job.reject(new Error(event.message || "the shake could not be measured"));
                shakeWaiting.clear();
              };
              return worker;
            });
          },
          () => [],
        );
  return shakePool;
}

/**
 * Measures each frame's motion since the frame before it. Consecutive frames register independently, so the
 * workers take pairs in turn (on this thread when there are none).
 */
export class ShakeMeter {
  private readonly gpu: Gpu;
  private readonly blocks: [number, number];
  private readonly thumb: Surface;
  private readonly reads: ReadbackQueue<number>;
  private readonly motions: Promise<FrameMotion | null>[] = [];
  private previous: Float32Array | null = null;
  private captured = 0;
  private turn = 0;

  constructor(gpu: Gpu, width: number, height: number) {
    this.gpu = gpu;
    this.blocks = [Math.floor(width / BLOCK), Math.floor(height / BLOCK)];
    this.thumb = gpu.surface(Math.ceil(this.blocks[0] / 4), this.blocks[1], gpu.gl.RGBA32F);
    this.reads = new ReadbackQueue<number>(gpu.gl);
    void shakeWorkers();
  }

  /** Queues the measurement of `frame` (rows top first) against the frame captured before it. */
  capture(frame: WebGLTexture): void {
    const { gpu, thumb } = this;
    gpu.pass(gpu.program(THUMB_FS), thumb, [frame], (u) => {
      gpu.gl.uniform1i(u("u_src"), 0);
      gpu.gl.uniform1i(u("u_blocks"), this.blocks[0]);
    });
    this.take(this.reads.read(this.captured++, thumb.framebuffer, [0], thumb.width, thumb.height));
    this.take(this.reads.collect());
  }

  /** Every captured frame's motion since the frame captured before it, in order (null for the first). */
  async finish(): Promise<(FrameMotion | null)[]> {
    this.take(this.reads.drain());
    return Promise.all(this.motions);
  }

  private take(reads: { data: Float32Array[] }[]): void {
    const [bw, bh] = this.blocks;
    const columns = this.thumb.width;
    for (const { data } of reads) {
      const pixels = data[0];
      const grey = new Float32Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) grey[y * bw + x] = pixels[(y * columns + (x >> 2)) * 4 + (x & 3)];
      const previous = this.previous;
      this.previous = grey;
      this.motions.push(previous ? this.register(previous, grey) : Promise.resolve(null));
    }
  }

  private async register(from: Float32Array, to: Float32Array): Promise<FrameMotion> {
    const [width, height] = this.blocks;
    const workers = await shakeWorkers();
    if (!workers.length) return thumbnailMotion(from, to, width, height);
    const worker = workers[this.turn++ % workers.length];
    return new Promise((resolve, reject) => {
      const id = nextShakeJob++;
      shakeWaiting.set(id, { resolve, reject });
      worker.postMessage({ id, width, height, from, to } satisfies ShakeJob);
    });
  }

  dispose(): void {
    this.reads.dispose();
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

/** How S_Shake shakes the picture, learned from a reference. Its Amplitude over time is the dynamics network's D_SHAKE output (dynamics.ts Clock.shakeAt). */
export interface ShakeModel {
  /** S_Shake Frequency: new random positions per second. */
  frequency: number;
  /** X and Y Rand Amp at Amplitude 1, source pixels, and Tilt Rand Amp, degrees. */
  x: number;
  y: number;
  tilt: number;
  /** Amplitude without a soundtrack. */
  level: number;
}

export interface ShakeReport {
  /** RMS of the shake, source pixels and degrees. */
  rms: number;
  tiltRms: number;
}

/** A window's shake as measured: S_Shake's settings, and its Amplitude per frame of the window (with whether the frame was measured). */
export interface MeasuredShake {
  shake: ShakeModel | null;
  envelope: Float64Array;
  valid: Uint8Array;
  report: ShakeReport;
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

/** S_Shake settings that shake like `track` and its Amplitude per frame; no settings when the picture does not shake. */
export function measureShake(track: ShakeTrack, frameRate: number): MeasuredShake {
  const n = track.x.length;
  const kept = Array.from({ length: n }, (_, k) => k).filter((k) => track.valid[k]);
  const motion = rms(kept.map((k) => Math.hypot(track.x[k], track.y[k])));
  const tiltRms = rms(kept.map((k) => track.tilt[k]));
  const report = { rms: motion, tiltRms };
  if (kept.length < 2 * frameRate || motion < MIN_SHAKE) return { shake: null, envelope: new Float64Array(n), valid: new Uint8Array(n), report };

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
    level,
  };
  return { shake, envelope: amplitude, valid: Uint8Array.from(track.valid), report };
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
