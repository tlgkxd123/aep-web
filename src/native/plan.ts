// A frame as the native Vulkan engine (native/) renders it: what the WebGL renderer (src/render/renderer.ts) would
// draw, with every value already evaluated (keyframes, expressions, parenting, cameras). The engine composites the
// plan on the GPU; the plan holds no pixels of its own beyond the images it lists.
//
// Images are in their own pixels, y down, with the renderer's 1 px transparent border (PAD) around them. A plan the
// engine cannot render faithfully lists why in `unsupported`; the frame is then left to the WebGL renderer.
import { currentValue, layerTimeAt, setExpressionScope, valueAtTime } from "../aep/evaluate.ts";
import { sequenceFrameName } from "../aep/footage.ts";
import { AlphaMode, isShapeValue, type CompItem, type FootageItem, type Layer, type Project, type Property, type PropertyGroup, type PropertyNode } from "../aep/model.ts";
import { cameraAt, localTransform, Mat4, worldMatrix, type Camera } from "../aep/transform.ts";
import { anySolo, drawOrder, isActive, MATTE_MODES, matteLayerOf, MAX_DEPTH, NO_MATTE, PAD, scaledSize } from "../render/composition.ts";
import { footageFrameIndex, layerSourceTime, sourcePixelAspect } from "../render/footage.ts";
import { MatteMode } from "../render/shaders.ts";
import { planShapeLayer, type ShapePaintPlan } from "../render/shapes.ts";
import { instanceData } from "../render/effects/colorExtraMath.ts";
import { MISSING_PLUGINS, nativeEffect } from "./effects.ts";

/** Footage stills the engine decodes itself (PNG, BMP and TIFF in native/src/image.cpp, JPEG through FFmpeg in native/src/video.cpp). */
const NATIVE_IMAGE = /\.(png|bmp|tiff?|jpe?g)$/i;
/** Video files the engine decodes itself (native/src/video.cpp, with FFmpeg on desktop and the system decoder on Android). */
const NATIVE_VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

/** PF_Param_LAYER: an effect parameter naming a layer of the comp by index. */
const LAYER_CONTROL = 0;

/** Effects that hear another layer: the declared index of their audio layer parameter (a layer of the comp by index). */
const AUDIO_LAYER_PARAMS: Readonly<Record<string, number>> = { "ADBE AudSpect": 1 };
/** Effects that follow a mask of their layer: the declared index of their Path parameter (1-based mask, 0 none). */
const PATH_PARAMS: Readonly<Record<string, number>> = { "ADBE AudSpect": 4 };
/** The parameters whose stored data an effect reads (instanceData in colorExtraMath.ts): Curves' tables, Colorama's cycle. */
export const DATA_PARAMS: Readonly<Record<string, readonly number[]>> = { "ADBE CurvesCustom": [1], "APC Colorama": [12] };
/** Comps nested deeper than this are not heard (mix.ts). */
const MAX_AUDIO_DEPTH = 16;

/** n for a parameter match name "<effect match name>-000n", else 0. */
function declaredIndex(effect: string, matchName: string): number {
  if (matchName.length !== effect.length + 5 || !matchName.startsWith(effect) || matchName[effect.length] !== "-") return 0;
  const digits = matchName.slice(effect.length + 1);
  return /^\d{4}$/.test(digits) ? Number(digits) : 0;
}

export type { ShapePaintPlan };

const MASK_NONE = 6812;

export interface PlanComp {
  /** Content size at the plan's resolution, without the border. */
  width: number;
  height: number;
  /** Bottom layer first. */
  layers: PlanLayer[];
}

interface ContentBase {
  /** Content size in image pixels, without the border. */
  width: number;
  height: number;
  /** Image position of the first content pixel, relative to the layer origin (image pixels). */
  origin: [number, number];
  /** Image pixels per layer pixel. */
  scale: number;
}

