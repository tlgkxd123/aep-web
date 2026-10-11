// Keys telling apart what a layer draws at different times, so the renderer can reuse a layer's image from one
// frame to the next. Within one project model the only inputs that change with time are the values of keyframed
// or expression-driven properties, the frame of footage a layer shows and, for a nested comp, which of its layers
// are active; an edit makes a new model and the renderer drops its caches with the old one. A key is built from
// exactly those inputs, so two times with equal keys render the same image.
//
// Anything a key cannot see makes it null and the layer is rendered every frame: an effect not registered as
// cacheable (one reading the time itself, audio or other layers), text and other layers drawn by providers that
// keys do not know, and nested comps with 3D layers.
import { currentValue, layerTimeAt } from "../aep/evaluate.ts";
import type { CompItem, FootageItem, Layer, Project, Property, PropertyGroup, PropertyNode } from "../aep/model.ts";
import { footageFrameIndex, layerSourceTime } from "./footage.ts";
import { effectIsCacheable, effectRenderer } from "./registry.ts";

/** What the renderer decides about a comp at a time, which keys follow. */
export interface KeyHost {
  readonly project: Project;
  /** Layers the comp draws at `time`, bottom first; null when keys cannot follow its drawing (3D layers). */
  drawOrder(comp: CompItem, time: number): Layer[] | null;
  matteLayerOf(layer: Layer, comp: CompItem): Layer | undefined;
  isActive(layer: Layer, time: number): boolean;
}

interface Leaf {
  prop: Property;
  siblings: PropertyNode[];
}

const NO_MATTE = 5012;
/** Nesting the footage walk follows at most (the renderer draws 16 levels). */
const MAX_FOOTAGE_DEPTH = 16;

function group(layer: Layer, matchName: string): PropertyGroup | undefined {
  return layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === matchName);
}

function stringify(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) return value.join(",");
  return JSON.stringify(value);
}

export class LayerKeys {
  private readonly host: KeyHost;
  /** The properties that can change over time under each property list. */
  private readonly leaves = new WeakMap<readonly PropertyNode[], Leaf[]>();
  private readonly images = new Map<Layer, Map<number, string | null>>();
  private readonly coverages = new Map<Layer, Map<number, string | null>>();
  private readonly comps = new Map<CompItem, Map<number, string | null>>();
  private readonly placements = new Map<Layer, Map<number, string>>();

  constructor(host: KeyHost) {
    this.host = host;
  }

  /** Forgets the keys of the last frame; call before each frame (expressions may give other values). */
  newFrame(): void {
    this.images.clear();
    this.coverages.clear();
    this.comps.clear();
    this.placements.clear();
  }

  /**
   * The layer's image in its own space: its content, after its masks and, with `effects`, its effects (adjustment
   * layers key their content and masks alone: their effects run on the comp below them). Null when that cannot be
   * told from values (see the file comment).
   */
  image(layer: Layer, time: number, effects = true): string | null {
    return memo(effects ? this.images : this.coverages, layer, time, () => {
      const content = this.content(layer, time);
      if (content === null) return null;
      const masks = group(layer, "ADBE Mask Parade");
      let key = `${content}|${masks ? this.values(masks.children, layer, time) : ""}`;
      const parade = group(layer, "ADBE Effect Parade");
      if (!effects || !layer.effectsActive || !parade) return key;
      for (const effect of parade.children) {
        // Effects without a renderer are skipped whatever their values.
        if (effect.kind !== "group" || !effect.enabled || !effectRenderer(effect.matchName)) continue;
        if (!effectIsCacheable(effect.matchName)) return null;
        key += `|${effect.matchName}{${this.values(effect.children, layer, time)}}`;
      }
      return key;
    });
  }

  /** What `comp` renders at `time`: the layers it draws, each with its image, placement and matte. */
  comp(comp: CompItem, time: number): string | null {
    return memo(this.comps, comp, time, () => {
      const parts = this.parts(comp, time);
      return parts && !parts.includes(null) ? parts.join(";") : null;
    });
  }

  /**
   * What each layer `comp` draws at `time` adds to it, in drawing order (the renderer's drawOrder): its image,
   * placement and matte; an adjustment layer's effects included, as they change the comp below it. Null for a
   * layer that cannot be keyed; null for the whole comp when its drawing cannot be followed (3D layers).
   */
  parts(comp: CompItem, time: number): (string | null)[] | null {
    const order = this.host.drawOrder(comp, time);
    if (!order) return null;
    return order.map((layer) => {
      const image = this.image(layer, time);
      if (image === null) return null;
      let part = `${layer.id}:${image}@${this.placement(layer, comp, time)}`;
      if (layer.trackMatteType !== NO_MATTE) {
        const matte = this.host.matteLayerOf(layer, comp);
        if (matte && this.host.isActive(matte, time)) {
          const matteImage = this.image(matte, time);
          if (matteImage === null) return null;
          part += `~${matteImage}@${this.placement(matte, comp, time)}`;
        }
      }
      return part;
    });
  }

