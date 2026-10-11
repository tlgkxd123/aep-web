// The sound of a layer as an effect parameter sees it: a footage layer's audio,
// or a precomp's mix of its audio-enabled layers (each heard between its in and
// out points), shifted by start times. The layer itself is heard untrimmed, and
// on its source's own time axis: a stretched layer is read at the source's pitch
// (After Effects analyses Duration / stretch of source audio).
import { valueAtTime } from "../aep/evaluate.ts";
import type { Layer, Project } from "../aep/model.ts";
import type { Contribution, LayerAudio } from "./mixWindow.ts";
import { footageStore } from "./store.ts";

export { mixWindow, type LayerAudio } from "./mixWindow.ts";

const MAX_DEPTH = 16;

/**
 * The audio sources of `layer` (times in its comp's seconds), around comp time
 * `time`. "pending" while a source is decoding; null when the layer has no sound.
 */
export function layerAudio(project: Project, layer: Layer, time: number): LayerAudio | "pending" | null {
  const contributions: Contribution[] = [];
  let pending = false;
  const visit = (l: Layer, scale: number, offset: number, from: number, to: number, depth: number) => {
    if (depth > MAX_DEPTH || !scale) return;
    if (depth > 0) {
      // [in, out) in the layer's comp time, mapped back to top-level time.
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
      // Remapped time is followed as a shift that is exact at `time`.
      const remap = l.properties.find((n) => n.matchName === "ADBE Time Remapping");
      const value = remap?.kind === "property" ? valueAtTime(remap, scale * time + offset, l) : null;
      if (typeof value === "number") {
        innerScale = scale;
        innerOffset = value - scale * time;
      }
    }
    const source = project.items.get(l.sourceId);
    if (source?.kind === "comp") {
      for (const child of source.layers) {
        if (child.audioEnabled) visit(child, innerScale, innerOffset, from, to, depth + 1);
      }
    } else if (source?.kind === "footage") {
      const sound = footageStore.hasAudio(source);
      if (sound === "pending") pending = true;
      if (sound !== true) return;
      const state = footageStore.audio(source);
      if (state.status === "ready") contributions.push({ audio: state.audio, scale: innerScale, offset: innerOffset, from, to });
      else if (state.status === "pending") pending = true;
    }
  };
  visit(layer, 1, 0, -Infinity, Infinity, 0);
  if (pending) return "pending";
  if (!contributions.length) return null;
  return { rate: contributions[0].audio.sampleRate, timeScale: Math.abs(contributions[0].scale), contributions };
}