export type PlanContent =
  | (ContentBase & { kind: "solid"; color: [number, number, number] })
  | (ContentBase & { kind: "comp"; comp: PlanComp })
  | (ContentBase & { kind: "image"; image: number })
  | (ContentBase & { kind: "shape"; paints: ShapePaintPlan[] })
  | (ContentBase & FootagePlan);

/**
 * A still image, a sequence frame or a video frame a footage layer shows (src/render/footage.ts): its file and the
 * Interpret Footage alpha settings. The content's size is the source's at the plan's scale; at a reduced scale each image pixel
 * averages the source pixels it covers, as INTERPRET_FS does.
 */
export interface FootagePlan {
  kind: "footage";
  /** The frame's file as the project records it; the engine relinks it (the most trailing folders in common). */
  file: string;
  /** The source's size as the project records it. */
  sourceWidth: number;
  sourceHeight: number;
  hasAlpha: boolean;
  invertAlpha: boolean;
  /** 0 straight, 1 premultiplied (against `matte`), 2 ignore. */
  alphaMode: 0 | 1 | 2;
  matte: [number, number, number];
  /**
   * Video: the seconds of the file's own time whose picture shows (the frame index over the file's native rate, as
   * footageStore reads it); -1 for a still image or a sequence frame.
   */
  videoTime: number;
}

export interface PlanMask {
  /** ExtendScript MaskMode (6813 Add ... 6818 Difference). */
  mode: number;
  inverted: boolean;
  /** 0..1. */
  opacity: number;
  /** Gaussian feather radius in image pixels. */
  feather: number;
  /** Mask Expansion in layer pixels (only growth is drawn, as the WebGL renderer does). */
  expansion: number;
  closed: boolean;
  /** Per vertex: x, y, in tangent x, y, out tangent x, y, in layer pixels. */
  vertices: number[];
}

/** An effect parameter's value at the frame's time: numbers; colours as straight RGBA 0..1; points in layer pixels. */
export interface PlanParam {
  /** The parameter's match name ("<effect match name>-0001" for the first declared one). */
  matchName: string;
  value: number[];
  /** A popup's menu: per entry, whether it is a separator (popupChoice counts the stored value past them). */
  menu?: boolean[];
}

export interface PlanEffect {
  matchName: string;
  params: PlanParam[];
  /** The other layers its layer parameters name; absent when none does. */
  sources?: PlanEffectSource[];
  /**
   * The sound of the layer its audio layer parameter names (Audio Spectrum), as the files heard and where: absent when
   * that names no layer, empty when the layer has no sound.
   */
  audio?: PlanAudioSource[];
  /** The mask its Path parameter names, at the frame's time; absent when that names none. */
  path?: { closed: boolean; vertices: number[] };
  /** A time effect's layer at the other times it reads (inputTimes), in their order; absent when it reads none. */
  inputs?: PlanEffectInput[];
  /** The data the effect stores for its DATA_PARAMS (instanceData), each by declared index; absent when it stores none. */
  data?: { param: number; bytes: Uint8Array }[];
}

/**
 * The layer as a time effect receives it at another comp time (inputAt in perspectiveTime.ts): its content, masks and
 * the enabled effects above the time effect, all at that time, in the layer's own pixels at full resolution.
 */
export interface PlanEffectInput {
  time: number;
  /** Null when the layer draws nothing then. */
  content: PlanContent | null;
  masks: PlanMask[];
  effects: PlanEffect[];
}

/**
 * A sound file heard in a layer's audio (Contribution in src/media/mixWindow.ts): source seconds = scale * t + offset
 * for comp time t (seconds of the comp the effect's layer is in) in [from, to).
 */
export interface PlanAudioSource {
  /** The footage's file as the project records it; the engine relinks it (the most trailing folders in common). */
  file: string;
  scale: number;
  offset: number;
  from: number;
  to: number;
}

