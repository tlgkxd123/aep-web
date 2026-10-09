// How Sapphire S_Shake's look-alike moves a picture over time: smooth seeded noise plus regular waves per
// axis (X, Y, Z, Tilt), scaled by Amplitude, optionally per colour channel. Shared by the effect
// (sapphire.ts) and by Particle Match, which previews the shakes it learns with the same motion.

export const ShakeStyle = { NORMAL: 1, TWITCHY: 2, JUMPY: 3 } as const;

/** Seeded hash of an integer lattice point and a stream, in [-1, 1]. */
function hash(i: number, stream: number): number {
  const s = Math.sin(i * 127.1 + stream * 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Smooth seeded noise in about [-1, 1]: Catmull-Rom through hashed lattice values, continuous in slope. */
export function shakeNoise(x: number, stream: number): number {
  const i = Math.floor(x);
  const t = x - i;
  const [p0, p1, p2, p3] = [hash(i - 1, stream), hash(i, stream), hash(i + 1, stream), hash(i + 2, stream)];
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
}

export interface ShakeParams {
  style: number;
  amplitude: number;
  frequency: number;
  phase: number;
  stillness: number;
  twitchFrequency: number;
  drift: number;
  centerBias: number;
  zDist: number;
  seed: number;
  /** X, Y, Z, Tilt: random amplitude, random frequency, wave amplitude, wave frequency, phase. */
  axes: [number, number, number, number, number][];
  rgbRandomness: number;
  rgbFrequency: number;
}

/** S_Shake's defaults, with the X, Y, Z and Tilt shakes switched off. */
export function stillShake(): ShakeParams {
  return {
    style: ShakeStyle.NORMAL,
    amplitude: 1,
    frequency: 8,
    phase: 0,
    stillness: 0.7,
    twitchFrequency: 2,
    drift: 0.3,
    centerBias: 0,
    zDist: 1,
    seed: 0,
    axes: [0, 1, 2, 3].map(() => [0, 1, 0, 0.5, 0] as [number, number, number, number, number]),
    rgbRandomness: 0,
    rgbFrequency: 2,
  };
}

/** The random part of one axis at shake time `u` (shake cycles), by Style. */
function randomPart(p: ShakeParams, u: number, stream: number): number {
  if (p.style === ShakeStyle.JUMPY) {
    // Jumps once per cycle to a new place (back to the centre with probability Center Bias), drifting between.
    const k = Math.floor(u);
    const home = (hash(k, stream + 0.5) + 1) / 2 < p.centerBias ? 0 : hash(k, stream);
    return home + p.drift * (u - k) * hash(k, stream + 0.25);
  }
  const value = shakeNoise(u, stream);
  if (p.style !== ShakeStyle.TWITCHY) return value;
  // Still for about Stillness of the time, with bursts at Twitch Frequency.
  const gate = (shakeNoise(u * (p.twitchFrequency / Math.max(p.frequency, 1e-6)), stream + 0.75) + 1) / 2;
  return value * Math.min(1, Math.max(0, ((gate - p.stillness) / Math.max(1e-3, 1 - p.stillness)) * 4));
}

export interface ShakeChannel {
  amplitude: number;
  phase: number;
  stream: number;
}

/**
 * Shift (layer pixels, y down), scale and tilt (radians) of a channel at time `t` (seconds); the picture
 * moves by the shift, is scaled by the scale and turned by the tilt about the layer's centre.
 */
export function shakeAt(p: ShakeParams, t: number, channel: ShakeChannel | null): [number, number, number, number] {
  const phase = channel?.phase ?? 0;
  const u = t * p.frequency + p.phase + phase;
  const out = p.axes.map(([randAmp, randFreq, waveAmp, waveFreq, axisPhase], axis) => {
    const stream = p.seed * 17 + axis * 5;
    let v = randAmp * randomPart(p, u * randFreq + axisPhase, stream) + waveAmp * Math.sin(2 * Math.PI * ((t + phase / Math.max(p.frequency, 1e-6)) * waveFreq + axisPhase));
    if (channel && p.rgbRandomness) v += p.rgbRandomness * randAmp * shakeNoise(t * p.rgbFrequency, stream + channel.stream);
    return v * p.amplitude * (channel?.amplitude ?? 1);
  });
  const [dx, dy, z, tilt] = out;
  return [dx, dy, 1 / Math.max(0.05, p.zDist + z), (-tilt * Math.PI) / 180];
}
