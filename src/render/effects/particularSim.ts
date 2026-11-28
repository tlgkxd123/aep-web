// Trapcode Particular's look-alike as particles: where each one is, how large and how visible (see particular.ts for
// what the look-alike is and is not). Shared by the WebGL renderer and the native planner (src/native/plan.ts), which
// carries the splats it gives to the native engine; native/core/particular.cpp is its C++ twin.
import type { CompItem, Layer, PropertyGroup } from "../../aep/model.ts";
import { cameraAt, Mat4 } from "../../aep/transform.ts";
import { effectNumber, effectProperty, effectVector } from "../effectParams.ts";
import { OPACITY_OVER_LIFE, overLifeCurve, sampleCurve, SIZE_OVER_LIFE } from "./particularCurves.ts";

/** How a particle colours its texture (SPRITE_MODE in particularSprites.ts). */
const SPRITE_MODE = { TEXTURE: 0, COLORIZE: 1, FILL: 2 } as const;

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

/** Floats per splat instance: cx, cy, outer, inner, opacity. */
export const SPLAT_FLOATS = 5;

/** Appends a disc, opaque out to `inner` and fading linearly to zero at `outer`. */
function splat(out: number[], cx: number, cy: number, inner: number, outer: number, opacity: number) {
  // Dots below a pixel keep their area as fainter one-pixel dots.
  const r = Math.max(outer, 0.75);
  opacity *= Math.min(1, (outer / r) ** 2);
  if (opacity > 0) out.push(cx, cy, r, Math.min(inner, r), opacity);
}

/** A splat widened by `blur` on both sides of its falloff, its opacity lowered so its light stays the same. */
function defocused(out: number[], cx: number, cy: number, inner: number, outer: number, opacity: number, blur: number) {
  if (blur <= 0) return splat(out, cx, cy, inner, outer, opacity);
  // A disc's light, up to a constant: plateau to `i`, linear falloff to `o`.
  const light = (i: number, o: number) => i * i + i * o + o * o;
  const i2 = Math.max(0, inner - blur);
  const o2 = outer + blur;
  splat(out, cx, cy, i2, o2, opacity * Math.min(1, light(inner, outer) / light(i2, o2)));
}

export const rotation = (x: number, y: number, z: number) => Mat4.rotateX(x).mul(Mat4.rotateY(y)).mul(Mat4.rotateZ(z));

/** A random unit vector. */
function uniformDirection(rand: () => number): [number, number, number] {
  const z = rand() * 2 - 1;
  const a = rand() * 2 * Math.PI;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), r * Math.sin(a), z];
}

/**
 * Particles emitted since time 0 (real seconds), ∫ rate dt, for an emission rate
 * that may be animated: emission accumulates, so changing the rate changes only
 * the particles born afterwards. Built in steps of `step` seconds and extended
 * as later times are asked for; one table per rate property, reused across frames.
 */
class Emission {
  private cumulative = new Float64Array(1024);
  private filled = 1;
  private readonly rateAt: (t: number) => number;
  readonly step: number;

  constructor(rateAt: (t: number) => number, step: number) {
    this.rateAt = rateAt;
    this.step = step;
  }

  private extend(index: number): void {
    if (index < this.filled) return;
    if (index >= this.cumulative.length) {
      const grown = new Float64Array(Math.max(index + 1, this.cumulative.length * 2));
      grown.set(this.cumulative);
      this.cumulative = grown;
    }
    let previous = this.rateAt((this.filled - 1) * this.step);
    for (let k = this.filled; k <= index; k++) {
      const rate = this.rateAt(k * this.step);
      this.cumulative[k] = this.cumulative[k - 1] + ((previous + rate) / 2) * this.step;
      previous = rate;
    }
    this.filled = index + 1;
  }

  /** Particles emitted from 0 to `t`. */
  at(t: number): number {
    if (t <= 0) return 0;
    const k = Math.floor(t / this.step);
    this.extend(k + 1);
    const c = this.cumulative;
    return c[k] + (c[k + 1] - c[k]) * (t / this.step - k);
  }