/**
 * The layer an effect's layer parameter names (another layer of the comp, not the effect's own), as its content alone,
 * before its masks and effects (ctx.layerImage(other, time, false)): null content when it draws nothing.
 */
export interface PlanEffectSource {
  /** The layer parameter's declared index. */
  param: number;
  content: PlanContent | null;
  /** The other layer's size and kind, for its box (layerRect). */
  width: number;
  height: number;
  kind: number;
}

/** What effects read of their layer besides their parameters. */
export interface PlanEffectLayer {
  /** Composition time the layer is drawn at, and the layer's start time, in seconds. */
  time: number;
  startTime: number;
  /** The layer's time stretch as a fraction (1 when none; negative reverses it). */
  stretch: number;
  /** The layer's own size (its source's, or the comp's for a shape layer). */
  width: number;
  height: number;
  /** 0 AV layer, 1 shape layer, 2 other. */
  kind: number;
}

export interface PlanLayer {
  name: string;
  /** Adjustment layer: its content and masks only say where the comp below shows through its blend mode. */
  adjustment: boolean;
  blendMode: number;
  /** 0..1. */
  opacity: number;
  content: PlanContent;
  masks: PlanMask[];
  /**
   * Row-major 4x4 from layer pixels: for 2D layers to the comp image's pixels (border and resolution included); for
   * 3D layers to camera space, projected with `zoom`.
   */
  matrix: number[];
  /** Camera zoom in image pixels for a 3D layer; 0 for a 2D one. */
  zoom: number;
  /** Effects in stack order, run after the masks and before the matrix; expression controls are left out. */
  effects: PlanEffect[];
  /** Present when `effects` is not empty. */
  effectLayer?: PlanEffectLayer;
  matte?: { mode: number; opacity: number; layer: PlanLayer | null };
}

/** Straight-alpha RGBA pixels, top row first, that image content refers to by index. */
export interface PlanImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface FramePlan {
  root: PlanComp;
  images: PlanImage[];
  /** What the engine cannot render in this frame (an empty list: the plan is complete). */
  unsupported: string[];
  /** Things skipped as the WebGL renderer skips them (comps nested too deep...). */
  warnings: string[];
}

export interface PlanOptions {
  /** Resolution relative to the comp (1/2 for Half...), as RenderOptions.scale. */
  scale?: number;
}

function findProperty(nodes: PropertyNode[], path: string[]): Property | undefined {
  let level = nodes;
  for (let i = 0; i < path.length; i++) {
    const node = level.find((n) => n.matchName === path[i]);
    if (!node) return undefined;
    if (i === path.length - 1) return node.kind === "property" ? node : undefined;
    if (node.kind !== "group") return undefined;
    level = node.children;
  }
  return undefined;
}

function child(group: PropertyGroup, matchName: string): Property | undefined {
  const node = group.children.find((c) => c.matchName === matchName);
  return node?.kind === "property" ? node : undefined;
}

function numberAt(prop: Property | undefined, time: number, layer: Layer, fallback: number): number {
  if (!prop) return fallback;
  const v = currentValue(prop, time, layer);
  return typeof v === "number" ? v : Array.isArray(v) ? (v[0] ?? fallback) : fallback;
}

function enabledEffects(layer: Layer): PropertyGroup[] {
  if (!layer.effectsActive) return [];
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
  return (parade?.children ?? []).filter((e): e is PropertyGroup => e.kind === "group" && e.enabled);
}

/**
 * The comp times a time effect sees its layer at besides the frame's own (perspectiveTime.ts), from its parameters
 * (`value(n, fallback)` reads the one declared n-th) and the other layer its first layer parameter names (`target`:
 * absent for none, with null content when it draws nothing): none for any other effect, and for Time Difference with a
 * Target layer (that layer's content is planned at the offset time instead). Time Displacement reads the frame's own
 * time first when it has no map layer (the map), then every step of its grid, the one at the frame's time included.
 */
