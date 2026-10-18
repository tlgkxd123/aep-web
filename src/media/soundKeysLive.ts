// Sound Keys' Outputs without keyframes follow the Audio Layer live: each reads the value Apply would key at that
// time (between keys, the line between them), so expressions and the plugin's display react to the audio without
// applying. A saved project stores them static, as After Effects keeps them until Apply bakes the keys.
//
// Levels are kept per key of Apply's grid, so playing analyses about one key per frame; a falloff only looks back
// as far as it remembers, except Integrate, which sums every key from the first (in idle time, ahead of the reads).
import { getExpressionScope, registerLiveValue, type ExpressionScope } from "../aep/evaluate.ts";
import type { CompItem, Layer, Project, Property, PropertyGroup } from "../aep/model.ts";
import { layerAudio, mixWindow, type LayerAudio } from "./mix.ts";
import {
  appliedSettings,
  FALLOFF,
  falloffStep,
  keyGrid,
  rangeLevelAnalyser,
  SOUND_KEYS,
  type KeyGrid,
  type SampleReader,
  type SoundKeysRange,
  type SoundKeysSettings,
} from "./soundKeys.ts";

/** Parameter indices of Output 1-3. */
const OUTPUTS = [21, 33, 45];
/** How small a remembered exponential level gets before it no longer counts. */
const FORGOTTEN = 1e-4;
const MAX_ANALYSES = 8;

export interface Analysis {
  grid: KeyGrid;
  ranges: number;
  levelsAt: (t: number) => number[];
  /** The level of range r at key k is at k·ranges + r; NaN until analysed. */
  levels: Float32Array;
  /** Per range, the running sum of its levels over the first `summed` keys. */
  sums: Float64Array[];
  summed: number;
  /** Whether idle time is filling `sums` ahead of the reads. */
  filling?: boolean;
  /** Dropped from the cache: nothing fills it any more. */
  retired?: boolean;
}

/** Analyses by what their levels depend on, most recently used last. */
const analyses = new Map<string, Analysis>();

const audioIds = new WeakMap<object, number>();
let nextAudioId = 1;
function audioId(data: object): number {
  let id = audioIds.get(data);
  if (!id) audioIds.set(data, (id = nextAudioId++));
  return id;
}

/** The levels of `settings`' ranges on `grid`, analysed as they are read. */
export function createAnalysis(settings: SoundKeysSettings, grid: KeyGrid, rate: number, read: SampleReader): Analysis {
  const ranges = settings.ranges.length;
  return {
    grid,
    ranges,
    levelsAt: rangeLevelAnalyser(settings, rate, read),
    levels: new Float32Array(grid.count * ranges).fill(Number.NaN),
    sums: settings.ranges.map(() => new Float64Array(grid.count)),
    summed: 0,
  };
}

function analysisOf(settings: SoundKeysSettings, grid: KeyGrid, audio: LayerAudio): Analysis {
  const rate = audio.rate * audio.timeScale;
  const key = JSON.stringify([
    settings.width,
    settings.height,
    settings.channel ?? -1,
    settings.scale,
    settings.eq,
    settings.ranges.map((r) => [r.type, r.x0, r.x1, r.yTop, r.yBottom]),
    grid,
    rate,
    audio.contributions.map((c) => [audioId(c.audio), c.scale, c.offset, c.from, c.to]),
  ]);
  let analysis = analyses.get(key);
  if (analysis) analyses.delete(key);
  else {
    analysis = createAnalysis(settings, grid, rate, (first, length) => mixWindow(audio, first, length, settings.channel));
    if (analyses.size >= MAX_ANALYSES) {
      const oldest = analyses.keys().next().value!;
      analyses.get(oldest)!.retired = true;
      analyses.delete(oldest);
    }
  }
  analyses.set(key, analysis);
  return analysis;
}

function level(a: Analysis, k: number, r: number): number {
  const at = k * a.ranges;
  if (Number.isNaN(a.levels[at])) a.levels.set(a.levelsAt(a.grid.from + k * a.grid.step), at);
  return a.levels[at + r];
}

function sumThrough(a: Analysis, k: number): void {
  for (; a.summed <= k; a.summed++) {
    const j = a.summed;
    for (let r = 0; r < a.ranges; r++) a.sums[r][j] = (j ? a.sums[r][j - 1] : 0) + level(a, j, r);
  }
}

type IdleCallback = (work: (deadline: { timeRemaining(): number }) => void) => void;

/** Sums every key in idle time, so reading Integrate late in the audio does not analyse all the keys before it at once. */
function fillInBackground(a: Analysis): void {
  const idle = (globalThis as { requestIdleCallback?: IdleCallback }).requestIdleCallback;
  if (!idle || a.filling) return;
  a.filling = true;
  const work = (deadline: { timeRemaining(): number }) => {
    if (a.retired) return;
    while (a.summed < a.grid.count && deadline.timeRemaining() > 2) sumThrough(a, a.summed);
    if (a.summed < a.grid.count) idle(work);
  };
  idle(work);
}

