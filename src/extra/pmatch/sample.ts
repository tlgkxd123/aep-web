// The particles of a world model at one moment of particle time. Particle i of a
// stream is born at (i + u) / rate, u uniform in [0, 1), and everything about it
// follows from the seed and i alone, so a frame is the same however it is reached.
// Density above or below 100 % adds or thins whole streams, so animating it does
// not reshuffle the particles that stay.
import { JITTER_COUNT, LIFE_SAMPLES, NEAR_Z, P_AMP, P_LIFE, P_OX, P_OY, P_OZ, P_SIZE, P_SPRITE, P_VX, P_VY, P_VZ, PROTO_STRIDE, type ParticleWorldModel } from "./model.ts";

/** Deterministic uniform random numbers in [0, 1). */
export function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

export interface Prepared {
  model: ParticleWorldModel;
  /** Cumulative prototype weights, ending at 1. */
  cumulative: Float64Array;
  /** Longest life a particle can have (clock seconds). */
  maxLife: number;
}

/** Life jitter is cut at this many standard deviations. */
const LIFE_SIGMAS = 3;

export function prepare(model: ParticleWorldModel): Prepared {
  const count = model.weights.length;
  const cumulative = new Float64Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) cumulative[i] = total += Math.max(0, model.weights[i]);
  for (let i = 0; i < count; i++) cumulative[i] = total > 0 ? cumulative[i] / total : (i + 1) / count;
  let longest = 0;
  for (let i = 0; i < count; i++) longest = Math.max(longest, model.prototypes[i * PROTO_STRIDE + P_LIFE]);
  return { model, cumulative, maxLife: longest * Math.exp(LIFE_SIGMAS * Math.abs(model.jitter[4])) };
}