export function inputTimes(
  matchName: string,
  value: (index: number, fallback: number) => number,
  time: number,
  comp: CompItem,
  layer: Pick<Layer, "inPoint" | "outPoint">,
  target: PlanEffectSource | undefined,
): number[] {
  const fd = comp.frameDuration;
  switch (matchName) {
    case "ADBE Posterize Time": {
      const rate = Math.max(0.01, value(1, 24));
      const held = Math.floor(time * rate + 1e-6) / rate;
      return Math.abs(held - time) < 1e-9 ? [] : [held];
    }
    case "ADBE Echo": {
      const step = value(1, -1 / 30);
      const count = Math.max(0, Math.min(1000, Math.round(value(2, 1))));
      return Array.from({ length: count }, (_, k) => time + (k + 1) * step);
    }
    case "CC Wide Time": {
      const forward = Math.max(0, Math.round(value(1, 1)));
      const backward = Math.max(0, Math.round(value(2, 1)));
      const times: number[] = [];
      for (let k = -backward; k <= forward; k++) if (k) times.push(time + k * fd);
      return times;
    }
    case "CC Force Motion Blur": {
      const samples = Math.max(1, Math.round(value(1, 8)));
      const override = value(2, 1) !== 0;
      const angle = override ? value(3, 180) : comp.shutterAngle;
      const phase = override ? value(5, 0) : comp.shutterPhase;
      return Array.from({ length: samples }, (_, i) => time + ((phase + (angle * i) / samples) / 360) * fd);
    }
    case "ADBE Difference":
      return target ? [] : [time + value(2, 0)];
    case "ADBE Time Displacement": {
      const maximum = value(2, 1);
      const resolution = Math.max(0.01, value(3, 60));
      if ((target && !target.content) || !maximum) return [];
      const reach = Math.abs(maximum);
      const first = Math.floor((time - reach) * resolution + 1e-6);
      const last = Math.min(first + 1200, Math.floor((time + reach) * resolution + 1e-6));
      const times = target ? [] : [time];
      for (let i = first; i <= last; i++) times.push(Math.min(Math.max(i / resolution, layer.inPoint), layer.outPoint - fd));
      return times;
    }
  }
  return [];
}

/** The comp time a layer parameter's layer is planned at: Time Difference reads its Target at Time Offset later. */
function sourceTime(matchName: string, value: (index: number, fallback: number) => number, time: number): number {
  return matchName === "ADBE Difference" ? time + value(2, 0) : time;
}

/** The mask of `layer` a Path parameter names (1-based, among all its masks), at `time` (maskShape in audioSpectrum.ts). */
function maskPath(layer: Layer, index: number, time: number): PlanEffect["path"] {
  if (!(index > 0)) return undefined;
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Mask Parade");
  const masks = (parade?.children ?? []).filter((n): n is PropertyGroup => n.kind === "group" && !!n.mask);
  const mask = masks[index - 1];
  const prop = mask?.children.find((c) => c.matchName === "ADBE Mask Shape");
  const shape = prop?.kind === "property" ? currentValue(prop, time, layer) : null;
  if (!isShapeValue(shape)) return undefined;
  const vertices: number[] = [];
  shape.vertices.forEach((v, i) => {
    const inT = shape.inTangents[i] ?? [0, 0];
    const outT = shape.outTangents[i] ?? [0, 0];
    vertices.push(v[0], v[1], inT[0], inT[1], outT[0], outT[1]);
  });
  return { closed: shape.closed, vertices };
}

/**
 * The frame a file footage item shows at `sourceTime` seconds of footage time (the frame footageStore.frame reads):
 * undefined for files the engine does not decode.
 */