/** The state (0..1, or the sum for Integrate) of range `r` at key `k`, as Apply computes it from the first key. */
function stateAt(a: Analysis, range: SoundKeysRange, r: number, k: number): number {
  const { step } = a.grid;
  if (range.falloff === FALLOFF.INTEGRATE) {
    fillInBackground(a);
    sumThrough(a, k);
    return a.sums[r][k];
  }
  let memory = 0;
  if (range.falloffTime > 0 && range.falloff === FALLOFF.LINEAR) memory = Math.ceil(range.falloffTime / step);
  if (range.falloffTime > 0 && range.falloff === FALLOFF.EXPONENTIAL) memory = Math.ceil((Math.log(1 / FORGOTTEN) * range.falloffTime) / (3 * step));
  const first = Math.max(0, k - memory);
  let state = level(a, first, r);
  for (let j = first + 1; j <= k; j++) state = falloffStep(range, state, level(a, j, r), step);
  return state;
}

/** Output values by match name; empty when the Outputs keep their stored values. */
type Outputs = Map<string, number>;
const NONE: Outputs = new Map();

function outputsAt(scope: ExpressionScope, comp: CompItem, layer: Layer, effect: PropertyGroup, time: number): Outputs | "pending" {
  const settings = appliedSettings(scope.project, comp, layer, effect);
  const audioLayer = comp.layers.find((l) => l.index === settings.audioLayer);
  if (!audioLayer || !settings.ranges.length) return NONE;
  const grid = keyGrid(audioLayer, comp.duration, settings.keysPerSecond);
  if (!grid.count) return NONE;
  const audio = layerAudio(scope.project, audioLayer, grid.from);
  if (audio === "pending") {
    scope.loading?.(`audio is loading ("${audioLayer.name}")`);
    return "pending";
  }
  if (!audio) return NONE;
  const values = outputsOf(analysisOf(settings, grid, audio), settings, time);
  return new Map(settings.ranges.map((range, r) => [`${SOUND_KEYS}-${String(range.output).padStart(4, "0")}`, values[r]]));
}

/** The Outputs of `settings`' ranges at comp time `time`: Apply's keys there, held before the first and after the last. */
export function outputsOf(a: Analysis, settings: SoundKeysSettings, time: number): number[] {
  const { grid } = a;
  const u = Math.max(0, Math.min(grid.count - 1, (time - grid.from) / grid.step));
  const k0 = Math.floor(u + 1e-9);
  const k1 = Math.min(grid.count - 1, k0 + 1);
  const frac = Math.max(0, u - k0);
  return settings.ranges.map((range, r) => {
    const s0 = stateAt(a, range, r, k0);
    const state = frac > 0 && k1 > k0 ? s0 + (stateAt(a, range, r, k1) - s0) * frac : s0;
    return range.min + state * (range.max - range.min);
  });
}

const effectOfOutput = new WeakMap<Property, PropertyGroup | null>();
function effectOf(layer: Layer, prop: Property): PropertyGroup | undefined {
  let effect = effectOfOutput.get(prop);
  if (effect === undefined) {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    effect = parade?.children.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === SOUND_KEYS && n.children.includes(prop)) ?? null;
    effectOfOutput.set(prop, effect);
  }
  return effect ?? undefined;
}

const compOfLayer = new WeakMap<Layer, CompItem>();
function compOf(project: Project, layer: Layer): CompItem | undefined {
  let comp = compOfLayer.get(layer);
  if (comp) return comp;
  for (const item of project.items.values()) if (item.kind === "comp" && item.layers.includes(layer)) comp = item;
  if (comp) compOfLayer.set(layer, comp);
  return comp;
}

/** The last outputs worked out per effect, for the scope and time they were read in. */
const recent = new WeakMap<PropertyGroup, { scope: ExpressionScope; time: number; outputs: Outputs }>();
const busy = new Set<PropertyGroup>();

function liveOutput(prop: Property, time: number, layer: Layer): number | undefined {
  const scope = getExpressionScope();
  if (!scope) return undefined;
  const effect = effectOf(layer, prop);
  if (!effect || busy.has(effect)) return undefined;
  const last = recent.get(effect);
  if (last && last.scope === scope && last.time === time) return last.outputs.get(prop.matchName);
  const comp = compOf(scope.project, layer);
  if (!comp) return undefined;
  busy.add(effect);
  try {
    const outputs = outputsAt(scope, comp, layer, effect, time);
    if (outputs === "pending") return undefined;
    recent.set(effect, { scope, time, outputs });
    return outputs.get(prop.matchName);
  } finally {
    busy.delete(effect);
  }
}

for (const index of OUTPUTS) registerLiveValue(`${SOUND_KEYS}-${String(index).padStart(4, "0")}`, liveOutput);
