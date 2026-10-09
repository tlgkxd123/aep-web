// Particle Match (Extra > Particle Match): particles from a world model learned
// from a reference video (src/extra/pmatch), driven by the Audio Layer's sound. It
// replaces the layer's pixels with the particles' light (src/extra/pmatch/draw.ts).
import type { CompItem, Layer, Project, PropertyGroup } from "../../aep/model.ts";
import { audioFeatures, type AudioFeatures } from "../../extra/pmatch/audio.ts";
import { drawParticles } from "../../extra/pmatch/draw.ts";
import { Clock } from "../../extra/pmatch/dynamics.ts";
import { modelChunk, PARTICLE_MATCH, PM } from "../../extra/pmatch/effectSpec.ts";
import { decodeModel } from "../../extra/pmatch/model.ts";
import { particlesAt, prepare, type Instances, type Prepared } from "../../extra/pmatch/sample.ts";
import type { AudioData } from "../../media/audio.ts";
import { layerAudio, mixWindow, type LayerAudio } from "../../media/mix.ts";
import { effectNumber, effectVector } from "../effectParams.ts";
import type { GL } from "../gl.ts";
import { registerEffect } from "../registry.ts";

const models = new WeakMap<Uint8Array, Prepared | Error>();
function modelOf(effect: PropertyGroup): Prepared | Error | null {
  const data = modelChunk(effect)?.data;
  if (!data) return null;
  let prepared = models.get(data);
  if (!prepared) {
    try {
      prepared = prepare(decodeModel(data));
    } catch (e) {
      prepared = e instanceof Error ? e : new Error(String(e));
    }
    models.set(data, prepared);
  }
  return prepared;
}

const compOfLayer = new WeakMap<Layer, CompItem>();
function compOf(project: Project, layer: Layer): CompItem | undefined {
  let comp = compOfLayer.get(layer);
  if (comp) return comp;
  for (const item of project.items.values()) if (item.kind === "comp" && item.layers.includes(layer)) comp = item;
  if (comp) compOfLayer.set(layer, comp);
  return comp;
}

/** Features of a layer's sound over a whole comp, per first decoded source and the way it is heard. */
const featureCache = new WeakMap<AudioData, Map<string, AudioFeatures>>();
function featuresOf(audio: LayerAudio, duration: number): AudioFeatures {
  const first = audio.contributions[0].audio;
  const key = `${duration}|${audio.rate}|${audio.timeScale}|${audio.contributions.map((c) => `${c.scale},${c.offset},${c.from},${c.to},${c.audio.length}`).join(";")}`;
  let perSource = featureCache.get(first);
  if (!perSource) featureCache.set(first, (perSource = new Map()));
  let features = perSource.get(key);
  if (!features) {
    features = audioFeatures((start, length) => mixWindow(audio, start, length), audio.rate * audio.timeScale, duration);
    perSource.set(key, features);
  }
  return features;
}

const featureIds = new WeakMap<AudioFeatures, number>();
let nextFeatureId = 1;
const clocks = new WeakMap<Prepared, Map<string, Clock>>();
function clockOf(prepared: Prepared, features: AudioFeatures | null, reactivity: number, speed: number): Clock {
  let id = 0;
  if (features) {
    id = featureIds.get(features) ?? nextFeatureId++;
    featureIds.set(features, id);
  }
  const key = `${id}|${reactivity}|${speed}`;
  let perModel = clocks.get(prepared);
  if (!perModel) clocks.set(prepared, (perModel = new Map()));
  let clock = perModel.get(key);
  if (!clock) {
    clock = new Clock(prepared.model.dynamics, features, prepared.model.preRun, { reactivity, speed });
    if (perModel.size > 16) perModel.clear();
    perModel.set(key, clock);
  }
  return clock;
}

const scratch = new WeakMap<GL, Instances>();

registerEffect(PARTICLE_MATCH, (input, effect, layer, time, ctx) => {
  const { width, height } = input;
  const pad = ctx.pad;
  const out = ctx.pool.acquire(width + 2 * pad, height + 2 * pad);
  ctx.pool.release(input.target);
  const result = { ...input, target: out };
  const prepared = modelOf(effect);
  if (!prepared) {
    ctx.warn("Particle Match has no model; train one with Extra > Particle Match");
    return result;
  }
  if (prepared instanceof Error) {
    ctx.warn(`Particle Match model cannot be read: ${prepared.message}`);
    return result;
  }
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  const comp = compOf(ctx.project, layer);
  let features: AudioFeatures | null = null;
  const audioIndex = num(PM.audioLayer, 0);
  const audioLayer = audioIndex ? comp?.layers.find((l) => l.index === audioIndex) : undefined;
  if (audioLayer) {
    const audio = layerAudio(ctx.project, audioLayer, time);
    if (audio === "pending") ctx.loading(`audio is loading ("${audioLayer.name}")`);
    else if (audio) features = featuresOf(audio, Math.max(comp?.duration ?? 0, time + 1));
  }
  const clock = clockOf(prepared, features, Math.max(0, num(PM.reactivity, 100)) / 100, Math.max(0, num(PM.speed, 100)) / 100);
  const emitter = effectVector(effect, PM.emitter, layer, time, [width / 2, height / 2]);
  const color = effectVector(effect, PM.color, layer, time, [1, 1, 1, 1]);
  const gl = ctx.gl;
  const instances = particlesAt(
    prepared,
    clock.timeAt(time),
    clock.zoomAt(time),
    {
      x: emitter[0] ?? width / 2,
      y: emitter[1] ?? height / 2,
      scale: ((comp?.height ?? height) * Math.max(0, num(PM.scale, 100))) / 100,
      width,
      height,
      size: Math.max(0, num(PM.size, 100)) / 100,
      light: Math.max(0, num(PM.brightness, 100)) / 100,
      density: Math.max(0, num(PM.density, 100)) / 100,
      seed: Math.round(num(PM.seed, 1)),
    },
    scratch.get(gl),
  );
  scratch.set(gl, instances);
  drawParticles(gl, out, pad, width, height, prepared, instances, color);
  return result;
});
