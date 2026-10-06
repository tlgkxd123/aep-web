// Trapcode Sound Keys' Apply: turns the audio of a layer into keyframes for
// Output 1-3. Each range is a box drawn over the plugin's spectrum display; its
// output is how far the spectrum inside the box rises from the box's bottom to
// its top, mapped to the output range and shaped by the falloff.
//
// The display model was calibrated against keyframes Sound Keys baked in After
// Effects (scripts/fit-soundkeys.ts): the spectrum spans 5%..95% of the layer
// width on a log axis from 15 Hz to 22050 Hz, an amplitude A (Hann window of
// ~0.19 s centred on the key, |X|/n, of the channels' mean) sits at
// y = 0.783·H − 7.40·H·A, and a range
// averages the columns between its corners. Outputs with no memory match the
// baked keys within about 5% of their range.
import { effectNumber, effectProperty, effectVector } from "../render/effectParams.ts";
import { fft } from "../render/effects/audioSpectrumAnalysis.ts";
import type { Layer, PropertyGroup } from "../aep/model.ts";

export const SOUND_KEYS = "tc Sound Keys";
/** The plugin-drawn "Commands" row holding the Apply button. */
export const SOUND_KEYS_COMMANDS = `${SOUND_KEYS}-0049`;

const LOW_HZ = 15;
const HIGH_HZ = 22050;
const MARGIN = 0.05;
const ZERO_LINE = 0.783;
const GAIN = 7.4;
const WINDOW_SECONDS = 8192 / 44100;

export const RANGE_TYPE = { AVERAGE: 1, PEAK: 2, TRIGGER: 3 } as const;
export const FALLOFF = { INSTANT: 1, LINEAR: 2, EXPONENTIAL: 3, INTEGRATE: 4 } as const;
const OUTPUT_PRESETS: Record<number, [number, number]> = { 1: [0, 100], 2: [0, 1], 3: [-1, 1], 4: [0, 360], 5: [-180, 180] };
const CUSTOM_PRESET = 6;
/** Parameter indices of range 1; ranges 2 and 3 follow 12 and 24 parameters later. */
const RANGE = { active: 12, type: 13, corner1: 14, corner2: 15, falloff: 16, falloffTime: 17, preset: 18, min: 19, max: 20, output: 21 } as const;
const RANGE_STRIDE = 12;

export interface SoundKeysRange {
  /** Parameter index of the range's Output (21, 33, 45). */
  output: number;
  type: number;
  x0: number;
  x1: number;
  yTop: number;
  yBottom: number;
  falloff: number;
  falloffTime: number;
  min: number;
  max: number;
}

export interface SoundKeysSettings {
  /** Size of the display (the effect's layer). */
  width: number;
  height: number;
  /** 0 left, 1 right, undefined for the mix. */
  channel: number | undefined;
  scale: number;
  /** Gains of the Sub Base, Base, Mid and Treble bands. */
  eq: [number, number, number, number];
  ranges: SoundKeysRange[];
  keysPerSecond: number;
  /** Layer index of the Audio Layer parameter. */
  audioLayer: number;
}

/** The Sound Keys settings at comp time `time`; inactive ranges are left out. */
export function soundKeysSettings(effect: PropertyGroup, layer: Layer, time: number, width: number, height: number): SoundKeysSettings {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  const ranges: SoundKeysRange[] = [];
  for (let r = 0; r < 3; r++) {
    const at = (key: keyof typeof RANGE) => RANGE[key] + r * RANGE_STRIDE;
    if (!effectProperty(effect, at("output")) || !num(at("active"), 1)) continue;
    const a = effectVector(effect, at("corner1"), layer, time, [0, 0]);
    const b = effectVector(effect, at("corner2"), layer, time, [width, height]);
    const preset = num(at("preset"), 1);
    const [min, max] = preset === CUSTOM_PRESET ? [num(at("min"), 0), num(at("max"), 100)] : (OUTPUT_PRESETS[preset] ?? [0, 100]);
    ranges.push({
      output: at("output"),
      type: num(at("type"), RANGE_TYPE.AVERAGE),
      x0: Math.min(a[0], b[0]),
      x1: Math.max(a[0], b[0]),
      yTop: Math.min(a[1], b[1]),
      yBottom: Math.max(a[1], b[1]),
      falloff: num(at("falloff"), FALLOFF.INSTANT),
      falloffTime: Math.max(0, num(at("falloffTime"), 0)),
      min,
      max,
    });
  }
  const channel = num(2, 3);
  return {
    width,
    height,
    channel: channel === 1 ? 0 : channel === 2 ? 1 : undefined,
    scale: num(4, 1),
    eq: [num(6, 1), num(7, 1), num(8, 1), num(9, 1)],
    ranges,
    keysPerSecond: Math.max(1, Math.min(200, num(48, 30))),
    audioLayer: num(1, 0),
  };
}

