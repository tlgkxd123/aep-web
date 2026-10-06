import type { CompItem, Project } from "../aep/model.ts";
import { Renderer } from "../render/renderer.ts";
import { EXPORT_CHANNELS, EXPORT_SAMPLE_RATE, mixCompAudio, type MixedAudio } from "./audio.ts";
import { downloadSink, fileSink } from "./output.ts";
import { rendererSource, renderToSink, type Sink } from "./pipeline.ts";
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
  /** Wall-clock start of the last render (epoch ms). */
  started?: number;
  renderMs?: number;
  frame: number;
  frames: number;
  bytes?: number;
  /** Codec of the audio track the last render wrote, if it wrote one. */
  audioCodec?: string;
  error?: string;
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
  private renderer: Renderer | null = null;
  /** Builds the renderer used for output; replaced in tests. */
  createRenderer: () => Renderer = () => new Renderer(new OffscreenCanvas(1, 1));
  /** Opens the sink for an item; replaced by the export gate to keep bytes in memory. */
  openSink: (item: QueueItem) => Promise<Sink> = async (item) =>
    item.handle ? fileSink(item.handle) : downloadSink(item.fileName, FORMATS[item.output.format].mime);
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
    this.renderer = null;
    this.set({ items: [], current: null });
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
    this.patch(id, { output, ...(formatChanged ? { fileName: withExtension(item.fileName, output.format), handle: undefined } : {}) });
  }

  setOutputFile(id: number, fileName: string, handle?: FileSystemFileHandle): void {
    this.patch(id, { fileName, handle });
  }

  private comp(item: QueueItem | undefined): CompItem | undefined {
    const found = item && this.project?.items.get(item.compId);
    return found?.kind === "comp" ? found : undefined;
  }

  /** Renders every Queued item in order. Resolves when the queue finishes or is stopped. */
  async render(): Promise<void> {
    if (this.rendering || !this.project) return;
    const project = this.project;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.paused = false;
    try {
      for (;;) {
        const item = this.snapshot.items.find((i) => i.status === "Queued");
        if (!item || signal.aborted || this.project !== project) break;
        await this.renderItem(project, item, signal);
      }
    } finally {
      this.abort = null;
      this.paused = false;
      this.set({ current: null });
    }
  }

  private async renderItem(project: Project, item: QueueItem, signal: AbortSignal): Promise<void> {
    const comp = this.comp(item);
    const started = Date.now();
    const plan = comp ? framePlan(comp, item.settings) : null;
    this.patch(item.id, { status: "Rendering", started, frame: 0, frames: plan?.frames ?? 0, error: undefined, renderMs: undefined, bytes: undefined, audioCodec: undefined, log: [] });
    this.pausedMs = 0;
    this.set({ current: { itemId: item.id, frame: 0, frames: plan?.frames ?? 0, elapsedMs: 0, remainingMs: null, paused: this.paused } });
    let sink: Sink | null = null;
    const warnings = new Set<string>();
    const elapsed = () => Date.now() - started - this.pausedMs - (this.paused ? Date.now() - this.pauseStart : 0);
    try {
      if (!comp || !plan) throw new Error("The composition is no longer in the project.");
      this.renderer ??= this.createRenderer();
      const audio = await this.mixAudio(project, comp, item.output, plan.start, plan.duration, warnings);
      sink = await this.openSink(item);
      const summary = await renderToSink(
        comp,
        item.settings,
        item.output,
        rendererSource(this.renderer, project, comp, plan, warnings),
        sink,
        item.fileName,
        {
          signal,
          resume: () => this.waitWhilePaused(),
          onFrame: (frame, frames) => {
            const ms = elapsed();
            this.patch(item.id, { frame });
            this.set({ current: { itemId: item.id, frame, frames, elapsedMs: ms, remainingMs: frame > 0 ? (ms / frame) * (frames - frame) : null, paused: this.paused } });
          },
        },
        audio,
      );
      this.patch(item.id, { status: "Done", renderMs: elapsed(), bytes: summary.bytes, audioCodec: summary.audioCodec, log: [...warnings] });
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
