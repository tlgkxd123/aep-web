// Trapcode Particular layers that reproduce a trained world model (model.ts) with
// Particular's own controls, so the look can be finished in After Effects. The
// model's particles fly in straight lines toward the camera from a plane around the
// emitter; Particular gets the same from a flat Box emitter whose Directional
// emission the World Transform turns toward the camera, through the point the
// reference's particles stream out of (a centred camera sees particles flying along
// its axis stream out of the frame centre, so a stream point off centre is a tilt).
// Particular draws a particle's speed and life independently, while in a reference
// the slow particles live longest, so each speed class gets a layer of its own.
//
// Per layer: Life and Particles/sec keep the class's visible particle count and their
// mean visible life (Life Random 100 % spreads lives over [Life / 2, Life]); Velocity
// and Velocity Random its spread of speeds toward the camera, Direction Spread its
// sideways drift; the box its birth area; Size, Particle Feather and the glow its
// sprite's light profile, fitted to how the look-alike draws a Glow Sphere. Size over
// Life cancels the growth Particular's perspective gives an approaching particle as
// far as the model's sprites do not grow (sizeDepth), Opacity over Life is the
// learned curve with the brightening the model shows (lightDepth), both for the
// class's mean approach, and Physics Time Factor is the model's clock, keyframed from
// the soundtrack.
import type { CompItem, Layer, Property, PropertyGroup } from "../../aep/model.ts";
import type { Editor } from "../../edit/editor.ts";
import { addEffects, newInstance, setInstanceColor, setInstanceData, setInstanceNumber, setInstancePoint, type EffectTemplate } from "../../edit/effects.ts";
import { addLayer } from "../../edit/layers.ts";
import { drawnCurve } from "../../render/effects/particularCurves.ts";
import type { AudioFeatures } from "./audio.ts";
import { Clock } from "./dynamics.ts";
import { effectTemplates } from "./effectTemplates.ts";
import { P_AMP, P_LIFE, P_OX, P_OY, P_SIZE, P_SPRITE, P_VX, P_VY, P_VZ, PROTO_STRIDE, type ParticleWorldModel } from "./model.ts";
import { opacityAt } from "./sample.ts";

export const PARTICULAR = "tc Particular";
export const MIRROR = "ADBE Mirror";

/** Particular's parameters (main system) by the number its definition gives them. */
export const PARTICULAR_PARAM = {
  life: 2,
  emitterType: 5,
  spread: 10,
  velocity: 11,
  velocityRandom: 12,
  velocityFromMotion: 13,
  emitterSizeX: 14,
  emitterSizeY: 15,
  emitterSizeZ: 16,
  timeFactor: 25,
  particleType: 26,
  size: 27,
  feather: 29,
  opacity: 33,
  lifeRandom: 65,
  color: 70,
  sizeRandom: 74,
  opacityRandom: 75,
  nearStartFade: 103,
  nearVanish: 105,
  direction: 113,
  rate: 146,
  glowSize: 215,
  glowOpacity: 216,
  preRun: 227,
  seed: 230,
  worldRotationX: 290,
  worldRotationY: 291,
  worldRotationZ: 292,
  worldOffsetX: 293,
  worldOffsetY: 294,
  worldOffsetZ: 295,
  depthOfField: 319,
  sizeOverLife: 569,
  opacityOverLife: 570,
  emitterSize: 577,
  position: 581,
} as const;
const P = PARTICULAR_PARAM;
const EMITTER_BOX = 2;
const DIRECTIONAL = 2;
const SIZE_XYZ = 2;
const GLOW_SPHERE = 2;
const DOF_OFF = 1;
const MIRROR_CENTER = 1;

/** The comp the layers are made for. */
export interface ParticularTarget {
  width: number;
  height: number;
  frameRate: number;
  duration: number;
  /** Camera zoom in pixels: how far the emitter's plane is from the camera. */
  zoom: number;
}

export interface ParticularLayerSettings {
  name: string;
  /** Static values by parameter number. */
  numbers: Map<number, number>;
  color: [number, number, number];
  /** Curve points, [life share, value], birth to death. */
  sizeOverLife: [number, number][];
  opacityOverLife: [number, number][];
  /** Share of the model's births the layer emits. */
  share: number;
}

