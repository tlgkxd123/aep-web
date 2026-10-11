// The world model's global state over time: the audio network (tcn.ts) reads the
// clock speed, the zoom and S_Shake's Amplitude from the sound. Particle time is the
// integral of the clock speed, so any frame can be rendered directly (random
// access) and a louder passage moves every particle further.
import type { AudioFeatures } from "./audio.ts";
import { D_LOG_SPEED, D_LOG_ZOOM, D_SHAKE, type Dynamics } from "./model.ts";
import { quietDynamics, runDynamics } from "./tcn.ts";

/** Log clock speed is kept within ±MAX_LOG_SPEED, log zoom within ±MAX_LOG_ZOOM. */
const MAX_LOG_SPEED = 3;
const MAX_LOG_ZOOM = 1;

interface Outputs {
  /** Feature frames covered, and the outputs per frame (frame-major). */
  frames: number;
  data: Float32Array;
  quiet: Float32Array;
}

const quietOf = new WeakMap<Dynamics, Float32Array>();
const outputsOf = new WeakMap<Dynamics, WeakMap<AudioFeatures, Outputs>>();

/** The network's outputs over a sound track (one frame of silence without one), computed once per model and track. */
function dynamicsOutputs(d: Dynamics, features: AudioFeatures | null): Outputs {
  let quiet = quietOf.get(d);
  if (!quiet) quietOf.set(d, (quiet = quietDynamics(d)));
  if (!features || features.dims !== d.inputs || features.frames < 2) return { frames: 1, data: quiet, quiet };
  let perModel = outputsOf.get(d);
  if (!perModel) outputsOf.set(d, (perModel = new WeakMap()));
  let outputs = perModel.get(features);
  if (!outputs) perModel.set(features, (outputs = { frames: features.frames, data: runDynamics(d, features.data, features.frames), quiet }));
  return outputs;
}

const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));

export interface ClockOptions {
  /** Scales how far the audio moves speed, zoom and shake away from their silent values (1 = as learned). */
  reactivity: number;
  /** Multiplies the clock speed. */
  speed: number;
}

/** Particle time, zoom and shake at any time, for one audio track (or none). */
export class Clock {
  private readonly rate: number;
  private readonly start: number;
  private readonly speeds: Float64Array;
  private readonly cumulative: Float64Array;
  private readonly logZooms: Float64Array;
  private readonly shakes: Float64Array;

  constructor(d: Dynamics, features: AudioFeatures | null, preRun: number, options: ClockOptions) {
    const outputs = dynamicsOutputs(d, features);
    const { frames, data, quiet } = outputs;
    const O = d.outputs;
    this.rate = frames > 1 ? features!.rate : d.rate;
    this.start = preRun;
    this.speeds = new Float64Array(frames);
    this.logZooms = new Float64Array(frames);
    this.shakes = new Float64Array(frames);
    this.cumulative = new Float64Array(frames + 1);
    const react = (k: number, output: number) => quiet[output] + options.reactivity * (data[k * O + output] - quiet[output]);
    for (let k = 0; k < frames; k++) {
      this.speeds[k] = options.speed * Math.exp(clamp(react(k, D_LOG_SPEED), MAX_LOG_SPEED));
      this.logZooms[k] = clamp(react(k, D_LOG_ZOOM), MAX_LOG_ZOOM);
      this.shakes[k] = Math.max(0, react(k, D_SHAKE));
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
    return this.start + this.integral(t * this.rate);
  }

  /** Clock speed (clock seconds per second) at time `t`. */
  speedAt(t: number): number {
    const k = Math.max(0, Math.min(this.speeds.length - 1, Math.floor(t * this.rate)));
    return this.speeds[k];
  }

  private interpolated(values: Float64Array, t: number): number {
    const x = Math.max(0, Math.min(values.length - 1, t * this.rate));
    const k = Math.min(values.length - 2, Math.floor(x));
    if (k < 0) return values[0];
    return values[k] + (values[k + 1] - values[k]) * (x - k);
  }

  zoomAt(t: number): number {
    return Math.exp(this.interpolated(this.logZooms, t));
  }

  /** S_Shake's Amplitude at time `t` (a model without a shake gives 0). */
  shakeAt(t: number): number {
    return this.interpolated(this.shakes, t);
  }
}
