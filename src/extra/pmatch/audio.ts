// Audio features the world model's clock and zoom respond to: the energy of eight
// log-spaced bands from 30 Hz to 16 kHz, 100 times a second, each normalized by the
// track's own levels (its median and spread over the whole track, so any song
// drives the model alike), then followed by a fast and a slow envelope.
import { fft } from "../../render/effects/audioSpectrumAnalysis.ts";

export const FEATURE_RATE = 100;
export const BANDS = 8;
export const FEATURES = 2 * BANDS;
const LOW_HZ = 30;
const HIGH_HZ = 16000;
const ATTACK_S = 0.01;
const FAST_RELEASE_S = 0.06;
const SLOW_RELEASE_S = 0.4;
/** Normalized levels are clamped to this many spreads around the median (silence would dominate otherwise). */
const LIMIT = 4;

export interface AudioFeatures {
  /** Frames per second; frame k is at k / rate seconds. */
  rate: number;
  frames: number;
  /** Features per frame: BANDS fast envelopes, then BANDS slow ones. */
  dims: number;
  data: Float32Array;
}

/** Reads `length` mono samples starting at sample `first`; samples outside the track are zero. */
export type SampleReader = (first: number, length: number) => Float32Array;

function fftSize(sampleRate: number): number {
  let n = 256;
  while (n < sampleRate * 0.04) n *= 2;
  return n;
}

/** Natural-log band energies, BANDS per frame, for `duration` seconds of audio. */
export function bandEnergies(read: SampleReader, sampleRate: number, duration: number, rate = FEATURE_RATE): Float32Array {
  const frames = Math.max(1, Math.ceil(duration * rate) + 1);
  const n = fftSize(sampleRate);
  const hann = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const bandOf = new Int8Array(n / 2).fill(-1);
  for (let bin = 1; bin < n / 2; bin++) {
    const hz = (bin * sampleRate) / n;
    if (hz < LOW_HZ || hz >= HIGH_HZ) continue;
    bandOf[bin] = Math.min(BANDS - 1, Math.floor((Math.log(hz / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ)) * BANDS));
  }
  const out = new Float32Array(frames * BANDS);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const power = new Float64Array(BANDS);
  const blockLength = 1 << 16;
  let block: Float32Array = new Float32Array(0);
  let blockStart = 0;
  for (let k = 0; k < frames; k++) {
    const start = Math.round((k * sampleRate) / rate) - n / 2;
    if (start < blockStart || start + n > blockStart + block.length) {
      blockStart = start;
      block = read(start, blockLength + n);
    }
    const offset = start - blockStart;
    for (let i = 0; i < n; i++) {
      re[i] = block[offset + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im, -1);
    power.fill(0);
    for (let bin = 1; bin < n / 2; bin++) {
      const band = bandOf[bin];
      if (band >= 0) power[band] += re[bin] * re[bin] + im[bin] * im[bin];
    }
    for (let b = 0; b < BANDS; b++) out[k * BANDS + b] = Math.log(power[b] + 1e-9);
  }
  return out;
}

function quantile(sorted: Float32Array, q: number): number {
  const x = q * (sorted.length - 1);
  const i = Math.floor(x);
  return sorted[i] + (sorted[Math.min(sorted.length - 1, i + 1)] - sorted[i]) * (x - i);
}

/** Normalizes band energies by the track's own levels and adds the envelopes. */
export function featuresFromEnergies(energies: Float32Array, rate = FEATURE_RATE): AudioFeatures {
  const frames = energies.length / BANDS;
  const data = new Float32Array(frames * FEATURES);
  const attack = Math.exp(-1 / (ATTACK_S * rate));
  const releases = [Math.exp(-1 / (FAST_RELEASE_S * rate)), Math.exp(-1 / (SLOW_RELEASE_S * rate))];
  const column = new Float32Array(frames);
  for (let b = 0; b < BANDS; b++) {
    for (let k = 0; k < frames; k++) column[k] = energies[k * BANDS + b];
    const sorted = Float32Array.from(column).sort();
    const median = quantile(sorted, 0.5);
    // (p90 - p10) / 2.56 is the standard deviation of a normal distribution.
    const spread = Math.max(0.25, (quantile(sorted, 0.9) - quantile(sorted, 0.1)) / 2.56);
    releases.forEach((release, e) => {
      let env = Math.max(-LIMIT, Math.min(LIMIT, (column[0] - median) / spread));
      for (let k = 0; k < frames; k++) {
        const x = Math.max(-LIMIT, Math.min(LIMIT, (column[k] - median) / spread));
        env = x + (env - x) * (x > env ? attack : release);
        data[k * FEATURES + e * BANDS + b] = env;
      }
    });
  }
  return { rate, frames, dims: FEATURES, data };
}

export function audioFeatures(read: SampleReader, sampleRate: number, duration: number): AudioFeatures {
  return featuresFromEnergies(bandEnergies(read, sampleRate, duration));
}

/** A reader over decoded channels (mixed to mono). */
export function channelReader(channels: Float32Array[]): SampleReader {
  return (first, length) => {
    const out = new Float32Array(length);
    const gain = 1 / Math.max(1, channels.length);
    for (const data of channels) {
      const from = Math.max(0, -first);
      const to = Math.min(length, data.length - first);
      for (let i = from; i < to; i++) out[i] += data[first + i] * gain;
    }
    return out;
  };
}
