// How much taller each part of a frequency range must be drawn for the parts of a
// converted Avee spectrum to move alike, as Avee's do: Audio Spectrum draws raw
// magnitudes, and in music the lowest frequencies are far louder than the rest, so
// left alone only the start of a ring moves. Each part's typical level in the song
// is measured with Audio Spectrum's own analysis, against the loudest part's.
import type { AudioData } from "../media/audio.ts";
import { analyse } from "../render/effects/audioSpectrumAnalysis.ts";

/** Windows measured, spread over the song. */
const WINDOWS = 96;
/** The level a part reaches in this share of the windows is its typical level. */
const QUANTILE = 0.8;
const BANDS_PER_PART = 16;
/** Most a part is drawn taller than the loudest, against noise in quiet ranges. */
export const MAX_GAIN = 12;

/** The Max Height multiplier of each of `parts` equal parts of [lo, hi] Hz, for windows of `durationMs`. */
export function spectrumGains(audio: AudioData, lo: number, hi: number, durationMs: number, parts: number): number[] {
  const rate = audio.sampleRate;
  const length = Math.max(64, Math.round((durationMs / 1000) * rate));
  if (!audio.length || audio.length < length || parts < 2) return Array.from({ length: parts }, () => 1);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const settings = { startFrequency: lo, endFrequency: hi, bands: parts * BANDS_PER_PART, durationMs };
  const levels = Array.from({ length: parts }, () => new Float32Array(WINDOWS));
  const window = new Float32Array(length);
  for (let w = 0; w < WINDOWS; w++) {
    const start = Math.floor(((w + 0.5) / WINDOWS) * (audio.length - length));
    window.fill(0);
    for (const data of channels) for (let i = 0; i < length; i++) window[i] += data[start + i] / channels.length;
    const mags = analyse(window, rate, settings);
    for (let k = 0; k < parts; k++) {
      let sum = 0;
      for (let b = 0; b < BANDS_PER_PART; b++) sum += mags[k * BANDS_PER_PART + b];
      levels[k][w] = sum / BANDS_PER_PART;
    }
  }
  const typical = levels.map((l) => l.sort()[Math.floor(QUANTILE * (WINDOWS - 1))]);
  const loudest = Math.max(...typical);
  return typical.map((t) => (loudest > 0 && t > 0 ? Math.min(MAX_GAIN, loudest / t) : MAX_GAIN));
}