function footagePlan(item: FootageItem, sourceTime: number): FootagePlan | undefined {
  const source = item.mainSource;
  if (source.sourceType !== "FileSource") return undefined;
  let file = source.file;
  if (source.sequence) {
    const folder = file.replace(/[\\/][^\\/]*$/, "");
    file = `${folder}/${sequenceFrameName(source.sequence, source.sequence.startFrame + footageFrameIndex(item, sourceTime))}`;
  }
  let videoTime = -1;
  if (!source.sequence && NATIVE_VIDEO.test(file)) {
    // footageStore.videoFrame: the frame index over the file's native rate, else the item's, else 30.
    const rate = source.nativeFrameRate || item.frameRate || 30;
    videoTime = footageFrameIndex(item, sourceTime) / rate;
  } else if (!NATIVE_IMAGE.test(file)) return undefined;
  const alphaMode = source.alphaMode === AlphaMode.IGNORE ? 2 : source.alphaMode === AlphaMode.PREMULTIPLIED ? 1 : 0;
  const [r, g, b] = source.premulColor;
  return { kind: "footage", file, sourceWidth: item.width, sourceHeight: item.height, hasAlpha: source.hasAlpha, invertAlpha: source.invertAlpha, alphaMode, matte: [r, g, b], videoTime };
}

class Planner {
  readonly unsupported = new Set<string>();
  readonly warnings = new Set<string>();
  readonly images: PlanImage[] = [];
  private readonly project: Project;
  constructor(project: Project) {
    this.project = project;
  }

  comp(comp: CompItem, time: number, depth: number, scale: number): PlanComp {
    const plan: PlanComp = { width: scaledSize(comp.width, scale), height: scaledSize(comp.height, scale), layers: [] };
    if (depth > MAX_DEPTH) {
      this.warnings.add(`compositions nested deeper than ${MAX_DEPTH} levels were not rendered`);
      return plan;
    }
    const camera = comp.layers.some((l) => l.threeDLayer) ? cameraAt(comp, time) : undefined;
    for (const layer of drawOrder(comp, time, camera, anySolo(comp))) {
      const placed = this.placed(layer, comp, time, camera, depth, scale, layer.adjustmentLayer);
      if (!placed) continue;
      placed.blendMode = layer.blendingMode;
      placed.opacity = localTransform(layer, time).opacity / 100;
      const matteLayer = layer.trackMatteType !== NO_MATTE ? matteLayerOf(layer, comp) : undefined;
      if (matteLayer) {
        const mode = MATTE_MODES[layer.trackMatteType] ?? MatteMode.NONE;
        // A matte is used even when its own video is switched off, but only while it is in its time span.
        const matte = matteLayer && isActive(matteLayer, time) ? this.placed(matteLayer, comp, time, camera, depth, scale, false) : null;
        const opacity = matteLayer && matte ? localTransform(matteLayer, time).opacity / 100 : 1;
        if (mode !== MatteMode.NONE) placed.matte = { mode, opacity, layer: matte };
      }
      plan.layers.push(placed);
    }
    return plan;
  }

