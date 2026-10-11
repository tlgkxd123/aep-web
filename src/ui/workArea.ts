// Work area edits: B and N (or their buttons) at the current time, and drags of the Timeline's work area bar.
import type { CompItem } from "../aep/model.ts";

export type WorkAreaPart = "start" | "end" | "move";

const frameOf = (comp: CompItem) => comp.frameDuration || 1 / (comp.frameRate || 24);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The work area [start, end) in comp seconds, inside the comp. */
export function workAreaOf(comp: CompItem): [number, number] {
  const start = comp.workAreaStart;
  return [start, Math.min(comp.duration, start + comp.workAreaDuration)];
}

/**
 * The work area after B (`end` false: it starts at `time`) or N (`end` true: it ends after the frame at `time`). An
 * end that would fall before the new start resets to the comp's end, and a start after the new end to 0, as in AE.
 */
export function workAreaAtTime(comp: CompItem, time: number, end: boolean): [number, number] {
  const frame = frameOf(comp);
  const [start, stop] = workAreaOf(comp);
  return end ? [start < time + frame ? start : 0, Math.min(comp.duration, time + frame)] : [time, stop > time ? stop : comp.duration];
}

/**
 * The work area `from` with `part` dragged by `delta` seconds: an end moves on its own, the bar moves whole. Times
 * snap to frames; the area stays inside the comp and at least a frame long.
 */
export function dragWorkArea(comp: CompItem, from: [number, number], part: WorkAreaPart, delta: number): [number, number] {
  const frame = frameOf(comp);
  const d = Math.round(delta / frame) * frame;
  const [start, end] = from;
  if (part === "start") return [clamp(start + d, 0, end - frame), end];
  if (part === "end") return [start, clamp(end + d, start + frame, comp.duration)];
  const s = clamp(start + d, 0, Math.max(0, comp.duration - (end - start)));
  return [s, s + (end - start)];
}

/** The work area after setting its start (B) or its end (N) at comp time `t`. */
export function workAreaAt(comp: CompItem, t: number, edge: "start" | "end"): [number, number] {
  return workAreaAtTime(comp, t, edge === "end");
}