  /** The values a layer's place in its comp follows: its transform and its parents', opacity included. */
  placement(layer: Layer, comp: CompItem, time: number): string {
    return memo(this.placements, layer, time, () => {
      let key = "";
      for (let current: Layer | undefined = layer; current; current = current.parentId ? comp.layers.find((l) => l.id === current!.parentId) : undefined) {
        const transform = group(current, "ADBE Transform Group");
        key += `/${transform ? this.values(transform.children, current, time) : ""}`;
      }
      return key;
    });
  }

  /**
   * Calls `visit` with each file footage item `comp` shows at `time` (nested comps included, at their own times)
   * and the frame of it the footage provider reads, without rendering.
   */
  footage(comp: CompItem, time: number, visit: (item: FootageItem, frame: number) => void, depth = 0): void {
    if (depth > MAX_FOOTAGE_DEPTH) return;
    const seen = new Set<Layer>();
    for (const layer of comp.layers) {
      if (!layer.enabled || !this.host.isActive(layer, time)) continue;
      seen.add(layer);
      if (layer.trackMatteType !== NO_MATTE) {
        const matte = this.host.matteLayerOf(layer, comp);
        if (matte && this.host.isActive(matte, time)) seen.add(matte);
      }
    }
    for (const layer of seen) {
      if (layer.layerType !== "AVLayer") continue;
      const source = layer.sourceId ? this.host.project.items.get(layer.sourceId) : undefined;
      if (source?.kind === "comp") this.footage(source, this.sourceTime(layer, time), visit, depth + 1);
      else if (source?.kind === "footage" && source.mainSource.sourceType === "FileSource" && source.hasVideo) {
        visit(source, footageFrameIndex(source, layerSourceTime(layer, time)));
      }
    }
  }

  /** The time of a nested comp's own timeline that a precomp layer shows at `time`. */
  private sourceTime(layer: Layer, time: number): number {
    if (layer.timeRemapEnabled) {
      const remap = layer.properties.find((n): n is Property => n.kind === "property" && n.matchName === "ADBE Time Remapping");
      const value = remap ? currentValue(remap, time, layer) : null;
      if (typeof value === "number") return value;
    }
    return layerTimeAt(layer, time);
  }

  /** What the layer's source draws at `time`, as the renderer's layerContent and the footage provider read it. */
  private content(layer: Layer, time: number): string | null {
    if (layer.layerType === "ShapeLayer") {
      const root = group(layer, "ADBE Root Vectors Group");
      return `shape:${root ? this.values(root.children, layer, time) : ""}`;
    }
    if (layer.layerType !== "AVLayer") return null;
    const source = layer.sourceId ? this.host.project.items.get(layer.sourceId) : undefined;
    if (!source) return "none";
    if (source.kind === "comp") {
      const nested = this.comp(source, this.sourceTime(layer, time));
      return nested === null ? null : `comp(${nested})`;
    }
    if (source.kind !== "footage") return null;
    if (source.mainSource.sourceType !== "FileSource") return source.mainSource.sourceType;
    return `frame:${footageFrameIndex(source, layerSourceTime(layer, time))}`;
  }

  /** The values at `time` of the properties under `nodes` that can change over time. */
  private values(nodes: readonly PropertyNode[], layer: Layer, time: number): string {
    let leaves = this.leaves.get(nodes);
    if (!leaves) {
      leaves = [];
      collectLeaves(nodes, leaves);
      this.leaves.set(nodes, leaves);
    }
    return leaves.map((leaf) => stringify(currentValue(leaf.prop, time, layer, leaf.siblings))).join(";");
  }
}

function collectLeaves(nodes: readonly PropertyNode[], out: Leaf[]): void {
  for (const node of nodes) {
    if (node.kind === "group") collectLeaves(node.children, out);
    else if (node.keyframes.length || (node.expressionEnabled && node.expression)) out.push({ prop: node, siblings: nodes as PropertyNode[] });
  }
}

function memo<K, V>(cache: Map<K, Map<number, V>>, key: K, time: number, make: () => V): V {
  let byTime = cache.get(key);
  if (!byTime) cache.set(key, (byTime = new Map()));
  if (byTime.has(time)) return byTime.get(time)!;
  const value = make();
  byTime.set(time, value);
  return value;
}