export interface ParticularSettings {
  layers: ParticularLayerSettings[];
  /** Physics Time Factor: one value, or keyframes in comp seconds. */
  timeFactor: number | { time: number; value: number }[];
  /** Reflection Center (comp pixels) of a Mirror after each Particular; null when the reference is not mirrored. */
  mirror: [number, number] | null;
}

/** Speed classes, slowest first, by how many particles a class has on screen. */
const CLASS_NAMES = [[""], ["slow", "fast"], ["slow", "medium", "fast"]];
/** Fewest prototypes per class. */
const MIN_CLASS = 24;
/** Life Random 100 % draws lives uniformly over [Life / 2, Life]: their mean, and the mean life of the particles on screen. */
const LIFE_MEAN = 0.75;
const LIFE_SEEN = 7 / 9;
/** Furthest share of the way to the camera the over Life curves follow (a curve cannot undo a particle reaching it). */
const MAX_APPROACH = 0.9;
/** Particles fade out closer to the camera than this share of the emitter's distance, and vanish at the second. */
const NEAR_FADE = 0.25;
const NEAR_VANISH = 0.05;
/** Points of each over Life curve, evenly spaced. */
const CURVE_POINTS = 25;
/** Physics Time Factor keyframes are dropped where a line through their neighbours is this close (relative). */
const SPEED_TOLERANCE = 0.02;

interface Weighted {
  value: number;
  weight: number;
}

function mean(rows: readonly Weighted[]): number {
  let s = 0;
  let w = 0;
  for (const r of rows) {
    s += r.value * r.weight;
    w += r.weight;
  }
  return w > 0 ? s / w : 0;
}

function spread(rows: readonly Weighted[]): number {
  const m = mean(rows);
  return Math.sqrt(Math.max(0, mean(rows.map((r) => ({ value: (r.value - m) ** 2, weight: r.weight })))));
}

function quantile(rows: readonly Weighted[], q: number): number {
  const sorted = [...rows].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, r) => s + r.weight, 0);
  let acc = 0;
  for (const r of sorted) if ((acc += r.weight) >= q * total) return r.value;
  return sorted.at(-1)?.value ?? 0;
}

/** Azimuthal mean of sprite `k`'s template at `bins` radii from its centre to its reach (in particle sizes). */
function spriteProfile(model: ParticleWorldModel, k: number, bins: number): Float64Array {
  const { size, data } = model.sprites;
  const base = k * size * size;
  const texel = (x: number, y: number) => (x < 0 || y < 0 || x >= size || y >= size ? 0 : data[base + y * size + x]);
  const sample = (x: number, y: number) => {
    const fx = x - 0.5;
    const fy = y - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    return (
      (texel(x0, y0) * (1 - tx) + texel(x0 + 1, y0) * tx) * (1 - ty) + (texel(x0, y0 + 1) * (1 - tx) + texel(x0 + 1, y0 + 1) * tx) * ty
    );
  };
  const out = new Float64Array(bins);
  const angles = 16;
  for (let b = 0; b < bins; b++) {
    const r = (b / (bins - 1)) * (size / 2);
    let sum = 0;
    for (let a = 0; a < angles; a++) {
      const t = (2 * Math.PI * a) / angles;
      sum += sample(size / 2 + r * Math.cos(t), size / 2 + r * Math.sin(t));
    }
    out[b] = sum / angles;
  }
  return out;
}

/** The light the look-alike draws for a Glow Sphere at radius `r` (pixels), opacity 1. */
function glowSphere(r: number, size: number, feather: number, glowSize: number, glowOpacity: number): number {
  const inner = size / 2;
  const edge = inner * (1 + 1.8 * feather);
  const core = r <= inner ? 1 : r >= edge ? 0 : 1 - (r - inner) / Math.max(1e-6, edge - inner);
  const glow = glowOpacity * Math.max(0, 1 - r / Math.max(1e-6, edge * glowSize));
  return core + glow * (1 - core);
}

interface SpriteFit {
  size: number;
  feather: number;
  glowSize: number;
  glowOpacity: number;
  /** Light at the centre. */
  peak: number;
}

/** Glow Sphere fits by model and speed class, valid while the model arrays they were fitted to hash to `fingerprint`. */
const fitCache = new WeakMap<ParticleWorldModel, { fingerprint: number; profiles: Float64Array[]; fits: Map<string, SpriteFit> }>();