  /** The time by which `count` particles have been emitted (Infinity when never). */
  timeOf(count: number, limit: number): number {
    if (count <= 0) return 0;
    let lo = 0;
    let hi = Math.max(1, Math.ceil(limit / this.step) + 1);
    this.extend(hi);
    if (this.cumulative[hi] < count) return Infinity;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] < count) lo = mid;
      else hi = mid;
    }
    const a = this.cumulative[lo];
    const b = this.cumulative[hi];
    return (lo + (b > a ? (count - a) / (b - a) : 0)) * this.step;
  }
}

const emissions = new WeakMap<object, Emission>();
/** For an animated Physics Time Factor: simulation time ∫ factor dt and emission ∫ rate · factor dt. */
const clocks = new WeakMap<object, { sim: Emission; births: Emission }>();

const EMITTER_POINT = 1;
const EMITTER_BOX = 2;
const EMITTER_SPHERE = 3;
const DIRECTION_UNIFORM = 1;
const DIRECTION_DIRECTIONAL = 2;
const DIRECTION_BIDIRECTIONAL = 3;
const DIRECTION_DISC = 4;
const DIRECTION_OUTWARDS = 5;
const SIZE_LINKED = 1;
const DOF_OFF = 1;
/** Particle Type "Sphere": the dot without the glow halo the other types are drawn with here. */
const TYPE_SPHERE = 1;
const TYPE_GLOW_SPHERE = 2;
const TYPE_STAR = 3;
const TYPE_SPRITE = 6;
const TYPE_SPRITE_COLORIZE = 7;
const TYPE_SPRITE_FILL = 8;
const TYPE_POLYGON = 9;
const TYPE_POLYGON_COLORIZE = 10;
const TYPE_POLYGON_FILL = 11;
const TYPE_CIRCLE = 13;
const SPRITE_TYPES = new Set([TYPE_SPRITE, TYPE_SPRITE_COLORIZE, TYPE_SPRITE_FILL, TYPE_POLYGON, TYPE_POLYGON_COLORIZE, TYPE_POLYGON_FILL]);
/** Circle of confusion (comp pixels) of a particle twice the focal distance away: fitted, not Particular's own. */
const DOF_APERTURE = 15;

/** The settings the drawing of a Particular frame follows, with its particles far to near. */
export interface ParticularFrame {
  particles: Particle[];
  textured: boolean;
  polygon: boolean;
  spriteMode: number;
  textureIndex: number;
  timeSampling: number;
  textureSeed: number;
  clips: number;
  aspect: number;
  particleBlend: number;
  glowBlend: number;
  glows: boolean;
  glowSize: number;
  glowOpacity: number;
  glowFeather: number;
  feather: number;
  color: number[];
  fps: number;
  cx: number;
  cy: number;
  shiftX: number;
  shiftY: number;
  camera: { position: readonly number[]; rotation: Mat4; zoom: number };
}

/**
 * Particular's particles at comp time `time` on a layer image `width` x `height`, `comp` being the layer's comp: a
 * seeded system from the stored emitter, physics and particle settings (system 1 only).
 */
