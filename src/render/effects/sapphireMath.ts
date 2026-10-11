// Parameter math of the Sapphire look-alikes (sapphire.ts, sapphireLight.ts), free of WebGL. Like the
// look-alikes, it follows the plugin's published parameter descriptions: there are no plugin renders to fit
// it to.
import { shakeNoise } from "./sapphireShake.ts";

/** The Filter popups of S_Blur and S_BlurDirectional. */
export const Filter = { BOX: 1, TRIANGLE: 2, GAUSS: 3 } as const;

/** A kernel along one axis for a Sapphire width: its sigma and the reach of the filter with that sigma (pixels). */
export function blurKernel(width: number, filter: number): { sigma: number; reach: number } {
  // The filters share a variance, so switching filter changes the falloff and not the size.
  const sigma = Math.max(0, width) / 2;
  const reach = filter === Filter.BOX ? Math.sqrt(3) * sigma : filter === Filter.TRIANGLE ? Math.sqrt(6) * sigma : 3 * sigma;
  return { sigma, reach };
}

/**
 * S_Glow's falloff as a sum of Gaussians: fractions of Glow Width and their shares of the light (summing to 1), a
 * bright core with a long tail.
 */
export const GLOW_FALLOFF: readonly { width: number; weight: number }[] = [
  { width: 0.15, weight: 0.4 },
  { width: 0.4, weight: 0.35 },
  { width: 1, weight: 0.25 },
];

/** Colour channels (red, green, blue) grouped by a shared width, so each distinct width is blurred once. */
export function channelGroups(widths: readonly number[]): { width: number; channels: [boolean, boolean, boolean] }[] {
  const groups: { width: number; channels: [boolean, boolean, boolean] }[] = [];
  for (let c = 0; c < 3; c++) {
    const w = Math.max(0, widths[c] ?? 0);
    const same = groups.find((g) => Math.abs(g.width - w) <= 1e-3 * Math.max(1, w));
    if (same) same.channels[c] = true;
    else groups.push({ width: w, channels: [c === 0, c === 1, c === 2] });
  }
  return groups;
}

/** S_ZGlow's depth slices: at most this many, whatever its Layers parameter says. */
export const MAX_Z_SLICES = 8;

export function zSliceCount(layers: number): number {
  return Math.min(MAX_Z_SLICES, Math.max(2, Math.round(layers)));
}

/** Share of a pixel at depth `z` (0 near, 1 far) in slice `k` of `count`: tents that sum to 1 at every depth. */
export function zSliceWeight(k: number, count: number, z: number): number {
  return Math.max(0, 1 - Math.abs(Math.min(1, Math.max(0, z)) * (count - 1) - k));
}

export interface FlickerParams {
  amplitude: number;
  lumaAmp: number;
  colorAmp: number;
  frequency: number;
  waveAmp: number;
  waveFreq: number;
  /** Wave phase per channel, in cycles. */
  wavePhase: [number, number, number];
  channelAmp: [number, number, number];
  brightness: number;
  seed: number;
}

/**
 * S_Flicker's gain per colour channel at time `t` (seconds): Brightness times one plus Amplitude (per channel)
 * times seeded random luma and colour flicker at Rand Freq and a regular wave.
 */
export function flickerGains(p: FlickerParams, t: number): [number, number, number] {
  const stream = p.seed * 7919;
  const luma = p.lumaAmp * shakeNoise(t * p.frequency, stream);
  return [0, 1, 2].map((c) => {
    const wave = p.waveAmp * Math.sin(2 * Math.PI * (t * p.waveFreq + p.wavePhase[c]));
    const color = p.colorAmp * shakeNoise(t * p.frequency, stream + 3 + c);
    return Math.max(0, p.brightness * (1 + p.amplitude * p.channelAmp[c] * (luma + wave + color)));
  }) as [number, number, number];
}

/**
 * S_BlurDirectional's line kernel for a Blur Amount (pixels, as S_Blur's widths): its sigma and reach, and where
 * its centre sits along the direction for a Bias (0.5 centred; 0 and 1 trail to one side) and a Shift.
 */
export function directionalKernel(amount: number, filter: number, bias: number, shift: number): { sigma: number; reach: number; center: number } {
  const { sigma, reach } = blurKernel(amount, filter);
  return { sigma, reach, center: (Math.min(1, Math.max(0, bias)) - 0.5) * 2 * reach + shift };
}

/** A unit direction in layer pixels (y down) for an angle in degrees, counter-clockwise from the x axis on screen. */
export function screenDirection(degrees: number): [number, number] {
  const a = (degrees * Math.PI) / 180;
  return [Math.cos(a), -Math.sin(a)];
}
