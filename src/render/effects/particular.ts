// Trapcode Particular: a deterministic look-alike, not a reproduction. Particular's
// particle positions come from its own random generator, so this draws a seeded
// particle system from the stored emitter, physics and particle settings (system 1
// only): particles born at the emission rate inside the (rotated) emitter box,
// moving with their velocity, wind and gravity in particle space, placed in the
// comp by the World Transform (rotation about the comp centre, then offset; checked
// against After Effects renders of the user's setup), seen through the comp's
// camera, drawn as soft dots with a glow halo. It replaces the layer's pixels as
// Particular does. Positions cannot match; the particle count, sizes, brightness and
// spread are fitted to After Effects renders (scripts/particular-stats.ts): Size Random
// varies the size by up to ±half its percentage, and with Depth of Field on, particles
// off the focal plane (at the camera's zoom distance) spread over a circle of confusion.
import type { CompItem, Layer, Project } from "../../aep/model.ts";
import { cameraAt, Mat4 } from "../../aep/transform.ts";
import { effectNumber, effectProperty, effectVector } from "../effectParams.ts";
import { compile, type GL } from "../gl.ts";
import { registerEffect } from "../registry.ts";
import { OPACITY_OVER_LIFE, overLifeCurve, sampleCurve, SIZE_OVER_LIFE } from "./particularCurves.ts";
import { drawSprites, SPRITE_MODE, spriteFrames } from "./particularSprites.ts";

/** Deterministic uniform random numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each dot is an instanced quad over its reach; its soft disc (full inside `inner`, falling to zero at `r` as
// 1 - smoothstep, as After Effects draws spheres and glows) is laid over what is below: a + b (1 - a).
const SPLAT_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_splat;
layout(location = 2) in float a_opacity;
uniform vec2 u_size;
uniform float u_pad;
flat out vec4 v_splat;
flat out float v_opacity;
void main() {
  vec2 p = a_splat.xy + (a_corner * 2.0 - 1.0) * (a_splat.z + 1.0);
  v_splat = a_splat;
  v_opacity = a_opacity;
  gl_Position = vec4(vec2(p.x + u_pad, u_size.y - u_pad - p.y) / u_size * 2.0 - 1.0, 0.0, 1.0);
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
uniform vec2 u_size;
uniform float u_pad;
uniform vec3 u_color;
flat in vec4 v_splat;
flat in float v_opacity;
out vec4 outColor;
void main() {
  vec2 pixel = vec2(gl_FragCoord.x - u_pad, u_size.y - u_pad - gl_FragCoord.y);
  float d = distance(pixel, v_splat.xy);
  float r = v_splat.z;
  float inner = v_splat.w;
  float cover = inner >= r ? (d < r ? 1.0 : 0.0) : 1.0 - smoothstep(inner, r, d);
  float a = v_opacity * cover;
  outColor = vec4(u_color * a, a);
}`;

interface SplatGpu {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  instances: WebGLBuffer;
  size: WebGLUniformLocation | null;
  pad: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
}
const splatGpu = new WeakMap<GL, SplatGpu>();

function splatter(gl: GL): SplatGpu {
  let state = splatGpu.get(gl);
  if (state) return state;
  const program = compile(gl, SPLAT_VS, SPLAT_FS);
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const corners = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const instances = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SPLAT_FLOATS * 4, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, SPLAT_FLOATS * 4, 16);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);
  state = {
    program,
    vao,
    instances,
    size: gl.getUniformLocation(program, "u_size"),
    pad: gl.getUniformLocation(program, "u_pad"),
    color: gl.getUniformLocation(program, "u_color"),
  };
  splatGpu.set(gl, state);
  return state;
}

/** Floats per splat instance: cx, cy, outer, inner, opacity. */
const SPLAT_FLOATS = 5;

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

const compOfLayer = new WeakMap<Layer, CompItem>();
function compOf(project: Project, layer: Layer): CompItem | undefined {
  let comp = compOfLayer.get(layer);
  if (comp) return comp;
  for (const item of project.items.values()) {
    if (item.kind === "comp" && item.layers.includes(layer)) comp = item;
  }
  if (comp) compOfLayer.set(layer, comp);
  return comp;
}

const rotation = (x: number, y: number, z: number) => Mat4.rotateX(x).mul(Mat4.rotateY(y)).mul(Mat4.rotateZ(z));

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

