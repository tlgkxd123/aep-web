import type { CompItem, Project } from "../aep/model.ts";
import { isMobileDevice } from "../device.ts";
import { footageStore } from "../media/store.ts";
import { appBudgets } from "../playback/memory.ts";
import { registerRenderer, viewerRenderers } from "../playback/ramCache.ts";
import { appRenderOptions } from "../playback/renderOptions.ts";
import { Renderer } from "../render/renderer.ts";
import { EXPORT_CHANNELS, EXPORT_SAMPLE_RATE, mixCompAudio, type MixedAudio } from "./audio.ts";
import { downloadSink, fileSink } from "./output.ts";
import { newStats, rendererFrames, rendererSource, renderToSink, statsSummary, type Sink } from "./pipeline.ts";
import type { SavedFile } from "./saveFile.ts";
import {
  defaultFileName,
  defaultOutputModule,
  defaultRenderSettings,
  formatHasAudio,
  FORMATS,
  framePlan,
  withExtension,
  type OutputModule,
  type RenderSettings,
} from "./settings.ts";

export type ItemStatus = "Queued" | "Unqueued" | "Rendering" | "Done" | "Failed" | "User Stopped";

export interface QueueItem {
  id: number;
  compId: number;
  compName: string;
  status: ItemStatus;
  settings: RenderSettings;
  output: OutputModule;
  fileName: string;
  /** The file picked under Output To; without one the finished render downloads. */
  handle?: FileSystemFileHandle;
  /** Where the last render without a picked file was saved, under the name it got. */
  saved?: SavedFile;
  /** Wall-clock start of the last render (epoch ms). */
  started?: number;
  renderMs?: number;
  frame: number;
  frames: number;
  bytes?: number;
  /** Codec of the audio track the last render wrote, if it wrote one. */
  audioCodec?: string;
  error?: string;
  /** Where the last render's time went. */
  perf?: string;
  /** Renderer warnings from the last render: features it skipped or approximated. */
  log: string[];
}

export interface CurrentRender {
  itemId: number;
  frame: number;
  frames: number;
  elapsedMs: number;
  remainingMs: number | null;
  paused: boolean;
}

export interface QueueSnapshot {
  items: readonly QueueItem[];
  current: CurrentRender | null;
}

type Listener = () => void;

/** The renderer of one run of the queue: made for its first item, freed when the run ends. */
interface OutputRenderer {
  renderer?: Renderer;
  unregister?: () => void;
}