  /** The layer's content and masks with its placement; null when it draws nothing. */
  private placed(layer: Layer, comp: CompItem, time: number, camera: Camera | undefined, depth: number, scale: number, adjustment: boolean): PlanLayer | null {
    // An adjustment layer's effects run on the composite below it (placeAdjustment in renderer.ts), at the comp's scale.
    const enabled = enabledEffects(layer);
    const missing = enabled.filter((e) => !nativeEffect(e.matchName));
    for (const e of enabled) if (MISSING_PLUGINS[e.matchName]) this.warnings.add(`${MISSING_PLUGINS[e.matchName]} plugin is not installed; After Effects skips it`);
    if (missing.length) this.unsupported.add(`effects (${missing.map((e) => e.effectName ?? e.matchName).join(", ")} on "${layer.name}")`);
    else if (scale !== 1 && enabled.some((e) => !nativeEffect(e.matchName)!.scalable)) this.unsupported.add(`effects at a reduced resolution ("${layer.name}")`);
    const content = this.content(layer, time, depth, scale);
    if (!content) return null;
    let matrix: Mat4;
    let zoom = 0;
    if (layer.threeDLayer && camera) {
      // World -> camera space: R^T (p - eye).
      const view = camera.rotation.inverse().mul(Mat4.translation(-camera.position[0], -camera.position[1], -camera.position[2]));
      matrix = view.mul(worldMatrix(layer, comp, time));
      zoom = camera.zoom * scale;
    } else {
      let world = worldMatrix(layer, comp, time);
      const aspect = sourcePixelAspect(layer, comp, this.project);
      if (aspect !== 1) {
        // Non-square source pixels stretch the layer horizontally about its anchor point.
        const [ax, ay] = localTransform(layer, time).anchor;
        world = world.mul(Mat4.translation(ax, ay, 0).mul(Mat4.scale(aspect, 1, 1)).mul(Mat4.translation(-ax, -ay, 0)));
      }
      const toTarget = scale === 1 ? Mat4.translation(PAD, PAD, 0) : Mat4.translation(PAD, PAD, 0).mul(Mat4.scale(scale, scale, 1));
      matrix = toTarget.mul(world);
    }
    const effects = this.effects(layer, comp, time, depth);
    const placed: PlanLayer = {
      name: layer.name,
      adjustment,
      blendMode: 5212,
      opacity: 1,
      content,
      masks: this.masks(layer, time, content.scale),
      matrix: matrix.m.slice(),
      zoom,
      effects,
    };
    if (effects.length) {
      const kind = layer.layerType === "AVLayer" ? 0 : layer.layerType === "ShapeLayer" ? 1 : 2;
      placed.effectLayer = { time, startTime: layer.startTime, stretch: layer.stretch ? layer.stretch / 100 : 1, width: layer.width, height: layer.height, kind };
    }
    return placed;
  }

  /**
   * The layer's enabled effects the engine renders, with their parameters' values at `time` and the content of the
   * other layers their layer parameters name.
   */
  private effects(layer: Layer, comp: CompItem, time: number, depth: number, before?: PropertyGroup): PlanEffect[] {
    const planned: PlanEffect[] = [];
    for (const effect of enabledEffects(layer)) {
      if (effect === before) break;
      const native = nativeEffect(effect.matchName);
      if (!native || native.passThrough) continue;
      const params: PlanParam[] = [];
      const named: { index: number; layer: number }[] = [];
      for (const node of effect.children) {
        if (node.kind !== "property") continue;
        const v = currentValue(node, time, layer, effect.children);
        const value = typeof v === "number" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : null;
        if (!value) continue;
        const param: PlanParam = { matchName: node.matchName, value };
        if (node.options) param.menu = node.options.map((o) => o.startsWith("(-"));
        params.push(param);
        const index = declaredIndex(effect.matchName, node.matchName);
        if (node.controlType === LAYER_CONTROL && index) named.push({ index, layer: Math.round(value[0]) });
      }
      // As the effects read their parameters (Params.num): the fallback when absent or not finite.
      const valueOr = (index: number, fallback: number) => {
        const v = params.find((p) => declaredIndex(effect.matchName, p.matchName) === index)?.value[0];
        return v !== undefined && Number.isFinite(v) ? v : fallback;
      };
      const sources: PlanEffectSource[] = [];
      const at = sourceTime(effect.matchName, valueOr, time);
      for (const { index, layer: i } of named) {
        // As the effects' layer parameters read it: another layer of the comp by index, never the layer itself.
        const other = i > 0 ? comp.layers.find((l) => l.index === i && l !== layer) : undefined;
        if (!other) continue;
        const content = this.content(other, at, depth, 1);
        const kind = other.layerType === "AVLayer" ? 0 : other.layerType === "ShapeLayer" ? 1 : 2;
        sources.push(content ? { param: index, content, width: other.width, height: other.height, kind } : { param: index, content, width: 0, height: 0, kind: 0 });
      }
      const planned1: PlanEffect = sources.length ? { matchName: effect.matchName, params, sources } : { matchName: effect.matchName, params };
      const value = (index: number) => params.find((p) => declaredIndex(effect.matchName, p.matchName) === index)?.value[0] ?? 0;
      const audioParam = AUDIO_LAYER_PARAMS[effect.matchName];
      if (audioParam) {
        const index = value(audioParam);
        const heard = comp.layers.find((l) => l.index === index);
        if (heard) planned1.audio = this.audio(heard, time);
      }
      const pathParam = PATH_PARAMS[effect.matchName];
      const path = pathParam ? maskPath(layer, value(pathParam), time) : undefined;
      if (path) planned1.path = path;
      const times = inputTimes(effect.matchName, valueOr, time, comp, layer, sources.find((src) => src.param === 1));
      if (times.length) planned1.inputs = times.map((t) => this.input(layer, comp, t, depth, effect));
      const data = (DATA_PARAMS[effect.matchName] ?? []).flatMap((param) => {
        const bytes = instanceData(effect, param);
        return bytes ? [{ param, bytes }] : [];
      });
      if (data.length) planned1.data = data;
      planned.push(planned1);
    }
    return planned;
  }

