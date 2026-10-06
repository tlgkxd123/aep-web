// The sound of a layer as an effect parameter sees it: a footage layer's audio,
// or a precomp's mix of its audio-enabled layers (each heard between its in and
// out points), shifted by start times. The layer itself is heard untrimmed, and
// on its source's own time axis: a stretched layer is read at the source's pitch
// (After Effects analyses Duration / stretch of source audio).
import { valueAtTime } from "../aep/evaluate.ts";
import type { Layer, Project } from "../aep/model.ts";
import type { AudioData } from "./audio.ts";
import { footageStore } from "./store.ts";

/** One decoded source heard in the mix: source seconds = scale · t + offset, for t in [from, to). */
interface Contribution {
  audio: AudioData;
  scale: number;
  offset: number;
  from: number;
  to: number;
}

export interface LayerAudio {
  /** Rate of the first source, in samples per second of its own time. */
  rate: number;
  /** Source seconds per layer second of the first source; windows hold rate · timeScale samples per layer second. */
  timeScale: number;
  contributions: Contribution[];
}

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
    } else if (source?.kind === "footage" && source.hasAudio) {
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

/**
 * `length` samples of the mono mix starting at sample `first` of the layer's
 * timeline, which has rate · timeScale samples per layer second. `channel`
 * (0 left, 1 right) picks one channel of stereo sources instead of their mean.
 */
export function mixWindow(audio: LayerAudio, first: number, length: number, channel?: number): Float32Array {
  const out = new Float32Array(length);
  const perSecond = audio.rate * audio.timeScale;
  for (const c of audio.contributions) {
    const rate = c.audio.sampleRate;
    const count = c.audio.numberOfChannels;
    const picked = channel !== undefined && count > 1 ? [Math.min(channel, count - 1)] : Array.from({ length: count }, (_, i) => i);
    const channels = picked.map((i) => c.audio.getChannelData(i));
    const gain = 1 / channels.length;
    const end = c.audio.length;
    // Source sample position of window sample i: p0 + i · step.
    const step = (c.scale * rate) / perSecond;
    const p0 = (c.scale * (first / perSecond) + c.offset) * rate;
    const whole = Math.abs(step - 1) < 1e-9 && Math.abs(p0 - Math.round(p0)) < 1e-6;
    const i0 = Math.max(0, Math.ceil(c.from * perSecond - first - 1e-9));
    const i1 = Math.min(length, Math.ceil(c.to * perSecond - first - 1e-9));
    for (let i = i0; i < i1; i++) {
      let sum = 0;
      if (whole) {
        const p = Math.round(p0) + i;
        if (p < 0 || p >= end) continue;
        for (const data of channels) sum += data[p];
      } else {
        const p = p0 + i * step;
        const k = Math.floor(p);
        if (k < 0 || k + 1 >= end) continue;
        const f = p - k;
        for (const data of channels) sum += data[k] + (data[k + 1] - data[k]) * f;
      }
      out[i] += sum * gain;
    }
  }
  return out;
}
