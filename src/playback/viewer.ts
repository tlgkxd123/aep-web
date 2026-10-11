import type { CompItem, Project } from "../aep/model.ts";
import { isMobileDevice } from "../device.ts";
import { collectPending } from "../media/pending.ts";
import { footageStore } from "../media/store.ts";
import type { Target } from "../render/gl.ts";
import { Renderer, scaledSize } from "../render/renderer.ts";
import { frameDuration } from "./clock.ts";
import { appBudgets } from "./memory.ts";
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

/** Renders whose GPU times gpuTypicalMs looks at. */
const RECENT_RENDERS = 6;

/** Renders by the viewers, and how many of them footage still decoding left incomplete (for profiling playback). */
export const viewerStats = {
  renders: 0,
  incomplete: 0,
  waitingFootage: 0,
  waitingSpectra: 0,
  waitingUnknown: 0,
  renderMs: 0,
  factor: 1,
  /** Why playback's rendering ahead stopped, per animation frame: the GPU queue was full, or footage was decoding. */
  aheadGpuFull: 0,
  aheadFootage: 0,
};

// Dev server pages only: lets scripts/check-video-playback.ts count renders.
if (typeof document !== "undefined" && document.querySelector('meta[name="aep-local-footage"]')) {
  (window as unknown as { aepViewer: typeof viewerStats }).aepViewer = viewerStats;
}

/** The adapter in a WebGL renderer string: "Intel(R) UHD Graphics" from "ANGLE (Intel, Intel(R) UHD Graphics (0x...) Direct3D11 ...)". */
export function gpuName(renderer: string): string {
  const angle = /^ANGLE \([^,]*, (.*?)(?: \(0x[0-9a-f]+\))?(?: Direct3D.*| OpenGL.*| Metal.*|, D3D.*|\))?$/i.exec(renderer);
  return (angle?.[1] ?? renderer).trim();
}

/**
 * Whether a GPU is one built into the processor (or a software renderer): on a laptop with a dedicated GPU too,
 * the browser runs on it unless Windows is told otherwise.
 */