  /** The layer as `effect` receives it at comp time `t` (see PlanEffectInput). */
  private input(layer: Layer, comp: CompItem, t: number, depth: number, effect: PropertyGroup): PlanEffectInput {
    const content = this.content(layer, t, depth, 1);
    if (!content) return { time: t, content: null, masks: [], effects: [] };
    return { time: t, content, masks: this.masks(layer, t, content.scale), effects: this.effects(layer, comp, t, depth, effect) };
  }

  /**
   * The sound files `layer` is heard from around comp time `time` (layerAudio in src/media/mix.ts): its footage, or a
   * precomp's audio-enabled layers (each heard between its in and out points), shifted by start times and stretch.
   */
  private audio(layer: Layer, time: number): PlanAudioSource[] {
    const heard: PlanAudioSource[] = [];
    const visit = (l: Layer, scale: number, offset: number, from: number, to: number, depth: number) => {
      if (depth > MAX_AUDIO_DEPTH || !scale) return;
      if (depth > 0) {
        const lo = Math.min(l.inPoint, l.outPoint);
        const hi = Math.max(l.inPoint, l.outPoint);
        from = Math.max(from, scale > 0 ? (lo - offset) / scale : (hi - offset) / scale);
        to = Math.min(to, scale > 0 ? (hi - offset) / scale : (lo - offset) / scale);
        if (from >= to) return;
      }
      const stretch = l.stretch ? l.stretch / 100 : 1;
      let innerScale = scale / stretch;
      let innerOffset = (offset - l.startTime) / stretch;
      if (l.timeRemapEnabled) {
        const remap = findProperty(l.properties, ["ADBE Time Remapping"]);
        const value = remap ? valueAtTime(remap, scale * time + offset, l) : null;
        if (typeof value === "number") {
          innerScale = scale;
          innerOffset = value - scale * time;
        }
      }
      const source = this.project.items.get(l.sourceId);
      if (source?.kind === "comp") {
        for (const child of source.layers) if (child.audioEnabled) visit(child, innerScale, innerOffset, from, to, depth + 1);
      } else if (source?.kind === "footage" && source.hasAudio && source.mainSource.sourceType === "FileSource") {
        heard.push({ file: source.mainSource.file, scale: innerScale, offset: innerOffset, from, to });
      }
    };
    visit(layer, 1, 0, -Infinity, Infinity, 0);
    return heard;
  }