function fingerprint(model: ParticleWorldModel): number {
  let h = 0x811c9dc5;
  for (const array of [model.prototypes, model.weights, model.sprites.data]) {
    const bits = new Int32Array(array.buffer, array.byteOffset, array.length);
    for (let i = 0; i < bits.length; i++) h = Math.imul(h ^ bits[i], 0x01000193);
  }
  return h;
}

/**
 * The Glow Sphere fit to the light of a speed class's sprites, with its size in units of the class's typical
 * size: radii and sizes scale together, so one fit serves every comp size.
 */
function classFit(model: ParticleWorldModel, key: string, members: readonly { seen: number; amp: number; sprite: number }[]): SpriteFit {
  const print = fingerprint(model);
  let cache = fitCache.get(model);
  if (cache?.fingerprint !== print) {
    cache = { fingerprint: print, profiles: Array.from({ length: model.sprites.count }, (_, k) => spriteProfile(model, k, 64)), fits: new Map() };
    fitCache.set(model, cache);
  }
  const cached = cache.fits.get(key);
  if (cached) return cached;
  const bins = 48;
  const radii = Float64Array.from({ length: bins }, (_, i) => ((i + 0.5) / bins) * model.sprites.reach);
  const light = new Float64Array(bins);
  let lightWeight = 0;
  for (const r of members) {
    const profile = cache.profiles[r.sprite];
    const weight = r.seen * r.amp;
    lightWeight += r.seen;
    for (let i = 0; i < bins; i++) {
      const x = ((i + 0.5) / bins) * (profile.length - 1);
      const k = Math.min(profile.length - 2, Math.floor(x));
      light[i] += weight * (profile[k] + (profile[k + 1] - profile[k]) * (x - k));
    }
  }
  for (let i = 0; i < bins; i++) light[i] /= Math.max(lightWeight, 1e-9);
  const fit = fitGlowSphere(radii, light, 1);
  cache.fits.set(key, fit);
  return fit;
}

/** Glow Sphere settings whose light profile is closest (area-weighted least squares) to `target` sampled at `radii`. */
function fitGlowSphere(radii: Float64Array, target: Float64Array, typical: number): SpriteFit {
  let best: SpriteFit & { error: number } = { size: typical, feather: 0.5, glowSize: 3, glowOpacity: 0.25, peak: 1, error: Infinity };
  const model = new Float64Array(radii.length);
  for (let f = 0; f <= 10; f++) {
    for (let g = 0; g <= 20; g++) {
      for (let o = 0; o <= 20; o++) {
        for (let d = 1; d <= 80; d++) {
          const size = (d / 20) * typical;
          const feather = f / 10;
          const glowSize = 1 + g / 4;
          const glowOpacity = o / 20;
          let tm = 0;
          let mm = 0;
          for (let i = 0; i < radii.length; i++) {
            model[i] = glowSphere(radii[i], size, feather, glowSize, glowOpacity);
            tm += radii[i] * target[i] * model[i];
            mm += radii[i] * model[i] * model[i];
          }
          const peak = mm > 0 ? Math.max(0, tm / mm) : 0;
          let error = 0;
          for (let i = 0; i < radii.length; i++) error += radii[i] * (target[i] - peak * model[i]) ** 2;
          if (error < best.error) best = { size, feather, glowSize, glowOpacity, peak, error };
        }
      }
    }
  }
  return best;
}

/** A curve as evenly spaced points, normalized to peak at 1; returns the points and the peak. */
function curvePoints(at: (u: number) => number): { points: [number, number][]; peak: number } {
  const raw = Array.from({ length: CURVE_POINTS }, (_, k) => [k / (CURVE_POINTS - 1), at(k / (CURVE_POINTS - 1))] as [number, number]);
  const peak = Math.max(...raw.map(([, v]) => v), 1e-6);
  return { points: raw.map(([u, v]) => [u, v / peak]), peak };
}

/** Keyframes of `value` at every frame, without those a straight line through the kept ones reproduces. */
function simplifiedKeys(frames: number, frameRate: number, value: (t: number) => number): { time: number; value: number }[] {
  const keys = Array.from({ length: frames + 1 }, (_, k) => ({ time: k / frameRate, value: value(k / frameRate) }));
  if (keys.length <= 2) return keys;
  const kept = [keys[0]];
  let anchor = 0;
  for (let end = 2; end < keys.length; end++) {
    const a = keys[anchor];
    const b = keys[end];
    let fits = true;
    for (let i = anchor + 1; i < end && fits; i++) {
      const line = a.value + ((b.value - a.value) * (keys[i].time - a.time)) / (b.time - a.time);
      fits = Math.abs(line - keys[i].value) <= SPEED_TOLERANCE * Math.max(Math.abs(keys[i].value), 1e-3);
    }
    if (!fits) {
      anchor = end - 1;
      kept.push(keys[anchor]);
    }
  }
  kept.push(keys.at(-1)!);
  return kept;
}

