// Plays a composition's audio during preview, in sync with the playhead.
//
// Every audible footage layer is found through nested compositions; its source
// time is an affine function of the previewed comp's time (start times and
// stretches compose), so each one becomes a Web Audio buffer source started at
// the right offset and playback rate, with the layer's Audio Levels as gain.
import { valueAtTime } from "../aep/evaluate.ts";
import type { CompItem, FootageItem, Layer, Project, Property, PropertyGroup } from "../aep/model.ts";
import { footageStore } from "./store.ts";

interface AudioLeaf {
  item: FootageItem;
  layer: Layer;
  /** Source time = a * compTime + b. */
  a: number;
  b: number;
  /** Comp-time span in which the layer is heard. */
  from: number;
  to: number;
}

const MAX_DEPTH = 16;

function audioLevelsDb(layer: Layer, time: number): number {
  const group = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Audio Group");
  const levels = group?.children.find((n): n is Property => n.kind === "property" && n.matchName === "ADBE Audio Levels");
  const value = levels ? valueAtTime(levels, time, layer) : null;
  if (Array.isArray(value)) return ((value[0] ?? 0) + (value[1] ?? 0)) / 2;
  return typeof value === "number" ? value : 0;
}

/** Audible footage layers of `comp`, with inner time = a * t + b for the outer time t, heard during [from, to). */
function collect(project: Project, comp: CompItem, a: number, b: number, from: number, to: number, out: AudioLeaf[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  const anySolo = comp.layers.some((l) => l.solo);
  for (const layer of comp.layers) {
    if (!layer.audioEnabled || (anySolo && !layer.solo)) continue;
    const stretch = layer.stretch ? layer.stretch / 100 : 1;
    // Reversed layers play audio backwards, which buffer sources cannot.
    if (stretch <= 0) continue;
    const source = project.items.get(layer.sourceId);
    // The layer's span in this comp's time, mapped back to the outer time.
    const lo = Math.max(from, (Math.min(layer.inPoint, layer.outPoint) - b) / a);
    const hi = Math.min(to, (Math.max(layer.inPoint, layer.outPoint) - b) / a);
    if (hi <= lo) continue;
    const la = a / stretch;
    const lb = (b - layer.startTime) / stretch;
    if (source?.kind === "footage" && source.hasAudio && source.mainSource.sourceType === "FileSource") {
      out.push({ item: source, layer, a: la, b: lb, from: lo, to: hi });
    } else if (source?.kind === "comp" && !layer.timeRemapEnabled) {
      collect(project, source, la, lb, lo, hi, out, depth + 1);
    }
  }
}

export class AudioPreview {
  private context: AudioContext | undefined;
  private readonly buffers = new Map<FootageItem, Promise<AudioBuffer | null>>();
  private nodes: AudioScheduledSourceNode[] = [];
  private session = 0;

  private audioContext(): AudioContext {
    this.context ??= new AudioContext({ latencyHint: "interactive" });
    if (this.context.state === "suspended") void this.context.resume();
    return this.context;
  }

  private buffer(item: FootageItem): Promise<AudioBuffer | null> {
    let pending = this.buffers.get(item);
    if (!pending) {
      const source = item.mainSource;
      const blob = source.sourceType === "FileSource" ? footageStore.locate(source.file) : undefined;
      if (!blob) return Promise.resolve(null);
      pending = blob
        .arrayBuffer()
        .then((bytes) => this.audioContext().decodeAudioData(bytes))
        .catch(() => null);
      this.buffers.set(item, pending);
    }
    return pending;
  }

  /** Decodes the audio a comp will need, so playback can start without waiting. */
  prepare(project: Project, comp: CompItem): void {
    const leaves: AudioLeaf[] = [];
    collect(project, comp, 1, 0, 0, comp.duration, leaves, 0);
    for (const leaf of leaves) void this.buffer(leaf.item);
  }

  /**
   * Starts playing `comp`'s audio from comp time `from` until `to`, as if the
   * playhead started moving now. Audio that is still decoding joins in when ready.
   */
  play(project: Project, comp: CompItem, from: number, to: number): void {
    this.stop();
    if (typeof AudioContext === "undefined") return;
    const session = this.session;
    const context = this.audioContext();
    const startedAt = context.currentTime;
    const leaves: AudioLeaf[] = [];
    collect(project, comp, 1, 0, from, to, leaves, 0);
    for (const leaf of leaves) {
      void this.buffer(leaf.item).then((buffer) => {
        if (!buffer || session !== this.session) return;
        // Comp time now, accounting for the time spent decoding.
        const now = from + (context.currentTime - startedAt);
        // First comp time at which the leaf is heard: inside its span and not before its source starts.
        const begin = Math.max(leaf.from, now, -leaf.b / leaf.a);
        if (begin >= leaf.to) return;
        const offset = leaf.a * begin + leaf.b;
        const delay = begin - now;
        const duration = (leaf.to - begin) * leaf.a;
        if (offset >= buffer.duration || duration <= 0) return;
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.playbackRate.value = leaf.a;
        const gain = context.createGain();
        gain.gain.value = 10 ** (audioLevelsDb(leaf.layer, begin) / 20);
        node.connect(gain).connect(context.destination);
        node.start(context.currentTime + Math.max(0, delay), offset, Math.min(duration, buffer.duration - offset));
        this.nodes.push(node);
      });
    }
  }

  stop(): void {
    this.session++;
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        // Already finished.
      }
    }
    this.nodes = [];
  }

  /** Forgets decoded audio (another project was opened). */
  reset(): void {
    this.stop();
    this.buffers.clear();
  }
}

export const audioPreview = new AudioPreview();