  private content(layer: Layer, time: number, depth: number, scale: number): PlanContent | null {
    const source = layer.sourceId ? this.project.items.get(layer.sourceId) : undefined;
    if (layer.layerType === "ShapeLayer") {
      const shape = planShapeLayer(layer, time, scale, PAD);
      if (!shape) return null;
      if (shape.dashed) this.unsupported.add(`dashed strokes ("${layer.name}")`);
      return { kind: "shape", width: shape.width, height: shape.height, origin: shape.origin, scale, paints: shape.paints };
    }
    if (layer.layerType !== "AVLayer") {
      this.unsupported.add(`text layers ("${layer.name}")`);
      return null;
    }
    if (source?.kind === "footage" && source.mainSource.sourceType === "SolidSource") {
      const [r, g, b] = source.mainSource.color;
      return { kind: "solid", width: scaledSize(source.width, scale), height: scaledSize(source.height, scale), origin: [0, 0], scale, color: [r, g, b] };
    }
    if (source?.kind === "comp") {
      let sourceTime = layerTimeAt(layer, time);
      if (layer.timeRemapEnabled) {
        const remap = findProperty(layer.properties, ["ADBE Time Remapping"]);
        const value = remap ? currentValue(remap, time, layer) : null;
        if (typeof value === "number") sourceTime = value;
      }
      const comp = this.comp(source, sourceTime, depth + 1, scale);
      return { kind: "comp", width: comp.width, height: comp.height, origin: [0, 0], scale, comp };
    }
    if (source?.kind === "footage") {
      // As the WebGL renderer: a placeholder and footage without video (audio) draw nothing.
      if (source.mainSource.sourceType === "PlaceholderSource") this.warnings.add(`placeholder "${source.name}" has no footage; After Effects refuses to render it`);
      else if (source.hasVideo) {
        const footage = footagePlan(source, layerSourceTime(layer, time));
        if (footage) {
          const reduced = scale < 1;
          const size = (side: number) => (reduced ? Math.max(1, Math.ceil(side * scale - 1e-6)) : side);
          return { ...footage, width: size(footage.sourceWidth), height: size(footage.sourceHeight), origin: [0, 0], scale: reduced ? scale : 1 };
        }
        this.unsupported.add(`footage ("${source.name}")`);
      }
    }
    return null;
  }

  private masks(layer: Layer, time: number, scale: number): PlanMask[] {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Mask Parade");
    const masks = (parade?.children ?? []).filter(
      (n): n is PropertyGroup => n.kind === "group" && !!n.mask && n.enabled && n.mask.maskMode !== MASK_NONE,
    );
    return masks.map((mask) => {
      const shapeProp = child(mask, "ADBE Mask Shape");
      const shape = shapeProp ? currentValue(shapeProp, time, layer) : null;
      const featherProp = child(mask, "ADBE Mask Feather");
      const featherValue = featherProp ? currentValue(featherProp, time, layer) : null;
      const vertices: number[] = [];
      let closed = false;
      if (isShapeValue(shape)) {
        closed = shape.closed;
        shape.vertices.forEach((v, i) => {
          const inT = shape.inTangents[i] ?? [0, 0];
          const outT = shape.outTangents[i] ?? [0, 0];
          vertices.push(v[0], v[1], inT[0], inT[1], outT[0], outT[1]);
        });
      }
      return {
        mode: mask.mask!.maskMode,
        inverted: mask.mask!.inverted,
        opacity: numberAt(child(mask, "ADBE Mask Opacity"), time, layer, 100) / 100,
        feather: (Array.isArray(featherValue) ? Math.max(featherValue[0] ?? 0, featherValue[1] ?? 0) : 0) * scale,
        expansion: numberAt(child(mask, "ADBE Mask Offset"), time, layer, 0),
        closed,
        vertices,
      };
    });
  }
}

/** The plan of `comp` at composition time `time` (see FramePlan). */
export function buildFramePlan(project: Project, comp: CompItem, time: number, options: PlanOptions = {}): FramePlan {
  const planner = new Planner(project);
  setExpressionScope({ project, warn: (message) => planner.warnings.add(message) });
  const root = planner.comp(comp, time, 0, options.scale ?? 1);
  return { root, images: planner.images, unsupported: [...planner.unsupported], warnings: [...planner.warnings] };
}