const degrees = (radians: number) => (radians * 180) / Math.PI;
const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

/** Particular settings reproducing `model` in a comp; `features` is the comp's soundtrack (null for none). */
export function particularSettings(model: ParticleWorldModel, target: ParticularTarget, features: AudioFeatures | null): ParticularSettings {
  const { source } = model;
  const H = target.height;
  const scale = H / source.height;
  const cx = target.width / 2;
  const cy = target.height / 2;
  // Where the particles stream out of, framed as in the reference (centred, scaled to the height).
  const ex = cx + (source.center[0] - source.width / 2) * scale;
  const ey = cy + (source.center[1] - source.height / 2) * scale;
  // Particles fly from that point toward the camera: the World Transform turns Particular's
  // Directional emission (+Z) there, Rx(a) Ry(b) (0, 0, 1) = (sin b, -sin a cos b, cos a cos b).
  const zoom = target.zoom;
  const toward = [(ex - cx) / zoom, (ey - cy) / zoom, 1];
  const norm = Math.hypot(toward[0], toward[1], toward[2]);
  const d = toward.map((c) => -c / norm);
  const rotationY = degrees(Math.asin(d[0]));
  const rotationX = (degrees(Math.atan2(-d[1], d[2])) + 360) % 360;

  // The model's clock as Physics Time Factor. Pre Run fills only the share of a life the
  // factor at time 0 gives (below 1), so simulation time is stretched until that factor
  // is at least 1: factors and lives times `stretch`, speeds and rates divided by it.
  const clock = new Clock(model.dynamics, features, model.preRun, { reactivity: 1, speed: 1 });
  const frames = Math.max(1, Math.round(target.duration * target.frameRate));
  const stretch = 1 / Math.min(1, Math.max(clock.speedAt(0), 1e-3));
  const timeFactor = features
    ? simplifiedKeys(frames, target.frameRate, (t) => round(clock.speedAt(t) * stretch, 3))
    : round(clock.speedAt(0) * stretch, 3);

  const count = model.weights.length;
  const rows = Array.from({ length: count }, (_, i) => {
    const p = model.prototypes.subarray(i * PROTO_STRIDE, (i + 1) * PROTO_STRIDE);
    const births = Math.max(0, model.weights[i]);
    const life = Math.max(1e-3, p[P_LIFE]);
    const speed = Math.max(0, -p[P_VZ]);
    return {
      births,
      seen: births * life,
      life,
      speed,
      approach: speed * zoom,
      across: Math.hypot(p[P_VX], p[P_VY]) * H,
      x: p[P_OX] * H,
      y: p[P_OY] * H,
      size: p[P_SIZE] * H,
      amp: p[P_AMP],
      sprite: p[P_SPRITE],
    };
  });
  const totalBirths = rows.reduce((s, r) => s + r.births, 0) || 1;
  rows.sort((a, b) => a.speed - b.speed);
  const classCount = Math.max(1, Math.min(3, Math.floor(count / MIN_CLASS)));
  const totalSeen = rows.reduce((s, r) => s + r.seen, 0) || 1;
  const classes: (typeof rows)[] = Array.from({ length: classCount }, () => []);
  let seen = 0;
  for (const r of rows) {
    classes[Math.min(classCount - 1, Math.floor((seen / totalSeen) * classCount))].push(r);
    seen += r.seen;
  }

  const j = model.jitter;
  const layers: ParticularLayerSettings[] = [];
  classes.forEach((members, c) => {
    if (!members.length) return;
    const bySeen = (value: (r: (typeof rows)[number]) => number) => members.map((r) => ({ value: value(r), weight: r.seen }));
    const byBirths = (value: (r: (typeof rows)[number]) => number) => members.map((r) => ({ value: value(r), weight: r.births }));
    const births = members.reduce((s, r) => s + r.births, 0);
    const share = births / totalBirths;

    // Life and rate: the same mean visible life and the same number on screen.
    const seenLife = mean(bySeen((r) => r.life));
    const life = seenLife / LIFE_SEEN;
    const birthLife = mean(byBirths((r) => r.life));
    const rate = (model.rate * share * birthLife) / (LIFE_MEAN * life);

    // Motion toward the camera (pixels per clock second) and across it.
    const velocity = mean(bySeen((r) => r.approach));
    const velocityRandom = velocity > 0 ? Math.min(1, (Math.sqrt(3) * spread(bySeen((r) => r.approach))) / velocity) : 0;
    // Directional spread s turns the direction by s · |xy of a random unit vector| (median √0.75).
    const sideways = quantile(bySeen((r) => r.across / Math.max(r.approach, 1e-6)), 0.5);
    const directionSpread = Math.min(1, sideways / Math.sqrt(0.75));

    // Birth area: a box matching the middle 80 % of births across and down, centred on them.
    const xs = byBirths((r) => r.x);
    const ys = byBirths((r) => r.y);
    const [x10, x90, y10, y90] = [quantile(xs, 0.1), quantile(xs, 0.9), quantile(ys, 0.1), quantile(ys, 0.9)];
    const boxCenter = [(x10 + x90) / 2, (y10 + y90) / 2];

    // Look: sizes, brightness and the sprite's light profile at the typical size.
    const typical = mean(bySeen((r) => r.size));
    const sizeSpread = Math.hypot(spread(bySeen((r) => r.size)) / Math.max(typical, 1e-6), j[2]);
    const sizeRandom = Math.min(1, Math.sqrt(12) * sizeSpread);
    const amp = mean(bySeen((r) => r.amp));
    const ampSpread = Math.hypot(spread(bySeen((r) => r.amp)) / Math.max(amp, 1e-6), j[3]);
    const opacityRandom = Math.min(1, ampSpread / (1 / Math.sqrt(12) + ampSpread / 2));
    const fit = classFit(model, `${classCount}:${c}`, members);
    let seenWeight = 0;
    const tint = [0, 0, 0];
    for (const r of members) {
      seenWeight += r.seen;
      for (let ch = 0; ch < 3; ch++) tint[ch] += r.seen * model.sprites.tint[r.sprite * 3 + ch];
    }

    // Over Life, for the class's mean approach: depth z = 1 - approach · u.
    const approach = Math.min(MAX_APPROACH, (velocity * LIFE_MEAN * life) / zoom);
    const depth = (u: number) => 1 - approach * u;
    const sizeCurve = curvePoints((u) => depth(u) ** (1 - Math.max(0, Math.min(1, model.sizeDepth))));
    const opacityCurve = curvePoints((u) => opacityAt(model, u) * depth(u) ** -model.lightDepth);
    const opacity = Math.min(1, (fit.peak * opacityCurve.peak) / (1 - opacityRandom / 2));

    const numbers = new Map<number, number>([
      [P.rate, round(rate / stretch, 2)],
      [P.emitterType, EMITTER_BOX],
      [P.emitterSize, SIZE_XYZ],
      [P.emitterSizeX, Math.round((x90 - x10) / 0.8)],
      [P.emitterSizeY, Math.round((y90 - y10) / 0.8)],
      [P.emitterSizeZ, 0],
      [P.direction, DIRECTIONAL],
      [P.spread, round(directionSpread * 100, 1)],
      [P.velocity, round(velocity / stretch, 2)],
      [P.velocityRandom, Math.round(velocityRandom * 100)],
      [P.velocityFromMotion, 0],
      [P.life, round(life * stretch, 2)],
      [P.lifeRandom, 100],
      [P.particleType, GLOW_SPHERE],
      [P.size, round(fit.size * typical * sizeCurve.peak, 2)],
      [P.sizeRandom, Math.round(sizeRandom * 100)],
      [P.feather, Math.round(fit.feather * 100)],
      [P.opacity, round(opacity * 100, 1)],
      [P.opacityRandom, Math.round(opacityRandom * 100)],
      [P.glowSize, Math.round(fit.glowSize * 100)],
      [P.glowOpacity, Math.round(fit.glowOpacity * 100)],
      [P.preRun, 100],
      [P.seed, 100000 + 7919 * c],
      [P.worldRotationX, round(rotationX)],
      [P.worldRotationY, round(rotationY)],
      [P.worldRotationZ, 0],
      [P.worldOffsetX, round(ex + boxCenter[0] - cx, 1)],
      [P.worldOffsetY, round(ey + boxCenter[1] - cy, 1)],
      [P.worldOffsetZ, 0],
      [P.nearStartFade, Math.round(NEAR_FADE * zoom)],
      [P.nearVanish, Math.round(NEAR_VANISH * zoom)],
      [P.depthOfField, DOF_OFF],
    ]);
    const name = CLASS_NAMES[classCount - 1][c];
    layers.push({
      name: name ? `Particles (${name})` : "Particles",
      numbers,
      color: tint.map((v) => Math.min(1, v / Math.max(seenWeight, 1e-9))) as [number, number, number],
      sizeOverLife: sizeCurve.points,
      opacityOverLife: opacityCurve.points,
      share,
    });
  });

  const mirror: [number, number] | null = source.mirrorAxis === null ? null : [cx + (source.mirrorAxis - source.width / 2) * scale, cy];
  return { layers, timeFactor, mirror };
}

