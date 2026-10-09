import type { CompItem, Project } from "../aep/model.ts";
import { footageStore } from "../media/store.ts";
import type { Target } from "../render/gl.ts";
import { Renderer, scaledSize } from "../render/renderer.ts";
import { frameDuration } from "./clock.ts";
import { attachProject, cacheView, contentGeneration, invalidate, ramCache, registerRenderer } from "./ramCache.ts";
import { appRenderOptions } from "./renderOptions.ts";

/** The Composition panel's Resolution/Down Sample Factor: a divisor, or Auto from the magnification. */
export type ViewerResolution = 1 | 2 | 3 | 4 | "auto";

/** AE's Auto resolution: the largest divisor that still renders at least one pixel per screen pixel. */
export function autoFactor(zoom: number): 1 | 2 | 3 | 4 {
  return Math.min(4, Math.max(1, Math.floor(1 / zoom + 1e-6))) as 1 | 2 | 3 | 4;
}

/**
 * What `show` did: drew the frame from the RAM cache or rendered it, found it already on screen, or kept the
 * frame on screen because footage or audio the new one needs is still loading.
 */
export type Shown = "cached" | "rendered" | "same" | "waiting";

let footageFiles = -1;

/** Frames rendered while footage was missing are stale once files are added. */
function checkFootageFiles(): void {
  const version = footageStore.filesVersion;
  if (version === footageFiles) return;
  if (footageFiles >= 0) invalidate();
  footageFiles = version;
}

/**
 * Draws a comp's frames into a visible 2D canvas. Frames come from the RAM preview cache when they are there;
 * otherwise the renderer (on its own OffscreenCanvas) renders them at the view's resolution, and complete frames
 * are shown and cached as ImageBitmaps. A frame rendered while its footage is still decoding is never cached and
 * replaces the picture only when there is nothing of the view on screen yet, so the viewer does not flicker
 * through stand-in footage while playing or scrubbing.
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
  private shown: { view: string; frame: number; generation: number; complete: boolean } | null = null;
  /** What the renderer skipped or approximated in the last rendered frame. */
  warnings: string[] = [];
  /** Milliseconds the last render took. */
  lastRenderMs = 0;

  constructor(display: HTMLCanvasElement) {
    this.display = display;
    this.context = display.getContext("2d");
    this.surface = new OffscreenCanvas(1, 1);
    this.renderer = new Renderer(this.surface, appRenderOptions);
    this.unregister = registerRenderer(this.renderer);
  }

  /** Sets what the viewer shows; frames are cached per comp and resolution. */
  attach(project: Project, comp: CompItem, factor = this.factor): void {
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

  private render(frame: number): { bitmap: ImageBitmap; complete: boolean } {
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
    // Unflushed, the bitmap's commands can sit in this context while the display canvas waits on them, and the
    // page stops getting animation frames until something renders again.
    this.renderer.gl.flush();
    if (this.last) this.renderer.release(this.last.target);
    this.last = { frame, view: this.view, generation: contentGeneration(), target };
    this.warnings = this.renderer.lastWarnings;
    this.lastRenderMs = performance.now() - started;
    return { bitmap, complete: this.renderer.lastComplete };
  }

  private draw(bitmap: ImageBitmap, frame: number, complete: boolean): void {
    if (this.display.width !== bitmap.width || this.display.height !== bitmap.height) {
      this.display.width = bitmap.width;
      this.display.height = bitmap.height;
    }
    this.context?.clearRect(0, 0, bitmap.width, bitmap.height);
    this.context?.drawImage(bitmap, 0, 0);
    this.shown = { view: this.view, frame, generation: contentGeneration(), complete };
    this.display.dataset.frame = String(frame);
    this.display.dataset.complete = String(complete);
  }

  /**
   * Shows a frame. One rendered while footage or audio is still loading is drawn only when `partial` is set, the
   * view has nothing on screen yet, or it is the frame already shown; otherwise the picture on screen stays and
   * the result is "waiting" until the frame can be rendered complete.
   */
  show(frame: number, partial = false): Shown {
    if (!this.project || !this.comp) return "same";
    checkFootageFiles();
    const view = this.view;
    const on = this.shown;
    const current = on?.view === view && on.generation === contentGeneration();
    if (current && on.frame === frame && on.complete) return "same";
    const hit = ramCache.get(view, frame);
    if (hit) {
      this.draw(hit, frame, true);
      return "cached";
    }
    const { bitmap, complete } = this.render(frame);
    if (complete) {
      this.draw(bitmap, frame, true);
      ramCache.put(view, frame, bitmap, bitmap.width * bitmap.height * 4);
      return "rendered";
    }
    if (partial || on?.view !== view || on.frame === frame) this.draw(bitmap, frame, false);
    bitmap.close();
    return "waiting";
  }

  /** Renders a frame into the RAM cache without showing it. False when its footage is still loading, and nothing was cached. */
  prefetch(frame: number): boolean {
    if (!this.project || !this.comp) return true;
    checkFootageFiles();
    if (this.cached(frame)) return true;
    const { bitmap, complete } = this.render(frame);
    if (complete) ramCache.put(this.view, frame, bitmap, bitmap.width * bitmap.height * 4);
    else bitmap.close();
    return complete;
  }

  /** Straight RGBA of a comp pixel in the frame shown, rendering that frame again if needed. */
  readPixel(frame: number, x: number, y: number): [number, number, number, number] {
    if (!this.project || !this.comp) return [0, 0, 0, 0];
    if (!this.last || this.last.frame !== frame || this.last.view !== this.view || this.last.generation !== contentGeneration()) {
      const { bitmap, complete } = this.render(frame);
      if (complete && !ramCache.has(this.view, frame)) ramCache.put(this.view, frame, bitmap, bitmap.width * bitmap.height * 4);
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
