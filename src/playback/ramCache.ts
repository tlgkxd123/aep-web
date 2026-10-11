import type { Project } from "../aep/model.ts";
import { deviceBudgets } from "../device.ts";
import type { Renderer } from "../render/renderer.ts";
import { FrameCache } from "./frameCache.ts";

/** The RAM preview cache shared by every viewer: rendered frames as ImageBitmaps, within the device's budget. */
export const ramCache = new FrameCache<ImageBitmap>(deviceBudgets().ramPreview, (bitmap) => bitmap.close());

/** Cache view of a comp at a resolution divisor (1 Full ... 4 Quarter). */
export function cacheView(compId: number, factor: number): string {
  return `${compId}@${factor}`;
}

const renderers = new Set<Renderer>();
let attached: Project | null = null;
let generation = 0;
const invalidationListeners = new Set<() => void>();

/** Increments on every invalidation: a frame shown under an older generation is stale. */
export function contentGeneration(): number {
  return generation;
}

export function onInvalidate(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

function invalidated(): void {
  generation++;
  for (const l of invalidationListeners) l();
}

/** Viewer renderers register so that `invalidate` also drops their content caches. */
export function registerRenderer(renderer: Renderer): () => void {
  renderers.add(renderer);
  return () => renderers.delete(renderer);
}

/** The viewers' renderers, as registered. */
export function viewerRenderers(): Iterable<Renderer> {
  return renderers;
}

/** Comp ids whose frames depend on `compId`: itself and every comp that nests it, directly or not. */
function dependents(project: Project, compId: number): Set<number> {
  const out = new Set([compId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const item of project.items.values()) {
      if (item.kind !== "comp" || out.has(item.id)) continue;
      if (item.layers.some((l) => out.has(l.sourceId))) {
        out.add(item.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Call after anything changes what a comp renders (property edits, footage, settings): drops the RAM preview
 * frames of that comp and of every comp nesting it, or of all comps, and the renderers' layer content caches.
 */
export function invalidate(compId?: number): void {
  if (compId === undefined || !attached) ramCache.invalidate();
  else {
    const ids = dependents(attached, compId);
    ramCache.invalidate((view) => ids.has(Number(view.split("@")[0])));
  }
  for (const r of renderers) r.clearCaches();
  invalidated();
}

/** Frames belong to one project; opening another empties the cache. */
export function attachProject(project: Project): void {
  if (project === attached) return;
  attached = project;
  ramCache.invalidate();
  invalidated();
}

export interface PlaybackStats {
  playing: boolean;
  /** Presented frames per second over the last second while playing. */
  fps: number;
  realTime: boolean;
  /** Milliseconds the last rendered (not cached) frame took. */
  renderMs: number;
  dropped: number;
  /** Holding a frame whose footage is still decoding. */
  waiting: boolean;
}

let stats: PlaybackStats = { playing: false, fps: 0, realTime: true, renderMs: 0, dropped: 0, waiting: false };
const statsListeners = new Set<() => void>();

export const playbackStats = {
  get: (): PlaybackStats => stats,
  set(next: Partial<PlaybackStats>): void {
    const merged = { ...stats, ...next };
    if ((Object.keys(merged) as (keyof PlaybackStats)[]).every((k) => merged[k] === stats[k])) return;
    stats = merged;
    for (const l of statsListeners) l();
  },
  subscribe(listener: () => void): () => void {
    statsListeners.add(listener);
    return () => statsListeners.delete(listener);
  },
};