function particularInstance(template: EffectTemplate, layer: ParticularLayerSettings, timeFactor: ParticularSettings["timeFactor"]): ReturnType<typeof newInstance> {
  const sspc = newInstance(template);
  for (const [n, value] of layer.numbers) setInstanceNumber(sspc, PARTICULAR, n, value);
  if (typeof timeFactor === "number") setInstanceNumber(sspc, PARTICULAR, P.timeFactor, timeFactor);
  setInstanceColor(sspc, PARTICULAR, P.color, layer.color);
  setInstancePoint(sspc, PARTICULAR, P.position, [0.5, 0.5, 0]);
  setInstanceData(sspc, PARTICULAR, P.sizeOverLife, (data) => drawnCurve(data, layer.sizeOverLife));
  setInstanceData(sspc, PARTICULAR, P.opacityOverLife, (data) => drawnCurve(data, layer.opacityOverLife));
  return sspc;
}

/** Parameter `n` of the first `matchName` effect on `layer`. */
export function effectParam(layer: Layer, matchName: string, n: number): Property | undefined {
  const parade = layer.properties.find((node): node is PropertyGroup => node.kind === "group" && node.matchName === "ADBE Effect Parade");
  const effect = parade?.children.find((node): node is PropertyGroup => node.kind === "group" && node.matchName === matchName);
  const param = `${matchName}-${String(n).padStart(4, "0")}`;
  return effect?.children.find((node): node is Property => node.kind === "property" && node.matchName === param);
}

