import type { CompItem } from "../aep/model.ts";

export function frameDuration(comp: CompItem): number {
  return comp.frameDuration || 1 / (comp.frameRate || 24);
}

export function frameIndex(comp: CompItem, time: number): number {
  return Math.round(time / frameDuration(comp));
}
