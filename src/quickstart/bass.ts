// A song's bass as a 0–100 level per frame, what the Quick Start templates key their
// "Bass" slider with (as After Effects' Convert Audio to Keyframes keys an Audio
// Amplitude slider, but of the low end only): the mono mix through a 4th-order
// low-pass, its RMS over each frame, held with a short release so a kick reads as
// one pulse, then scaled so the song's loud bass reaches 100 and its quiet parts 0.
import type { AudioData } from "../media/audio.ts";

/** Where the low-pass starts to cut: kicks and sub bass, not the snare. */
export const BASS_CUTOFF = 150;
/** Seconds a level takes to fall to 1/e after a kick. */
const RELEASE = 0.12;
/** The share of frames at or below the level that reads as 0, and the one that reads as 100. */
const FLOOR_QUANTILE = 0.2;
const PEAK_QUANTILE = 0.98;

/** The mean of the channels. */
function mono(audio: AudioData): Float32Array {
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  if (channels.length === 1) return channels[0].slice();
  const out = new Float32Array(audio.length);
  for (const data of channels) for (let i = 0; i < out.length; i++) out[i] += data[i];
  for (let i = 0; i < out.length; i++) out[i] /= channels.length;
  return out;
}

/** A Butterworth low-pass biquad (RBJ's cookbook), in place. */
function lowPass(samples: Float32Array, sampleRate: number, cutoff: number): void {
  const w = (2 * Math.PI * Math.min(cutoff, sampleRate * 0.45)) / sampleRate;
  const alpha = Math.sin(w) / Math.SQRT2;
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    samples[i] = y;
  }
}

function quantile(values: Float32Array, q: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
}

/** The bass level (0–100) of each of `frames` frames at `frameRate`, frame i covering [i, i + 1) / frameRate seconds. */
export function bassLevels(audio: AudioData, frameRate: number, frames: number): Float32Array {
  const levels = new Float32Array(Math.max(0, frames));
  if (!audio.length || !audio.numberOfChannels || !frames) return levels;
  const signal = mono(audio);
  lowPass(signal, audio.sampleRate, BASS_CUTOFF);
  lowPass(signal, audio.sampleRate, BASS_CUTOFF);
  const decay = Math.exp(-1 / (frameRate * RELEASE));
  let held = 0;
  for (let f = 0; f < frames; f++) {
    const from = Math.min(signal.length, Math.round((f / frameRate) * audio.sampleRate));
    const to = Math.min(signal.length, Math.round(((f + 1) / frameRate) * audio.sampleRate));
    let sum = 0;
    for (let i = from; i < to; i++) sum += signal[i] * signal[i];
    const rms = to > from ? Math.sqrt(sum / (to - from)) : 0;
    held = Math.max(rms, held * decay);
    levels[f] = held;
  }
  const floor = quantile(levels, FLOOR_QUANTILE);
  const peak = quantile(levels, PEAK_QUANTILE);
  const range = peak - floor;
  for (let f = 0; f < frames; f++) {
    const level = range > 1e-6 ? (levels[f] - floor) / range : 0;
    levels[f] = Math.round(Math.max(0, Math.min(1, level)) * 10000) / 100;
  }
  return levels;
}

/** Most seconds between two keyframes. */
const MAX_SPAN = 2;

/**
 * Keyframes for per-frame levels: the frames linear interpolation between kept keyframes cannot pass within
 * `tolerance` of, the first and the last, and one at least every MAX_SPAN seconds.
 */
export function levelKeyframes(levels: ArrayLike<number>, frameRate: number, tolerance = 0.5): { time: number; value: number }[] {
  const n = levels.length;
  if (!n) return [];
  const span = Math.max(2, Math.round(MAX_SPAN * frameRate));
  const kept = [0];
  let anchor = 0;
  for (let end = 2; end < n; end++) {
    const a = levels[anchor];
    const slope = (levels[end] - a) / (end - anchor);
    let fits = end - anchor <= span;
    for (let i = anchor + 1; i < end && fits; i++) fits = Math.abs(a + slope * (i - anchor) - levels[i]) <= tolerance;
    if (!fits) {
      anchor = end - 1;
      kept.push(anchor);
    }
  }
  if (n > 1) kept.push(n - 1);
  return kept.map((f) => ({ time: f / frameRate, value: levels[f] }));
}