function eqGain(eq: SoundKeysSettings["eq"], hz: number): number {
  return hz < 60 ? eq[0] : hz < 250 ? eq[1] : hz < 4000 ? eq[2] : eq[3];
}

/** Reads `length` samples starting at sample `first` (of the audio layer's timeline at `rate`). */
export type SampleReader = (first: number, length: number) => Float32Array;

export interface SoundKeysResult {
  times: number[];
  /** One series per range of `settings.ranges`, in output units. */
  outputs: number[][];
}

/** Computes the outputs at `keysPerSecond` from `from` to `to` (seconds of the audio layer's timeline). */
export function computeSoundKeys(settings: SoundKeysSettings, rate: number, read: SampleReader, from: number, to: number): SoundKeysResult {
  const analysis = soundKeysAnalysis(settings, rate, read, from, to);
  while (!analysis.step(Infinity));
  return analysis.result;
}

/** As computeSoundKeys, yielding to the event loop between chunks; `progress` gets the share done. */
export async function computeSoundKeysAsync(
  settings: SoundKeysSettings,
  rate: number,
  read: SampleReader,
  from: number,
  to: number,
  progress?: (done: number) => void,
): Promise<SoundKeysResult> {
  const analysis = soundKeysAnalysis(settings, rate, read, from, to);
  while (!analysis.step(400)) {
    progress?.(analysis.done);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return analysis.result;
}

function soundKeysAnalysis(settings: SoundKeysSettings, rate: number, read: SampleReader, from: number, to: number) {
  const n = 2 ** Math.round(Math.log2(WINDOW_SECONDS * rate));
  const window = Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  const { width, height } = settings;
  const left = MARGIN * width;
  const span = (1 - 2 * MARGIN) * width;
  // Per range: the spectrum bin (fractional) and gain of every display column inside the box.
  const columns = settings.ranges.map((r) => {
    const out: { bin: number; gain: number }[] = [];
    for (let x = Math.ceil(r.x0); x <= Math.floor(r.x1); x++) {
      const hz = LOW_HZ * (HIGH_HZ / LOW_HZ) ** ((x - left) / span);
      const bin = (hz * n) / rate;
      if (bin >= 0 && bin < n / 2 - 1) out.push({ bin, gain: eqGain(settings.eq, hz) * settings.scale });
    }
    return out;
  });
  const step = 1 / settings.keysPerSecond;
  const count = Math.max(0, Math.floor((to - from) / step + 1e-6) + 1);
  const times: number[] = [];
  const outputs = settings.ranges.map(() => [] as number[]);
  const state = settings.ranges.map(() => 0);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float32Array(n / 2);
  let k = 0;
  const analyse = () => {
    const t = from + k * step;
    times.push(t);
    const samples = read(Math.round(t * rate - n / 2), n);
    for (let i = 0; i < n; i++) {
      re[i] = samples[i] * window[i];
      im[i] = 0;
    }
    fft(re, im, -1);
    for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]) / n;
    settings.ranges.forEach((r, ri) => {
      let sum = 0;
      let peak = 0;
      for (const { bin, gain } of columns[ri]) {
        const b = Math.floor(bin);
        const a = (mag[b] + (mag[b + 1] - mag[b]) * (bin - b)) * gain;
        sum += a;
        peak = Math.max(peak, a);
      }
      const amplitude = r.type === RANGE_TYPE.AVERAGE ? (columns[ri].length ? sum / columns[ri].length : 0) : peak;
      const y = ZERO_LINE * height - GAIN * height * amplitude;
      const depth = r.yBottom - r.yTop;
      let level = depth > 0 ? Math.max(0, Math.min(1, (r.yBottom - y) / depth)) : 0;
      if (r.type === RANGE_TYPE.TRIGGER) level = y < r.yBottom ? 1 : 0;
      const previous = state[ri];
      let next = level;
      if (k > 0 && r.falloff === FALLOFF.INTEGRATE) next = previous + level;
      else if (k > 0 && r.falloffTime > 0 && level < previous) {
        if (r.falloff === FALLOFF.LINEAR) next = Math.max(level, previous - step / r.falloffTime);
        else if (r.falloff === FALLOFF.EXPONENTIAL) next = Math.max(level, previous * Math.exp((-3 * step) / r.falloffTime));
      }
      state[ri] = next;
      outputs[ri].push(r.min + next * (r.max - r.min));
    });
  };
  return {
    /** Analyses up to `keys` more keys; true when finished. */
    step(keys: number): boolean {
      for (let i = 0; i < keys && k < count; i++, k++) analyse();
      return k >= count;
    },
    get done(): number {
      return count ? k / count : 1;
    },
    result: { times, outputs } as SoundKeysResult,
  };
}