export function particularFrame(effect: PropertyGroup, layer: Layer, comp: CompItem | undefined, time: number, width: number, height: number): ParticularFrame {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  const compW = comp?.width ?? width;
  const compH = comp?.height ?? height;

  const rate = Math.max(0, num(146, 100));
  const emitterType = num(5, EMITTER_POINT);
  const direction = num(113, DIRECTION_UNIFORM);
  const spread = Math.max(0, Math.min(100, num(10, 20))) / 100;
  const emitterRotation = rotation(num(112, 0), num(111, 0), num(76, 0));
  const linked = num(577, SIZE_LINKED) === SIZE_LINKED;
  const sizeX = num(14, 50);
  const boxSize = linked ? [sizeX, sizeX, sizeX] : [sizeX, num(15, 50), num(16, 50)];
  const velocity = num(11, 100);
  const velocityRandom = num(12, 20) / 100;
  const life = Math.max(0, num(2, 3));
  const lifeRandom = Math.min(1, num(65, 0) / 100);
  const particleSize = Math.max(0, num(27, 4));
  const sizeRandom = Math.min(1, num(74, 0) / 100);
  const opacity = num(33, 100) / 100;
  const opacityRandom = Math.min(1, num(75, 0) / 100);
  const feather = num(29, 50) / 100;
  const particleType = num(26, TYPE_SPHERE);
  const textured = SPRITE_TYPES.has(particleType);
  const polygon = particleType >= TYPE_POLYGON && particleType <= TYPE_POLYGON_FILL;
  const spriteMode =
    particleType === TYPE_SPRITE_COLORIZE || particleType === TYPE_POLYGON_COLORIZE
      ? SPRITE_MODE.COLORIZE
      : particleType === TYPE_SPRITE_FILL || particleType === TYPE_POLYGON_FILL
        ? SPRITE_MODE.FILL
        : SPRITE_MODE.TEXTURE;
  const textureIndex = Math.round(num(66, 0));
  const timeSampling = num(67, TIME_CURRENT);
  const textureSeed = num(305, 1);
  const clips = num(108, 2);
  const aspect = Math.max(1e-3, num(524, 1));
  const baseRotation = [num(275, 0), num(276, 0), num(136, 0)];
  const randomRotation = Math.max(0, num(137, 0)) / 100;
  const rotationSpeed = [num(277, 0), num(278, 0), num(138, 0)];
  const randomSpeed = Math.max(0, num(279, 0)) / 100;
  const particleBlend = num(69, BLEND_NORMAL);
  const glowBlend = num(218, BLEND_NORMAL);
  const glows = !textured && particleType !== TYPE_SPHERE;
  const glowSize = num(215, 300) / 100;
  const glowOpacity = glows ? num(216, 25) / 100 : 0;
  const glowFeather = Math.max(0, Math.min(100, num(217, 100))) / 100;
  const color = effectVector(effect, 70, layer, time, [1, 1, 1, 1]);
  const timeFactor = num(25, 1);
  const gravity = num(17, 0);
  const wind = [num(22, 0), num(23, 0), num(24, 0)];
  const seed = num(230, 100000);
  const preRun = Math.max(0, num(227, 0)) / 100;
  // Glow Sphere, Star and Circle are the "No DOF" particle types, regardless of the rendering setting.
  const noDof = particleType === TYPE_GLOW_SPHERE || particleType === TYPE_STAR || particleType === TYPE_CIRCLE;
  const aperture = noDof || num(319, DOF_OFF) === DOF_OFF ? 0 : DOF_APERTURE;
  const farVanish = num(100, 20000);
  const farFade = num(102, 19000);
  const nearFade = num(103, 10);
  const nearVanish = num(105, 1);
  /** Visibility at camera depth `z`: fading in from Near Vanish to Near Start Fade, out from Far Start Fade to Far Vanish. */
  const visibility = (z: number) => {
    const near = nearFade > nearVanish ? (z - nearVanish) / (nearFade - nearVanish) : z >= nearVanish ? 1 : 0;
    const far = farVanish > farFade ? (farVanish - z) / (farVanish - farFade) : z <= farVanish ? 1 : 0;
    return Math.max(0, Math.min(1, near, far));
  };
  const sizeOverLife = overLifeCurve(effect.chunk, SIZE_OVER_LIFE);
  const opacityOverLife = overLifeCurve(effect.chunk, OPACITY_OVER_LIFE);

  // Particle space -> comp space: World Transform rotates about the comp centre, then offsets.
  const cx = compW / 2;
  const cy = compH / 2;
  const world = Mat4.translation(cx + num(293, 0), cy + num(294, 0), num(295, 0))
    .mul(rotation(num(290, 0), num(291, 0), num(292, 0)))
    .mul(Mat4.translation(-cx, -cy, 0));
  const camera = comp ? cameraAt(comp, time) : { position: [cx, cy, -compW / 0.72], rotation: new Mat4(), zoom: compW / 0.72 };
  const toCamera = camera.rotation.inverse();
  // Particular draws in comp space; a layer that is not comp-sized is centred on it.
  const shiftX = (width - compW) / 2;
  const shiftY = (height - compH) / 2;

  const fps = comp?.frameRate || 24;
  const emitterAt = new Map<number, number[]>();
  const emitterPosition = (t: number) => {
    const frame = Math.round(t * fps);
    let p = emitterAt.get(frame);
    if (!p) emitterAt.set(frame, (p = effectVector(effect, 581, layer, frame / fps, [cx, cy, 0])));
    return p;
  };

  // Physics Time Factor runs the whole simulation (emission, ageing, motion) slower or
  // faster: Particles/sec counts per simulation second, and ages are simulation seconds.
  // Pre Run runs `preRun · life` seconds before time 0 at the rate and time factor of
  // time 0, so below a factor of 1 it fills only that share of a life (as After Effects
  // renders it). An animated factor accumulates like an animated rate, so a change
  // speeds up or slows down the particles already flying rather than moving them.
  const rateProp = effectProperty(effect, 146);
  const animatedRate = !!rateProp && (rateProp.keyframes.length > 0 || rateProp.expressionEnabled);
  const factorProp = effectProperty(effect, 25);
  const animatedFactor = !!factorProp && (factorProp.keyframes.length > 0 || factorProp.expressionEnabled);
  const startRate = animatedRate ? Math.max(0, effectNumber(effect, 146, layer, 0, 0)) : rate;
  /** Simulation time now; a particle's age is that minus its birth's. */
  let nowSim: number;
  /** Real and simulation birth times of particle i (real time is never before 0). */
  let birthOf: (i: number) => [real: number, sim: number];
  let first: number;
  let last: number;
  if (animatedFactor && factorProp) {
    let tables = clocks.get(factorProp);
    if (!tables || tables.sim.step !== 1 / fps) {
      const factorAt = (t: number) => Math.max(0, effectNumber(effect, 25, layer, t, 1));
      const rateAt = (t: number) => Math.max(0, effectNumber(effect, 146, layer, t, 0));
      tables = { sim: new Emission(factorAt, 1 / fps), births: new Emission((t) => rateAt(t) * factorAt(t), 1 / fps) };
      clocks.set(factorProp, tables);
    }
    const { sim, births } = tables;
    const preRunCount = preRun * life * Math.max(0, effectNumber(effect, 25, layer, 0, 1)) * startRate;
    nowSim = sim.at(time);
    birthOf = (i) => {
      if (i < preRunCount) return [0, (i - preRunCount) / startRate];
      const real = births.timeOf(i - preRunCount, time);
      return [real, Number.isFinite(real) ? sim.at(real) : real];
    };
    const oldest = nowSim - life;
    const before = oldest < 0 ? preRunCount + oldest * startRate : preRunCount + births.at(sim.timeOf(oldest, time));
    first = Math.max(0, Math.floor(before) - 1);
    last = Math.floor(preRunCount + births.at(time) + 1e-6);
  } else {
    const simFactor = Math.max(timeFactor, 1e-3);
    let emission: Emission | undefined;
    if (animatedRate && rateProp) {
      emission = emissions.get(rateProp);
      if (!emission || emission.step !== 1 / fps) {
        emission = new Emission((t) => Math.max(0, effectNumber(effect, 146, layer, t, 0)), 1 / fps);
        emissions.set(rateProp, emission);
      }
    }
    const preRunSeconds = preRun * life;
    /** Particles emitted by real time t (the pre run's from -preRunSeconds), in simulation units. */
    const emitted = (t: number) =>
      simFactor * (Math.max(0, Math.min(t, 0) + preRunSeconds) * startRate + (emission ? emission.at(t) : rate * Math.max(0, t)));
    const preRunCount = simFactor * preRunSeconds * startRate;
    nowSim = time * simFactor;
    birthOf = (i) => {
      const remaining = i / simFactor - preRunSeconds * startRate;
      const real =
        i < preRunCount ? i / (simFactor * startRate) - preRunSeconds : emission ? emission.timeOf(remaining, time) : remaining / Math.max(rate, 1e-9);
      return [Math.max(0, real), real * simFactor];
    };
    first = Math.max(0, Math.floor(emitted(time - life / simFactor)) - 1);
    last = Math.floor(emitted(time) + 1e-6);
  }
  const particles: Particle[] = [];
  for (let i = first; i <= last && (rate > 0 || animatedRate); i++) {
    const [birthReal, birthSim] = birthOf(i);
    if (!Number.isFinite(birthSim)) break;
    const age = nowSim - birthSim;
    const rand = random(Math.imul(seed | 0, 2654435761) ^ Math.imul(i + 1, 0x9e3779b1));
    const lifeSpan = life * (1 - lifeRandom * 0.5 * rand());
    if (age < 0 || age > lifeSpan) continue;
    const offset =
      emitterType === EMITTER_BOX
        ? [(rand() - 0.5) * boxSize[0], (rand() - 0.5) * boxSize[1], (rand() - 0.5) * boxSize[2]]
        : emitterType === EMITTER_SPHERE
          ? uniformDirection(rand).map((c, k) => (c * Math.cbrt(rand()) * boxSize[k]) / 2)
          : [0, 0, 0];
    let dir: number[];
    if (direction === DIRECTION_DIRECTIONAL || direction === DIRECTION_BIDIRECTIONAL) {
      const cone = uniformDirection(rand).map((c, k) => (k === 2 ? 0 : c * spread));
      const sign = direction === DIRECTION_BIDIRECTIONAL && rand() < 0.5 ? -1 : 1;
      dir = emitterRotation.transformVector([cone[0], cone[1], sign]);
    } else if (direction === DIRECTION_DISC) {
      const a = rand() * 2 * Math.PI;
      dir = emitterRotation.transformVector([Math.cos(a), Math.sin(a), (rand() * 2 - 1) * spread]);
    } else if (direction === DIRECTION_OUTWARDS) {
      dir = offset.some((c) => c !== 0) ? offset : uniformDirection(rand);
    } else {
      dir = uniformDirection(rand);
    }
    const speed = Math.max(0, velocity * (1 + velocityRandom * (rand() * 2 - 1)));
    const lifeShare = lifeSpan > 0 ? age / lifeSpan : 0;
    const pSize = particleSize * (1 + sizeRandom * (rand() - 0.5)) * sampleCurve(sizeOverLife, lifeShare);
    const pOpacity = opacity * (1 - opacityRandom * rand()) * sampleCurve(opacityOverLife, lifeShare);
    const norm = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const t = age;
    const origin = emitterPosition(birthReal);
    const box = emitterRotation.transformVector(offset);
    const local = [0, 1, 2].map((c) => origin[c] + box[c] + (dir[c] / norm) * speed * t + wind[c] * t + (c === 1 ? 0.5 * gravity * t * t : 0));
    const p = world.transformPoint(local);
    const view = toCamera.transformVector([p[0] - camera.position[0], p[1] - camera.position[1], p[2] - camera.position[2]]);
    if (view[2] <= 1) continue;
    const seen = pOpacity * visibility(view[2]);
    const scale = camera.zoom / view[2];
    const sx = cx + view[0] * scale + shiftX;
    const sy = cy + view[1] * scale + shiftY;
    // Out of the focal plane a particle spreads over its circle of confusion, keeping its light.
    const blur = (aperture * Math.abs(view[2] - camera.zoom)) / view[2] / 2;
    // Size is the radius (of a sphere, and half a sprite's width).
    const r = pSize * scale;
    const reach = (textured ? r * Math.SQRT2 * Math.max(aspect, 1 / aspect, 1) * 2 : r * (glows ? Math.max(glowSize, 1) : 1) + 1) + blur;
    if (seen <= 0 || sx + reach < 0 || sy + reach < 0 || sx - reach > width || sy - reach > height) continue;
    const spin = rotationSpeed.map((s) => s * 360 * age * (1 + randomSpeed * (rand() * 2 - 1)));
    const randomTurn = [rand(), rand(), rand()].map((u) => (u * 2 - 1) * 180 * randomRotation);
    particles.push({
      z: view[2],
      sx,
      sy,
      r,
      blur,
      seen,
      age,
      lifeSpan,
      birth: birthReal,
      rand,
      angles: [0, 1, 2].map((k) => baseRotation[k] + randomTurn[k] + spin[k]),
      view,
      scale,
    });
  }
  // Normal particles are laid over each other far to near.
  particles.sort((a, b) => b.z - a.z);
  return {
    particles,
    textured,
    polygon,
    spriteMode,
    textureIndex,
    timeSampling,
    textureSeed,
    clips,
    aspect,
    particleBlend,
    glowBlend,
    glows,
    glowSize,
    glowOpacity,
    glowFeather,
    feather,
    color,
    fps,
    cx,
    cy,
    shiftX,
    shiftY,
    camera,
  };
}