/**
 * Adds a comp-sized solid with Particular (and a Mirror when the reference is
 * mirrored) for each layer of `settings`, on top of `comp`, as one undoable step.
 * Returns the new layers' ids, top first.
 */
export async function createParticularLayers(editor: Editor, comp: CompItem, settings: ParticularSettings): Promise<number[]> {
  const templates = await effectTemplates();
  const particular = templates.get(PARTICULAR);
  const mirror = templates.get(MIRROR);
  if (!particular || !mirror) throw new Error("the Particular templates are missing");
  const ids: number[] = [];
  const label = settings.layers.length > 1 ? "Create Particular Layers" : "Create Particular Layer";
  editor.perform(label, [comp], () => {
    for (const layer of [...settings.layers].reverse()) {
      const id = addLayer(editor, comp, { kind: "solid", name: layer.name, color: [0, 0, 0], width: comp.width, height: comp.height, pixelAspect: comp.pixelAspect });
      const effects = [{ template: particular, instance: particularInstance(particular, layer, settings.timeFactor) }];
      if (settings.mirror) {
        const instance = newInstance(mirror);
        setInstancePoint(instance, MIRROR, MIRROR_CENTER, [settings.mirror[0] / comp.width, settings.mirror[1] / comp.height]);
        effects.push({ template: mirror, instance });
      }
      addEffects(editor, comp, id, effects);
      if (Array.isArray(settings.timeFactor)) {
        const target = comp.layers.find((l) => l.id === id);
        const prop = target && effectParam(target, PARTICULAR, P.timeFactor);
        if (!target || !prop) throw new Error("the new Particular has no Physics Time Factor");
        editor.replaceKeyframes(comp, target, [{ prop, keys: settings.timeFactor }], 0, comp.duration, "Physics Time Factor");
      }
      ids.unshift(id);
    }
  });
  return ids;
}
