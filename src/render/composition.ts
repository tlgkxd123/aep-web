// What a comp draws at a time, as both compositors see it (the WebGL renderer and the native render plan,
// src/native/plan.ts): the layers it composites in order, their track mattes, and image sizes at reduced resolutions.
import type { CompItem, Layer } from "../aep/model.ts";
import { localTransform, worldMatrix, type Camera } from "../aep/transform.ts";
import { MatteMode } from "./shaders.ts";

/** Width of the transparent border around every image. */
export const PAD = 1;
export const NO_MATTE = 5012;
export const MATTE_MODES: Record<number, number> = {
  5013: MatteMode.ALPHA,
  5014: MatteMode.ALPHA_INVERTED,
  5015: MatteMode.LUMA,
  5016: MatteMode.LUMA_INVERTED,
};
/** Comps nested deeper than this render empty. */
export const MAX_DEPTH = 16;

/** Pixels of a comp dimension rendered at `scale` (1/3 of 1920 is 640, not 641). */
export function scaledSize(size: number, scale: number): number {
  return scale === 1 ? size : Math.max(1, Math.ceil(size * scale - 1e-6));
}

export function isRenderable(layer: Layer): boolean {
  return layer.layerType === "AVLayer" || layer.layerType === "ShapeLayer" || layer.layerType === "TextLayer";
}

export function isActive(layer: Layer, time: number): boolean {
  // A time-reversed layer (negative stretch) has its in point after its out point.
  return time >= Math.min(layer.inPoint, layer.outPoint) && time < Math.max(layer.inPoint, layer.outPoint);
}

export function matteLayerOf(layer: Layer, comp: CompItem): Layer | undefined {
  if (layer.trackMatteLayerId) return comp.layers.find((l) => l.id === layer.trackMatteLayerId);
  return comp.layers[layer.index - 2];
}

/** Whether a solo switch limits what `comp` shows. */
export function anySolo(comp: CompItem): boolean {
  return comp.layers.some((l) => l.solo && isRenderable(l));
}

/** Layers to composite, bottom first; runs of adjacent 3D layers are sorted back to front. */
export function drawOrder(comp: CompItem, time: number, camera: Camera | undefined, solo: boolean): Layer[] {
  const candidates = [...comp.layers]
    .reverse()
    .filter((l) => isRenderable(l) && l.enabled && (!solo || l.solo) && !l.nullLayer && !l.guideLayer && isActive(l, time));
  if (!camera) return candidates;
  const viewInverse = camera.rotation.inverse();
  const depthOf = (layer: Layer) => {
    const t = localTransform(layer, time);
    const world = worldMatrix(layer, comp, time).transformPoint(t.anchor);
    return viewInverse.transformVector([world[0] - camera.position[0], world[1] - camera.position[1], world[2] - camera.position[2]])[2];
  };
  const result: Layer[] = [];
  let run: { layer: Layer; depth: number }[] = [];
  const flush = () => {
    // Back to front; ties keep stack order (lower layers first).
    run.sort((a, b) => b.depth - a.depth);
    result.push(...run.map((r) => r.layer));
    run = [];
  };
  for (const layer of candidates) {
    if (layer.threeDLayer) run.push({ layer, depth: depthOf(layer) });
    else {
      flush();
      result.push(layer);
    }
  }
  flush();
  return result;
}
