// The world model's global state over time: a clock whose speed, and a zoom whose
// amount, a small network reads from the audio features. Particle time is the
// integral of the clock speed, so any frame can be rendered directly (random
// access) and a louder passage moves every particle further.
import type { AudioFeatures } from "./audio.ts";
import type { Dynamics } from "./model.ts";

/** Log clock speed is kept within ±MAX_LOG_SPEED, log zoom within ±MAX_LOG_ZOOM. */
const MAX_LOG_SPEED = 3;
const MAX_LOG_ZOOM = 1;

/** Log clock speed and log zoom for the features at `offset` in `features`. */
export function evaluateDynamics(d: Dynamics, features: ArrayLike<number>, offset: number, out: Float64Array, hidden?: Float64Array): void {
  const { inputs, weights: w } = d;
  const h = d.hidden;
  const b1 = h * inputs;
  const w2 = b1 + h;
  const b2 = w2 + 2 * h;
  const skip = b2 + 2;
  let speed = w[b2];
  let zoom = w[b2 + 1];
  for (let j = 0; j < h; j++) {
    let a = w[b1 + j];
    for (let i = 0; i < inputs; i++) a += w[j * inputs + i] * features[offset + i];
    const t = Math.tanh(a);
    if (hidden) hidden[j] = t;
    speed += w[w2 + j] * t;
    zoom += w[w2 + h + j] * t;
  }
  for (let i = 0; i < inputs; i++) {
    speed += w[skip + i] * features[offset + i];
    zoom += w[skip + inputs + i] * features[offset + i];
  }
  out[0] = speed;
  out[1] = zoom;
}

const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));

export interface ClockOptions {
  /** Scales how far the audio moves speed and zoom away from their silent values (1 = as learned). */
  reactivity: number;
  /** Multiplies the clock speed. */
  speed: number;
}

/** Particle time and zoom at any time, for one audio track (or none). */
export class Clock {
  private readonly rate: number;
  private readonly lag: number;
  private readonly start: number;
  private readonly speeds: Float64Array;
  private readonly cumulative: Float64Array;
  private readonly logZooms: Float64Array;

  constructor(d: Dynamics, features: AudioFeatures | null, preRun: number, options: ClockOptions) {
    this.rate = features?.rate ?? d.rate;
    this.lag = d.lag;
    this.start = preRun;
    const out = new Float64Array(2);
    evaluateDynamics(d, new Float32Array(d.inputs), 0, out);
    const quietSpeed = out[0];
    const quietZoom = out[1];
    const frames = features && features.dims === d.inputs ? features.frames : 1;
    this.speeds = new Float64Array(frames);
    this.logZooms = new Float64Array(frames);
    this.cumulative = new Float64Array(frames + 1);
    for (let k = 0; k < frames; k++) {
      if (frames > 1) evaluateDynamics(d, features!.data, k * d.inputs, out);
      else out.set([quietSpeed, quietZoom]);
      const logSpeed = clamp(quietSpeed + options.reactivity * (out[0] - quietSpeed), MAX_LOG_SPEED);
      this.speeds[k] = options.speed * Math.exp(logSpeed);
      this.logZooms[k] = clamp(quietZoom + options.reactivity * (out[1] - quietZoom), MAX_LOG_ZOOM);
      this.cumulative[k + 1] = this.cumulative[k] + this.speeds[k] / this.rate;
    }
  }

  /** ∫ speed over [0, x / rate] seconds of the feature timeline, extended at the ends by the end speeds. */
  private integral(x: number): number {
    const last = this.speeds.length - 1;
    if (x <= 0) return (x * this.speeds[0]) / this.rate;
    if (x >= last + 1) return this.cumulative[last + 1] + ((x - last - 1) * this.speeds[last]) / this.rate;
    const k = Math.floor(x);
    return this.cumulative[k] + ((x - k) * this.speeds[k]) / this.rate;
  }

  /** Particle time (clock seconds) at time `t` seconds. */
  timeAt(t: number): number {
    return this.start + this.integral((t - this.lag) * this.rate) - this.integral(-this.lag * this.rate);
  }

  /** Clock speed (clock seconds per second) at time `t`. */
  speedAt(t: number): number {
    const k = Math.max(0, Math.min(this.speeds.length - 1, Math.floor((t - this.lag) * this.rate)));
    return this.speeds[k];
  }

  zoomAt(t: number): number {
    const x = Math.max(0, Math.min(this.logZooms.length - 1, (t - this.lag) * this.rate));
    const k = Math.min(this.logZooms.length - 2, Math.floor(x));
    if (k < 0) return Math.exp(this.logZooms[0]);
    return Math.exp(this.logZooms[k] + (this.logZooms[k + 1] - this.logZooms[k]) * (x - k));
  }
}
