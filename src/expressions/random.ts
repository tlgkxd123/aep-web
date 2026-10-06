// Deterministic randomness for expressions: random()/gaussRandom() streams
// seeded per layer, property, seedRandom() offset and time, gradient noise,
// and the fractal noise behind wiggle(). After Effects' own generators are
// internal; these follow the documented semantics (ranges, frequency and
// amplitude meaning, repeatability) but do not reproduce AE's sequences.

/** 32-bit integer hash combining any number of words. */
export function hashWords(...words: number[]): number {
  let h = 0x811c9dc5;
  for (const w of words) {
    let k = Math.imul(w | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Splits a double into two 32-bit words, so nearby times hash apart. */
export function timeWords(t: number): [number, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.round(t * 1e6) / 1e6);
  return [view.getUint32(0), view.getUint32(4)];
}

/** mulberry32: a small, well-distributed 32-bit generator. */
export class RandomStream {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }
  /** A standard normal sample (Box-Muller). */
  gaussian(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

// --- gradient noise ----------------------------------------------------------------

const PERM = (() => {
  const p = Array.from({ length: 256 }, (_, i) => i);
  const rng = new RandomStream(0x5eed1234);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return [...p, ...p];
})();

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** 3D gradient noise in about [-1, 1]; zero on the integer lattice. */
export function noise3(x: number, y: number, z: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const X = fx & 255;
  const Y = fy & 255;
  const Z = fz & 255;
  x -= fx;
  y -= fy;
  z -= fz;
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);
  const A = PERM[X] + Y;
  const AA = PERM[A] + Z;
  const AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y;
  const BA = PERM[B] + Z;
  const BB = PERM[B + 1] + Z;
  return lerp(
    lerp(lerp(grad(PERM[AA], x, y, z), grad(PERM[BA], x - 1, y, z), u), lerp(grad(PERM[AB], x, y - 1, z), grad(PERM[BB], x - 1, y - 1, z), u), v),
    lerp(lerp(grad(PERM[AA + 1], x, y, z - 1), grad(PERM[BA + 1], x - 1, y, z - 1), u), lerp(grad(PERM[AB + 1], x, y - 1, z - 1), grad(PERM[BB + 1], x - 1, y - 1, z - 1), u), v),
    w,
  );
}

/** AE's noise(): a 1-3D point to a value in [-1, 1]. */
export function noise(point: number[]): number {
  return Math.max(-1, Math.min(1, noise3(point[0] ?? 0, point[1] ?? 0, point[2] ?? 0)));
}

/**
 * The offset wiggle() adds to one dimension: octaves of noise, each at double
 * the frequency and `ampMult` times the amplitude of the previous one.
 */
export function wiggleOffset(seed: number, t: number, freq: number, amp: number, octaves: number, ampMult: number): number {
  const count = Math.max(1, Math.floor(octaves));
  const fracOctave = octaves - Math.floor(octaves);
  const lane = (seed % 4096) * 1.618;
  const depth = ((seed >>> 12) % 4096) * 0.7071;
  let sum = 0;
  let a = 1;
  let f = freq;
  for (let k = 0; k < count + (fracOctave > 0 ? 1 : 0); k++) {
    const weight = k === count ? fracOctave : 1;
    sum += weight * a * noise3(t * f, lane + k * 17.31, depth);
    a *= ampMult;
    f *= 2;
  }
  return sum * amp;
}
