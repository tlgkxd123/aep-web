// A frame as the native Vulkan engine (native/) renders it: what the WebGL renderer (src/render/renderer.ts) would
// draw, with every value already evaluated (keyframes, expressions, parenting, cameras). The engine composites the
// plan on the GPU; the plan holds no pixels of its own beyond the images it lists.
//
// Images are in their own pixels, y down, with the renderer's 1 px transparent border (PAD) around them. A plan the
// engine cannot render faithfully lists why in `unsupported`; the frame is then left to the WebGL renderer.
import { currentValue, layerTimeAt, setExpressionScope } from "../aep/evaluate.ts";
import { isShapeValue, type CompItem, type Layer, type Project, type Property, type PropertyGroup, type PropertyNode } from "../aep/model.ts";
import { cameraAt, localTransform, Mat4, worldMatrix, type Camera } from "../aep/transform.ts";
import { anySolo, drawOrder, isActive, MATTE_MODES, matteLayerOf, MAX_DEPTH, NO_MATTE, PAD, scaledSize } from "../render/composition.ts";
import { sourcePixelAspect } from "../render/footage.ts";
import { MatteMode } from "../render/shaders.ts";
import { planShapeLayer, type ShapePaintPlan } from "../render/shapes.ts";

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
  | (ContentBase & { kind: "shape"; paints: ShapePaintPlan[] });

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
      if (layer.adjustmentLayer && enabledEffects(layer).length) this.unsupported.add(`adjustment layer effects ("${layer.name}")`);
      placed.blendMode = layer.blendingMode;
      placed.opacity = localTransform(layer, time).opacity / 100;
      if (layer.trackMatteType !== NO_MATTE) {
        const matteLayer = matteLayerOf(layer, comp);
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
    if (!adjustment) {
      const effects = enabledEffects(layer);
      if (effects.length) this.unsupported.add(`effects (${effects.map((e) => e.effectName ?? e.matchName).join(", ")} on "${layer.name}")`);
    }
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
    return {
      name: layer.name,
      adjustment,
      blendMode: 5212,
      opacity: 1,
      content,
      masks: this.masks(layer, time, content.scale),
      matrix: matrix.m.slice(),
      zoom,
    };
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
    if (source?.kind === "footage") this.unsupported.add(`footage ("${source.name}")`);
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