/** The splats a frame of dot particles draws, glow halos and particles, SPLAT_FLOATS each, far to near. */
export function particularSplats(frame: ParticularFrame): { glow: number[]; core: number[] } {
  const glow: number[] = [];
  const core: number[] = [];
  for (const p of frame.particles) {
    // A disc of radius R and feather f is full out to (R + 0.5)(1 - f) - 3 px and gone at R + 0.5 (fitted to
    // After Effects renders over sizes 4-40 and feathers 0-100: scripts/research/particular/particular-fit.ts); the glow is such a
    // disc Glow Size times larger, with Glow Feather, under the particle.
    const disc = (radius: number, f: number): [number, number] => [Math.max(0, (radius + 0.5) * (1 - f) - 3), radius + 0.5];
    if (frame.glows) defocused(glow, p.sx, p.sy, ...disc(p.r * frame.glowSize, frame.glowFeather), p.seen * frame.glowOpacity, p.blur);
    defocused(core, p.sx, p.sy, ...disc(p.r, frame.feather), p.seen, p.blur);
  }
  return { glow, core };
}

/** A particle as it is drawn: where, how large and how visible, and what its texture and rotation follow. */
export interface Particle {
  /** Camera depth. */
  z: number;
  sx: number;
  sy: number;
  /** Half the size, in layer pixels. */
  r: number;
  blur: number;
  seen: number;
  age: number;
  lifeSpan: number;
  /** Real birth time (comp seconds). */
  birth: number;
  /** The particle's own random numbers, continuing after the ones its motion used. */
  rand: () => number;
  /** Rotation about X, Y and Z, degrees. */
  angles: number[];
  /** Position relative to the camera. */
  view: number[];
  /** Layer pixels per particle-space unit at the particle's depth. */
  scale: number;
}