export class RenderQueue {
  private project: Project | null = null;
  private snapshot: QueueSnapshot = { items: [], current: null };
  private readonly listeners = new Set<Listener>();
  private nextId = 1;
  private abort: AbortController | null = null;
  private paused = false;
  private pausedMs = 0;
  private pauseStart = 0;
  private resumeWaiters: (() => void)[] = [];
  /** Builds the renderer used for output; replaced in tests. */
  createRenderer: () => Renderer = () => new Renderer(new OffscreenCanvas(1, 1), appRenderOptions, appBudgets());
  /** Opens the sink for an item; replaced by the export gate to keep bytes in memory. */
  openSink: (item: QueueItem) => Promise<Sink> = async (item) =>
    item.handle ? fileSink(item.handle) : downloadSink(item.fileName, FORMATS[item.output.format].mime, (saved) => this.patch(item.id, { saved }));
  /** Mixes a comp's audio over a span; replaced in tests without Web Audio. */
  mix: typeof mixCompAudio = mixCompAudio;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): QueueSnapshot => this.snapshot;

  private set(next: Partial<QueueSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const l of this.listeners) l();
  }

  private patch(id: number, patch: Partial<QueueItem>): void {
    this.set({ items: this.snapshot.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  }

  /** Items belong to one project; opening another empties the queue. */
  attach(project: Project | null): void {
    if (project === this.project) return;
    if (this.snapshot.current) this.stop();
    this.project = project;
    this.set({ items: [], current: null });
  }

  /**
   * Follows edits to the same project (a new model after each change): items keep
   * their settings and drop when their comp is gone. A running render keeps the
   * project it started with.
   */
  update(project: Project | null): void {
    if (project === this.project || this.rendering) return;
    if (!project || !this.project) return this.attach(project);
    this.project = project;
    const items = this.snapshot.items.filter((item) => project.items.get(item.compId)?.kind === "comp");
    this.set({ items: items.map((item) => ({ ...item, compName: (project.items.get(item.compId) as CompItem).name })) });
  }

  get rendering(): boolean {
    return this.snapshot.current !== null;
  }

  add(project: Project, comp: CompItem): QueueItem {
    this.attach(project);
    const settings = defaultRenderSettings(comp);
    const output = defaultOutputModule();
    const item: QueueItem = {
      id: this.nextId++,
      compId: comp.id,
      compName: comp.name,
      status: "Queued",
      settings,
      output,
      fileName: defaultFileName(comp, output.format),
      frame: 0,
      frames: framePlan(comp, settings).frames,
      log: [],
    };
    this.set({ items: [...this.snapshot.items, item] });
    return item;
  }

  remove(id: number): void {
    if (this.snapshot.current?.itemId === id) return;
    this.set({ items: this.snapshot.items.filter((item) => item.id !== id) });
  }

  /** Moves an item to `index` in the queue (render order). */
  move(id: number, index: number): void {
    const items = [...this.snapshot.items];
    const from = items.findIndex((item) => item.id === id);
    if (from < 0) return;
    const [item] = items.splice(from, 1);
    items.splice(Math.max(0, Math.min(items.length, index)), 0, item);
    this.set({ items });
  }

  setQueued(id: number, queued: boolean): void {
    const item = this.snapshot.items.find((i) => i.id === id);
    if (!item || item.status === "Rendering") return;
    this.patch(id, { status: queued ? "Queued" : "Unqueued", ...(queued ? { frame: 0, error: undefined } : {}) });
  }

  setSettings(id: number, settings: RenderSettings): void {
    const item = this.snapshot.items.find((i) => i.id === id);
    const comp = this.comp(item);
    if (!item || !comp || item.status === "Rendering") return;
    this.patch(id, { settings, frames: framePlan(comp, settings).frames });
  }

  setOutput(id: number, output: OutputModule): void {
    const item = this.snapshot.items.find((i) => i.id === id);
    if (!item || item.status === "Rendering") return;
    const formatChanged = output.format !== item.output.format;
    this.patch(id, { output, ...(formatChanged ? { fileName: withExtension(item.fileName, output.format), handle: undefined, saved: undefined } : {}) });
  }

  setOutputFile(id: number, fileName: string, handle?: FileSystemFileHandle): void {
    this.patch(id, { fileName, handle, saved: undefined });
  }

  private comp(item: QueueItem | undefined): CompItem | undefined {
    const found = item && this.project?.items.get(item.compId);
    return found?.kind === "comp" ? found : undefined;
  }

  /**
   * Renders every Queued item in order. Resolves when the queue finishes or is stopped. The output renderer is
   * the app's second set of GPU caches beside the viewers': it is there for memory pressure to reach while the
   * queue renders, and gone, context and all, once it stops.
   */
  async render(): Promise<void> {
    if (this.rendering || !this.project) return;
    const project = this.project;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.paused = false;
    const output: OutputRenderer = {};
    try {
      for (;;) {
        const item = this.snapshot.items.find((i) => i.status === "Queued");
        if (!item || signal.aborted || this.project !== project) break;
        await this.renderItem(project, item, signal, output);
      }
    } finally {
      output.unregister?.();
      output.renderer?.dispose();
      this.abort = null;
      this.paused = false;
      this.set({ current: null });
    }
  }

  /** The run's renderer, made on first use. A phone has no memory for the viewers' caches beside it: they go first. */
  private outputRenderer(output: OutputRenderer): Renderer {
    if (output.renderer) return output.renderer;
    if (isMobileDevice()) for (const viewer of viewerRenderers()) viewer.releaseMemory();
    const renderer = this.createRenderer();
    output.renderer = renderer;
    output.unregister = registerRenderer(renderer);
    return renderer;
  }

  private async renderItem(project: Project, item: QueueItem, signal: AbortSignal, output: OutputRenderer): Promise<void> {
    const comp = this.comp(item);
    const started = Date.now();
    const plan = comp ? framePlan(comp, item.settings) : null;
    this.patch(item.id, { status: "Rendering", started, frame: 0, frames: plan?.frames ?? 0, error: undefined, renderMs: undefined, bytes: undefined, audioCodec: undefined, saved: undefined, log: [] });
    this.pausedMs = 0;
    this.set({ current: { itemId: item.id, frame: 0, frames: plan?.frames ?? 0, elapsedMs: 0, remainingMs: null, paused: this.paused } });
    let sink: Sink | null = null;
    const warnings = new Set<string>();
    const elapsed = () => Date.now() - started - this.pausedMs - (this.paused ? Date.now() - this.pauseStart : 0);
    try {
      if (!comp || !plan) throw new Error("The composition is no longer in the project.");
      const renderer = this.outputRenderer(output);
      Object.assign(footageStore.stats, { imageDecodes: 0, imageMs: 0, videoRuns: 0, videoMs: 0, evictions: 0 });
      const audioStart = performance.now();
      const audio = await this.mixAudio(project, comp, item.output, plan.start, plan.duration, warnings);
      const audioMs = performance.now() - audioStart;
      const stats = newStats();
      sink = await this.openSink(item);
      const summary = await renderToSink(
        comp,
        item.settings,
        item.output,
        rendererSource(renderer, project, comp, plan, warnings),
        sink,
        item.fileName,
        {
          signal,
          resume: () => this.waitWhilePaused(),
          gpuFrames: rendererFrames(renderer, project, comp, plan, warnings, stats),
          stats,
          onFrame: (frame, frames) => {
            const ms = elapsed();
            this.patch(item.id, { frame });
            this.set({ current: { itemId: item.id, frame, frames, elapsedMs: ms, remainingMs: frame > 0 ? (ms / frame) * (frames - frame) : null, paused: this.paused } });
          },
        },
        audio,
      );
      const f = footageStore.stats;
      const perf = `audio mix ${(audioMs / 1000).toFixed(1)} s; ${statsSummary(stats)}; footage: ${f.imageDecodes} image decodes (${(f.imageMs / 1000).toFixed(1)} s), ${f.videoRuns} video decode runs (${(f.videoMs / 1000).toFixed(1)} s), ${f.evictions} cache evictions`;
      this.patch(item.id, { status: "Done", renderMs: elapsed(), bytes: summary.bytes, audioCodec: summary.audioCodec, perf, log: [...warnings] });
    } catch (e) {
      await sink?.abort().catch(() => undefined);
      const aborted = e instanceof DOMException && e.name === "AbortError";
      this.patch(item.id, {
        status: aborted ? "User Stopped" : "Failed",
        renderMs: elapsed(),
        error: aborted ? undefined : e instanceof Error ? e.message : String(e),
        log: [...warnings],
      });
    }
  }

  private async mixAudio(project: Project, comp: CompItem, output: OutputModule, start: number, duration: number, warnings: Set<string>): Promise<MixedAudio | null> {
    if (output.audio === "off" || !formatHasAudio(output.format)) return null;
    const mixed = await this.mix(project, comp, start, duration, (w) => warnings.add(w));
    if (mixed || output.audio !== "on") return mixed;
    const length = Math.max(1, Math.round(duration * EXPORT_SAMPLE_RATE));
    return { sampleRate: EXPORT_SAMPLE_RATE, channels: Array.from({ length: EXPORT_CHANNELS }, () => new Float32Array(length)) };
  }

  private waitWhilePaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  setPaused(paused: boolean): void {
    if (!this.rendering || paused === this.paused) return;
    this.paused = paused;
    if (paused) this.pauseStart = Date.now();
    else {
      this.pausedMs += Date.now() - this.pauseStart;
      for (const w of this.resumeWaiters.splice(0)) w();
    }
    const current = this.snapshot.current;
    if (current) this.set({ current: { ...current, paused } });
  }

  stop(): void {
    this.abort?.abort();
    if (this.paused) this.setPaused(false);
  }
}

export const renderQueue = new RenderQueue();
