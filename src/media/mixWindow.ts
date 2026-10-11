// Windows of a layer's mixed sound, from decoded sources placed on its timeline (see mix.ts). Kept free of the
// footage store so workers can mix too.
import type { AudioData } from "./audio.ts";

/** One decoded source heard in the mix: source seconds = scale · t + offset, for t in [from, to). */
export interface Contribution {
  audio: AudioData;
  scale: number;
  offset: number;
  from: number;
  to: number;
}

export interface LayerAudio {
  /** Rate of the first source, in samples per second of its own time. */
  rate: number;
  /** Source seconds per layer second of the first source; windows hold rate · timeScale samples per layer second. */
  timeScale: number;
  contributions: Contribution[];
}

/**
 * `length` samples of the mono mix starting at sample `first` of the layer's
 * timeline, which has rate · timeScale samples per layer second. `channel`
 * (0 left, 1 right) picks one channel of stereo sources instead of their mean.
 */
export function mixWindow(audio: LayerAudio, first: number, length: number, channel?: number): Float32Array {
  const out = new Float32Array(length);
  const perSecond = audio.rate * audio.timeScale;
  for (const c of audio.contributions) {
    const rate = c.audio.sampleRate;
    const count = c.audio.numberOfChannels;
    const picked = channel !== undefined && count > 1 ? [Math.min(channel, count - 1)] : Array.from({ length: count }, (_, i) => i);
    const channels = picked.map((i) => c.audio.getChannelData(i));
    const gain = 1 / channels.length;
    const end = c.audio.length;
    // Source sample position of window sample i: p0 + i · step.
    const step = (c.scale * rate) / perSecond;
    const p0 = (c.scale * (first / perSecond) + c.offset) * rate;
    const whole = Math.abs(step - 1) < 1e-9 && Math.abs(p0 - Math.round(p0)) < 1e-6;
    const i0 = Math.max(0, Math.ceil(c.from * perSecond - first - 1e-9));
    const i1 = Math.min(length, Math.ceil(c.to * perSecond - first - 1e-9));
    if (whole && channels.length >= 1 && channels.length <= 2) {
      // The common case without the per-channel loop (the same sums: 0 + a = a exactly).
      const a = channels[0];
      const b = channels[1];
      const base = Math.round(p0);
      const lo = Math.max(i0, -base);
      const hi = Math.min(i1, end - base);
      if (b) for (let i = lo; i < hi; i++) out[i] += (a[base + i] + b[base + i]) * gain;
      else for (let i = lo; i < hi; i++) out[i] += a[base + i] * gain;
      continue;
    }
    for (let i = i0; i < i1; i++) {
      let sum = 0;
      if (whole) {
        const p = Math.round(p0) + i;
        if (p < 0 || p >= end) continue;
        for (const data of channels) sum += data[p];
      } else {
        const p = p0 + i * step;
        const k = Math.floor(p);
        if (k < 0 || k + 1 >= end) continue;
        const f = p - k;
        for (const data of channels) sum += data[k] + (data[k + 1] - data[k]) * f;
      }
      out[i] += sum * gain;
    }
  }
  return out;
}