export const BLEND_NORMAL = 1;
export const BLEND_ADD = 2;
export const BLEND_SCREEN = 3;
export const BLEND_LIGHTEN = 4;

const TIME_CURRENT = 1;
const TIME_BIRTH_ONCE = 2;
const TIME_BIRTH_LOOP = 3;
const TIME_BIRTH_STRETCH = 4;
const TIME_RANDOM_STILL = 5;
const TIME_RANDOM_ONCE = 6;
const TIME_RANDOM_LOOP = 7;
const TIME_SPLIT_ONCE = 8;
const TIME_SPLIT_LOOP = 9;
const TIME_SPLIT_STRETCH = 10;

/**
 * The time of the texture layer (its own seconds) a particle shows, by Texture > Time Sampling; NaN once a clip
 * played once has ended (the particle then draws nothing). A texture's clock starts a frame after the birth.
 */
export function textureTime(mode: number, p: Particle, time: number, layer: Layer | undefined, clips: number, seed: number, frame: number): number {
  const duration = layer ? Math.max(1e-6, Math.abs(layer.outPoint - layer.inPoint)) : 1;
  const start = layer ? Math.min(layer.inPoint, layer.outPoint) - layer.startTime : 0;
  const age = Math.max(0, p.age - frame);
  const share = p.lifeSpan > 0 ? age / p.lifeSpan : 0;
  const pick = random(Math.imul(seed | 0, 0x85ebca6b) ^ Math.imul(Math.round(p.birth * 1e4) + 1, 0xc2b2ae35));
  const within = (t: number, span: number, loop: boolean) => (loop ? ((t % span) + span) % span : t < span ? Math.max(0, t) : Number.NaN);
  switch (mode) {
    case TIME_CURRENT:
      return layer ? time - layer.startTime : time;
    case TIME_BIRTH_ONCE:
      return start + within(age, duration, false);
    case TIME_BIRTH_LOOP:
      return start + within(age, duration, true);
    case TIME_BIRTH_STRETCH:
      return start + Math.min(share, 1 - 1e-6) * duration;
    case TIME_RANDOM_STILL:
      return start + pick() * duration;
    case TIME_RANDOM_ONCE:
      return start + within(pick() * duration + age, duration, false);
    case TIME_RANDOM_LOOP:
      return start + within(pick() * duration + age, duration, true);
    case TIME_SPLIT_ONCE:
    case TIME_SPLIT_LOOP:
    case TIME_SPLIT_STRETCH: {
      const n = Math.max(1, Math.round(clips));
      const span = duration / n;
      const clip = Math.min(n - 1, Math.floor(pick() * n));
      const t = mode === TIME_SPLIT_STRETCH ? Math.min(share, 1 - 1e-6) * span : age;
      return start + clip * span + within(t, span, mode === TIME_SPLIT_LOOP);
    }
    default:
      // Current Frame - Freeze: the frame shown when the particle was born.
      return layer ? p.birth - layer.startTime : p.birth;
  }
}