export function isIntegratedGpu(name: string): boolean {
  return /Intel(?!.*\bArc\b)|Radeon\(TM\) (Graphics|Vega)|Microsoft Basic Render|SwiftShader|llvmpipe/i.test(name);
}

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
  /**
   * Work the last render found in progress (footage decoding, spectra computing; see pending.ts); null when that
   * cannot be told (a movie whose decoder was opening).
   */
  lastWaiting: string[] | null = [];
  /** Renders submitted to the GPU and not seen finished yet, oldest first, with when each was submitted. */
  private fences: { sync: WebGLSync; at: number }[] = [];
  private finishedAt = 0;
  /** About how long the GPU takes per render lately, in milliseconds (0 until a render has been seen finishing). */
  gpuMs = 0;
  /** Renders seen finishing since the timing was last reset. */
  gpuSamples = 0;
  private gpuRecent: number[] = [];
  private timedSince = 0;

  /** The GPU the viewer renders on, as the browser names it. */
  readonly gpu: string;

  constructor(display: HTMLCanvasElement) {
    this.display = display;
    this.context = display.getContext("2d");
    this.surface = new OffscreenCanvas(1, 1);
    this.renderer = new Renderer(this.surface, appRenderOptions, appBudgets());
    this.unregister = registerRenderer(this.renderer);
    const gl = this.renderer.gl;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    this.gpu = gpuName(String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)));
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
    const { result: target, waiting } = collectPending(() => this.renderer.render(project, comp, frame * frameDuration(comp), { scale }));
    this.lastWaiting = waiting;
    if (this.surface.width !== width || this.surface.height !== height) {
      this.surface.width = width;
      this.surface.height = height;
    }
    this.renderer.present(target, { ...comp, width, height });
    const bitmap = this.surface.transferToImageBitmap();
    const gl = this.renderer.gl;
    this.gpuQueue();
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (sync) this.fences.push({ sync, at: performance.now() });
    // Unflushed, the bitmap's commands can sit in this context while the display canvas waits on them, and the
    // page stops getting animation frames until something renders again.
    gl.flush();
    if (this.last) this.renderer.release(this.last.target);
    this.last = { frame, view: this.view, generation: contentGeneration(), target };
    this.warnings = this.renderer.lastWarnings;
    this.lastRenderMs = performance.now() - started;
    viewerStats.renders++;
    viewerStats.renderMs += this.lastRenderMs;
    viewerStats.factor = this.factor;
    if (!this.renderer.lastComplete) {
      viewerStats.incomplete++;
      if (!waiting) viewerStats.waitingUnknown++;
      else {
        if (waiting.some((k) => k.startsWith("footage"))) viewerStats.waitingFootage++;
        if (waiting.some((k) => k.startsWith("spectra"))) viewerStats.waitingSpectra++;
      }
    }
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

  /**
   * Renders the GPU is still working through. The browser updates what it knows between tasks, so this is polled
   * (each animation frame) rather than waited on; it also keeps `gpuMs` up to date.
   */
  gpuQueue(): number {
    const gl = this.renderer.gl;
    const now = performance.now();
    while (this.fences.length) {
      const { sync, at } = this.fences[0];
      if (gl.getSyncParameter(sync, gl.SYNC_STATUS) !== gl.SIGNALED) break;
      gl.deleteSync(sync);
      this.fences.shift();
      // Queued renders run back to back: one took from its submission, or the one before it finishing, until now.
      if (at >= this.timedSince) {
        const took = now - Math.max(at, this.finishedAt);
        this.gpuMs = this.gpuMs ? this.gpuMs + (took - this.gpuMs) * 0.3 : took;
        // The first render at a resolution fills the layer caches; it says little about the ones after it.
        if (this.gpuSamples++ > 0) this.gpuRecent.push(took);
        if (this.gpuRecent.length > RECENT_RENDERS) this.gpuRecent.shift();
      }
      this.finishedAt = now;
    }
    return this.fences.length;
  }

  /** Starts measuring the GPU anew, leaving out renders already submitted (a change of resolution costs differently). */
  resetGpuTiming(): void {
    this.gpuMs = 0;
    this.gpuSamples = 0;
    this.gpuRecent = [];
    this.timedSince = performance.now();
  }

  /** The middle of the last few renders' GPU times: what a render costs once the first ones have filled the caches. */
  gpuTypicalMs(): number {
    const sorted = [...this.gpuRecent].sort((a, b) => a - b);
    return sorted.length ? sorted[sorted.length >> 1] : 0;
  }

  /**
   * Asks for the movie frames `frame` shows so they decode before it renders; `ready` when they all have, else
   * what they wait for (see pending.ts).
   */
  requestFootage(frame: number): { ready: boolean; waiting: string[] | null } {
    if (!this.project || !this.comp) return { ready: true, waiting: [] };
    const project = this.project;
    const comp = this.comp;
    const { result, waiting } = collectPending(() => this.renderer.requestFootage(project, comp, frame * frameDuration(comp)));
    return { ready: result, waiting };
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
    for (const { sync } of this.fences) this.renderer.gl.deleteSync(sync);
    this.fences = [];
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

const zooms = new Map<number, number>();

/** Each comp viewer's magnification (1 = 100%), for Fast Previews. */
export const viewerZooms = {
  get: (compId: number): number => zooms.get(compId) ?? 1,
  set(compId: number, zoom: number): void {
    zooms.set(compId, zoom);
  },
};

const FAST_PREVIEWS_KEY = "aep-web.fastPreviews";
const fastPreviewListeners = new Set<() => void>();
let adaptive = (() => {
  try {
    return globalThis.localStorage?.getItem(FAST_PREVIEWS_KEY) !== "off";
  } catch {
    return true;
  }
})();

/**
 * Fast Previews (Adaptive Resolution), the Composition panel's button: while a comp plays, its viewer renders no
 * finer than it shows the comp and, when the GPU cannot keep up, at a lower resolution (see usePlayback).
 */
export const fastPreviews = {
  get adaptive(): boolean {
    return adaptive;
  },
  set(on: boolean): void {
    if (on === adaptive) return;
    adaptive = on;
    try {
      globalThis.localStorage?.setItem(FAST_PREVIEWS_KEY, on ? "on" : "off");
    } catch {
      // Not kept between sessions where storage is unavailable.
    }
    for (const l of fastPreviewListeners) l();
  },
  subscribe(listener: () => void): () => void {
    fastPreviewListeners.add(listener);
    return () => fastPreviewListeners.delete(listener);
  },
};

const AUTO_RESOLUTION_KEY = "aep-web.autoResolution";
const autoResolutionListeners = new Set<() => void>();
let autoOn = (() => {
  try {
    const stored = globalThis.localStorage?.getItem(AUTO_RESOLUTION_KEY);
    if (stored === "on" || stored === "off") return stored === "on";
  } catch {
    // Falls back to the device's default.
  }
  return isMobileDevice();
})();

/**
 * The Resolution menu's Auto: the viewer renders no finer than it shows the comp, nor than the comp's own
 * Resolution, paused as well as playing. On by default on phones and tablets, whose GPUs would otherwise render a
 * full HD comp at Full for a viewer a few hundred pixels wide.
 */
export const autoResolution = {
  get on(): boolean {
    return autoOn;
  },
  set(on: boolean): void {
    if (on === autoOn) return;
    autoOn = on;
    try {
      globalThis.localStorage?.setItem(AUTO_RESOLUTION_KEY, on ? "on" : "off");
    } catch {
      // Not kept between sessions where storage is unavailable.
    }
    for (const l of autoResolutionListeners) l();
  },
  subscribe(listener: () => void): () => void {
    autoResolutionListeners.add(listener);
    return () => autoResolutionListeners.delete(listener);
  },
};

/** The divisor a viewer renders at: the comp's Resolution, or with Auto the coarser of it and the magnification's. */
export function viewerFactor(compFactor: number, zoom: number, auto: boolean): number {
  const factor = Math.max(1, compFactor || 1);
  return auto ? Math.max(factor, autoFactor(zoom)) : factor;
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
