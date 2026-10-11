import type { CompItem } from "../aep/model.ts";

/**
 * The work area after setting its start (B) or its end (N) at comp time `t`, as AE does: the start at the current
 * frame, the end after it; the other edge stays unless that would leave the area empty.
 */
export function workAreaAt(comp: CompItem, t: number, edge: "start" | "end"): [number, number] {
  const frame = comp.frameDuration || 1 / (comp.frameRate || 24);
  const start = comp.workAreaStart;
  const end = start + comp.workAreaDuration;
  return edge === "start" ? [t, end > t ? end : comp.duration] : [start < t + frame ? start : 0, Math.min(comp.duration, t + frame)];
}