function pick(cumulative: Float64Array, r: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Floats per drawn particle: x, y (output pixels, y down), size (output pixels), light, sprite. */
export const INSTANCE_FLOATS = 5;
/** Smaller particles are drawn at this size with their light lowered to keep their total. */
const MIN_SIZE = 0.5;

export interface View {
  /** Emitter in output pixels. */
  x: number;
  y: number;
  /** Output pixels per screen unit (the reference's frame height). */
  scale: number;
  width: number;
  height: number;
  /** Multipliers of particle size, light and birth rate. */
  size: number;
  light: number;
  density: number;
  seed: number;
}

export interface Instances {
  data: Float32Array;
  count: number;
}

/** One particle as the model defines it, before projection. */
export interface Particle {
  birth: number;
  life: number;
  position: [number, number, number];
  velocity: [number, number, number];
  size: number;
  amplitude: number;
  sprite: number;
  prototype: number;
}

/** Particle i of a stream (null when density thins it out); `keep` is the stream's keep probability. */
export function particle(p: Prepared, streamSeed: number, i: number, keep: number): Particle | null {
  const { model } = p;
  const rand = random(Math.imul(streamSeed | 0, 2654435761) ^ Math.imul(i + 1, 0x9e3779b1));
  const birth = (i + rand()) / model.rate;
  if (rand() >= keep) return null;
  const index = pick(p.cumulative, rand());
  const proto = model.prototypes.subarray(index * PROTO_STRIDE, (index + 1) * PROTO_STRIDE);
  const j = model.jitter;
  const g = new Float64Array(JITTER_COUNT);
  for (let k = 0; k < JITTER_COUNT; k++) g[k] = gaussian(rand);
  const life = proto[P_LIFE] * Math.exp(j[4] * Math.max(-LIFE_SIGMAS, Math.min(LIFE_SIGMAS, g[4])));
  // Velocity: scaled, then turned by a small angle about a random axis across it.
  let vx = proto[P_VX];
  let vy = proto[P_VY];
  let vz = proto[P_VZ];
  const speed = Math.hypot(vx, vy, vz);
  const turn = j[1] * g[1];
  const around = 2 * Math.PI * rand();
  if (speed > 0 && turn !== 0) {
    const ux = vx / speed, uy = vy / speed, uz = vz / speed;
    // A unit vector across u, then the axis at angle `around` from it.
    let ax = -uy, ay = ux, az = 0;
    let n = Math.hypot(ax, ay);
    if (n < 1e-6) [ax, ay, az, n] = [0, -uz, uy, Math.hypot(uz, uy)];
    ax /= n; ay /= n; az /= n;
    const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
    const cx = Math.cos(around) * ax + Math.sin(around) * bx;
    const cy = Math.cos(around) * ay + Math.sin(around) * by;
    const cz = Math.cos(around) * az + Math.sin(around) * bz;
    // u turned by `turn` about c (c is across u): u cos + (c × u) sin.
    const c = Math.cos(turn), s = Math.sin(turn);
    vx = speed * (ux * c + (cy * uz - cz * uy) * s);
    vy = speed * (uy * c + (cz * ux - cx * uz) * s);
    vz = speed * (uz * c + (cx * uy - cy * ux) * s);
  }
  const scale = Math.exp(j[0] * g[0]);
  return {
    birth,
    life,
    position: [proto[P_OX], proto[P_OY], 1 + proto[P_OZ]],
    velocity: [vx * scale, vy * scale, vz * scale],
    size: proto[P_SIZE] * Math.exp(j[2] * g[2]),
    amplitude: proto[P_AMP] * Math.exp(j[3] * g[3]),
    sprite: proto[P_SPRITE],
    prototype: index,
  };
}

export function opacityAt(model: ParticleWorldModel, share: number): number {
  const curve = model.opacityOverLife;
  const x = Math.max(0, Math.min(1, share)) * (LIFE_SAMPLES - 1);
  const k = Math.min(LIFE_SAMPLES - 2, Math.floor(x));
  return Math.max(0, curve[k] + (curve[k + 1] - curve[k]) * (x - k));
}

/** Streams and their keep probabilities for a density multiplier. */
export function streams(seed: number, density: number): [number, number][] {
  const out: [number, number][] = [];
  for (let s = 0; s < Math.ceil(Math.max(0, density) - 1e-9); s++) out.push([Math.imul(seed | 0, 0x2c1b3c6d) ^ Math.imul(s + 1, 0x297a2d39), Math.min(1, density - s)]);
  return out;
}

/** The particles visible at particle time `tau` with zoom `zoom`, projected into `view`. */
export function particlesAt(p: Prepared, tau: number, zoom: number, view: View, into?: Instances): Instances {
  const { model } = p;
  const out = into ?? { data: new Float32Array(4096 * INSTANCE_FLOATS), count: 0 };
  out.count = 0;
  const reach = model.sprites.reach;
  const push = (x: number, y: number, size: number, light: number, sprite: number) => {
    if (out.count * INSTANCE_FLOATS + INSTANCE_FLOATS > out.data.length) {
      const grown = new Float32Array(out.data.length * 2);
      grown.set(out.data);
      out.data = grown;
    }
    out.data.set([x, y, size, light, sprite], out.count * INSTANCE_FLOATS);
    out.count++;
  };
  const scale = view.scale * zoom;
  for (const [streamSeed, keep] of streams(view.seed, view.density)) {
    const first = Math.floor((tau - p.maxLife) * model.rate) - 1;
    const last = Math.floor(tau * model.rate);
    for (let i = first; i <= last; i++) {
      const q = particle(p, streamSeed, i, keep);
      if (!q) continue;
      const age = tau - q.birth;
      if (age < 0 || age > q.life) continue;
      const z = q.position[2] + q.velocity[2] * age;
      if (z < NEAR_Z) continue;
      const x = view.x + (scale * (q.position[0] + q.velocity[0] * age)) / z;
      const y = view.y + (scale * (q.position[1] + q.velocity[1] * age)) / z;
      let size = scale * q.size * view.size * z ** -model.sizeDepth;
      let light = q.amplitude * view.light * z ** -model.lightDepth * opacityAt(model, q.life > 0 ? age / q.life : 0);
      if (size < MIN_SIZE) {
        light *= (size / MIN_SIZE) ** 2;
        size = MIN_SIZE;
      }
      const r = reach * size;
      if (light <= 1 / 1024 || x + r < 0 || y + r < 0 || x - r > view.width || y - r > view.height) continue;
      push(x, y, size, light, q.sprite);
    }
  }
  return out;
}
