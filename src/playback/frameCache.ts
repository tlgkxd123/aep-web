/**
 * RAM preview cache: rendered frames per view (a comp at one resolution), bounded by a byte budget and evicted
 * least recently used first. `ranges` gives the cached spans the timeline draws as AE's green bar.
 */
export class FrameCache<V> {
  private readonly entries = new Map<string, { view: string; frame: number; value: V; bytes: number }>();
  private readonly listeners = new Set<() => void>();
  private used = 0;
  private revision = 0;
  private budgetBytes: number;
  private readonly dispose: (value: V) => void;

  constructor(budgetBytes: number, dispose: (value: V) => void = () => undefined) {
    this.budgetBytes = budgetBytes;
    this.dispose = dispose;
  }

  private static id(view: string, frame: number): string {
    return `${view}#${frame}`;
  }

  get bytes(): number {
    return this.used;
  }

  get budget(): number {
    return this.budgetBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Increments whenever the cached set changes; a cheap snapshot for subscribers. */
  get version(): number {
    return this.revision;
  }

  setBudget(bytes: number): void {
    this.budgetBytes = bytes;
    if (this.evict()) this.changed();
  }

  has(view: string, frame: number): boolean {
    return this.entries.has(FrameCache.id(view, frame));
  }

  /** The cached frame, marked as most recently used. */
  get(view: string, frame: number): V | undefined {
    const id = FrameCache.id(view, frame);
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.value;
  }

  /** Stores a frame; returns false (and disposes it) when it alone exceeds the budget. */
  put(view: string, frame: number, value: V, bytes: number): boolean {
    const id = FrameCache.id(view, frame);
    const old = this.entries.get(id);
    if (old) {
      this.entries.delete(id);
      this.used -= old.bytes;
      if (old.value !== value) this.dispose(old.value);
    }
    if (bytes > this.budgetBytes) {
      this.dispose(value);
      if (old) this.changed();
      return false;
    }
    this.entries.set(id, { view, frame, value, bytes });
    this.used += bytes;
    this.evict();
    this.changed();
    return true;
  }

  private evict(): boolean {
    let evicted = false;
    for (const [id, entry] of this.entries) {
      if (this.used <= this.budgetBytes) break;
      this.entries.delete(id);
      this.used -= entry.bytes;
      this.dispose(entry.value);
      evicted = true;
    }
    return evicted;
  }

  /** Cached frames of a view as sorted [start, end) frame spans. */
  ranges(view: string): [number, number][] {
    const frames: number[] = [];
    for (const entry of this.entries.values()) if (entry.view === view) frames.push(entry.frame);
    frames.sort((a, b) => a - b);
    const out: [number, number][] = [];
    for (const f of frames) {
      const last = out[out.length - 1];
      if (last && last[1] === f) last[1] = f + 1;
      else out.push([f, f + 1]);
    }
    return out;
  }

  /** Drops the frames of the views `match` accepts, or every frame. */
  invalidate(match?: (view: string) => boolean): void {
    let removed = false;
    for (const [id, entry] of this.entries) {
      if (match && !match(entry.view)) continue;
      this.entries.delete(id);
      this.used -= entry.bytes;
      this.dispose(entry.value);
      removed = true;
    }
    if (removed) this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.revision++;
    for (const l of this.listeners) l();
  }
}
