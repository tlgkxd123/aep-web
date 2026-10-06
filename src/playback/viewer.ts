import type { CompItem, Project } from "../aep/model.ts";
import type { Target } from "../render/gl.ts";
import { Renderer, scaledSize } from "../render/renderer.ts";
import { frameDuration } from "./clock.ts";
import { attachProject, cacheView, contentGeneration, ramCache, registerRenderer } from "./ramCache.ts";

/** The Composition panel's Resolution/Down Sample Factor: a divisor, or Auto from the magnification. */
export type ViewerResolution = 1 | 2 | 3 | 4 | "auto";

/** AE's Auto resolution: the largest divisor that still renders at least one pixel per screen pixel. */
export function autoFactor(zoom: number): 1 | 2 | 3 | 4 {
  return Math.min(4, Math.max(1, Math.floor(1 / zoom + 1e-6))) as 1 | 2 | 3 | 4;
}

/**
 * Draws a comp's frames into a visible 2D canvas. Frames come from the RAM preview cache when they are there;
 * otherwise the renderer (on its own OffscreenCanvas) renders them at the view's resolution, and the frame is
 * shown and cached as an ImageBitmap.
 */
export class ViewerEngine {
  private readonly display: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly surface: OffscreenCanvas;
  readonly renderer: Renderer;
  private readonly unregister: () => void;
  private project: Project | null = null;
  private comp: CompItem | null = null;
  private factor = 1;
  private last: { frame: number; view: string; generation: number; target: Target } | null = null;
  private shown: { key: string; generation: number } | null = null;
  /** What the renderer skipped or approximated in the last rendered frame. */
  warnings: string[] = [];
  /** Milliseconds the last render took. */
  lastRenderMs = 0;

  constructor(display: HTMLCanvasElement) {
    this.display = display;
    this.context = display.getContext("2d");
    this.surface = new OffscreenCanvas(1, 1);
    this.renderer = new Renderer(this.surface);
    this.unregister = registerRenderer(this.renderer);
  }

  /** Sets what the viewer shows; frames are cached per comp and resolution. */
  attach(project: Project, comp: CompItem, factor: number): void {
    attachProject(project);
    this.project = project;
    this.comp = comp;
    this.factor = factor;
  }

  private get view(): string {
    return cacheView(this.comp!.id, this.factor);
  }

  cached(frame: number): boolean {
    return !!this.comp && ramCache.has(this.view, frame);
  }

  private render(frame: number): ImageBitmap {
    const project = this.project!;
    const comp = this.comp!;
    const scale = 1 / this.factor;
    const width = scaledSize(comp.width, scale);
    const height = scaledSize(comp.height, scale);
    const started = performance.now();
    const target = this.renderer.render(project, comp, frame * frameDuration(comp), { scale });
    if (this.surface.width !== width || this.surface.height !== height) {
      this.surface.width = width;
      this.surface.height = height;
    }
    this.renderer.present(target, { ...comp, width, height });
    const bitmap = this.surface.transferToImageBitmap();
    if (this.last) this.renderer.release(this.last.target);
    this.last = { frame, view: this.view, generation: contentGeneration(), target };
    this.warnings = this.renderer.lastWarnings;
    this.lastRenderMs = performance.now() - started;
    return bitmap;
  }

  /** Shows a frame. Returns the milliseconds spent rendering it, 0 when it came from the RAM cache. */
  show(frame: number): number {
    if (!this.project || !this.comp) return 0;
    const view = this.view;
    const key = `${view}#${frame}`;
    if (this.shown?.key === key && this.shown.generation === contentGeneration()) return 0;
    let bitmap = ramCache.get(view, frame);
    let ms = 0;
    let fresh = false;
    if (!bitmap) {
      bitmap = this.render(frame);
      ms = this.lastRenderMs;
      fresh = true;
    }
    if (this.display.width !== bitmap.width || this.display.height !== bitmap.height) {
      this.display.width = bitmap.width;
      this.display.height = bitmap.height;
    }
    this.context?.clearRect(0, 0, bitmap.width, bitmap.height);
    this.context?.drawImage(bitmap, 0, 0);
    if (fresh) ramCache.put(view, frame, bitmap, bitmap.width * bitmap.height * 4);
    this.shown = { key, generation: contentGeneration() };
    return ms;
  }

  /** Renders a frame into the RAM cache without showing it. Returns the milliseconds spent. */
  prefetch(frame: number): number {
    if (!this.project || !this.comp || this.cached(frame)) return 0;
    const bitmap = this.render(frame);
    ramCache.put(this.view, frame, bitmap, bitmap.width * bitmap.height * 4);
    return this.lastRenderMs;
  }

  /** Straight RGBA of a comp pixel in the frame shown, rendering that frame again if needed. */
  readPixel(frame: number, x: number, y: number): [number, number, number, number] {
    if (!this.project || !this.comp) return [0, 0, 0, 0];
    if (!this.last || this.last.frame !== frame || this.last.view !== this.view || this.last.generation !== contentGeneration()) {
      const bitmap = this.render(frame);
      if (!ramCache.has(this.view, frame)) ramCache.put(this.view, frame, bitmap, bitmap.width * bitmap.height * 4);
      else bitmap.close();
    }
    const scale = 1 / this.factor;
    return this.renderer.readPixel(this.last!.target, x * scale, y * scale);
  }

  dispose(): void {
    if (this.last) this.renderer.release(this.last.target);
    this.last = null;
    this.unregister();
    (this.renderer.gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
  }
}

const viewers = new Map<number, ViewerEngine>();

/** The mounted viewer of a comp, which playback drives directly. */
export function getViewer(compId: number): ViewerEngine | undefined {
  return viewers.get(compId);
}

export function setViewer(compId: number, engine: ViewerEngine | undefined): void {
  if (engine) viewers.set(compId, engine);
  else viewers.delete(compId);
  for (const l of factorListeners) l();
}

const factors = new Map<number, number>();
const factorListeners = new Set<() => void>();

/** The resolution divisor each comp's viewer renders at (Auto resolved), for the timeline's cache bar. */
export const viewerFactors = {
  get: (compId: number): number => factors.get(compId) ?? 1,
  set(compId: number, factor: number): void {
    if (factors.get(compId) === factor) return;
    factors.set(compId, factor);
    for (const l of factorListeners) l();
  },
  subscribe(listener: () => void): () => void {
    factorListeners.add(listener);
    return () => factorListeners.delete(listener);
  },
};