registerEffect("tc Particular", (input, effect, layer, time, ctx) => {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  ctx.warn("Particular is drawn with a seeded look-alike; particle positions do not match After Effects");
  const width = input.width;
  const height = input.height;
  const comp = compOf(ctx.project, layer);
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
  const pad = ctx.pad;
  // `acquire` leaves the cleared target bound with its viewport set.
  const out = ctx.pool.acquire(width + 2 * pad, height + 2 * pad);
  ctx.pool.release(input.target);
  const gl = ctx.gl;
  if (textured) {
    const textureLayer = textureIndex > 0 ? comp?.layers.find((l) => l.index === textureIndex && l !== layer) : undefined;
    const fpsTexture = fps;
    const sampleTime = (p: Particle) => textureTime(timeSampling, p, time, textureLayer, clips, textureSeed, 1 / fpsTexture);
    const shown = particles.filter((p) => Number.isFinite(sampleTime(p)));
    const frames = textureLayer && shown.length ? spriteFrames(ctx, textureLayer, shown.map(sampleTime), fpsTexture) : null;
    if (frames) {
      const instances: number[] = [];
      for (const p of shown) {
        // A sprite is twice its Size wide, whatever its texture's shape, and as tall as the texture's proportions
        // make it; Aspect Ratio widens it alone.
        const w = p.r * aspect;
        const h = (p.r * frames.height) / frames.width;
        const corners: [number, number][] = [
          [-w, -h],
          [w, -h],
          [-w, h],
          [w, h],
        ];
        if (polygon) {
          const turn = rotation(p.angles[0], p.angles[1], p.angles[2]);
          for (const [x, y] of corners) {
            const v = turn.transformVector([x / p.scale, y / p.scale, 0]);
            const z = p.view[2] + v[2];
            const k = camera.zoom / Math.max(1, z);
            instances.push(cx + (p.view[0] + v[0]) * k + shiftX, cy + (p.view[1] + v[1]) * k + shiftY, z / p.view[2]);
          }
        } else {
          const a = (p.angles[2] * Math.PI) / 180;
          const c = Math.cos(a);
          const s = Math.sin(a);
          for (const [x, y] of corners) instances.push(p.sx + x * c - y * s, p.sy + x * s + y * c, 1);
        }
        instances.push(frames.slot(sampleTime(p)), p.seen);
      }
      withBlend(gl, out, pad, width, height, particleBlend, () => drawSprites(gl, out, pad, instances, spriteMode, color));
    }
  } else {
    const glowSplats: number[] = [];
    const coreSplats: number[] = [];
    for (const p of particles) {
      // A disc of radius R and feather f is full out to (R + 0.5)(1 - f) - 3 px and gone at R + 0.5 (fitted to
      // After Effects renders over sizes 4-40 and feathers 0-100: scripts/particular-fit.ts); the glow is such a
      // disc Glow Size times larger, with Glow Feather, under the particle.
      const disc = (radius: number, f: number): [number, number] => [Math.max(0, (radius + 0.5) * (1 - f) - 3), radius + 0.5];
      if (glows) defocused(glowSplats, p.sx, p.sy, ...disc(p.r * glowSize, glowFeather), p.seen * glowOpacity, p.blur);
      defocused(coreSplats, p.sx, p.sy, ...disc(p.r, feather), p.seen, p.blur);
    }
    const gpu = splatter(gl);
    const draw = (splats: number[]) => {
      if (!splats.length) return;
      gl.useProgram(gpu.program);
      gl.uniform2f(gpu.size, out.width, out.height);
      gl.uniform1f(gpu.pad, pad);
      gl.uniform3f(gpu.color, color[0] ?? 1, color[1] ?? 1, color[2] ?? 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.instances);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(splats), gl.STREAM_DRAW);
      gl.bindVertexArray(gpu.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, splats.length / SPLAT_FLOATS);
      gl.bindVertexArray(null);
    };
    withBlend(gl, out, pad, width, height, glowBlend, () => draw(glowSplats));
    withBlend(gl, out, pad, width, height, particleBlend, () => draw(coreSplats));
  }
  return { ...input, target: out };
});

/** A particle as it is drawn: where, how large and how visible, and what its texture and rotation follow. */
interface Particle {
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

const BLEND_NORMAL = 1;
const BLEND_ADD = 2;
const BLEND_SCREEN = 3;
const BLEND_LIGHTEN = 4;

/** Runs `draw` into `out`'s content (scissored to it) with Particular's blend mode `mode` between particles. */
function withBlend(gl: GL, out: { framebuffer: WebGLFramebuffer; width: number; height: number }, pad: number, width: number, height: number, mode: number, draw: () => void) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
  gl.viewport(0, 0, out.width, out.height);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(pad, pad, width, height);
  gl.enable(gl.BLEND);
  if (mode === BLEND_ADD) gl.blendFunc(gl.ONE, gl.ONE);
  else if (mode === BLEND_SCREEN) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  else if (mode === BLEND_LIGHTEN) gl.blendEquation(gl.MAX);
  else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  draw();
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.BLEND);
  gl.disable(gl.SCISSOR_TEST);
}

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
function textureTime(mode: number, p: Particle, time: number, layer: Layer | undefined, clips: number, seed: number, frame: number): number {
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
