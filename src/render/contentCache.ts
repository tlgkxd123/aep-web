// Per-layer caches: content that is expensive to rasterize on the CPU (shape
// layers), keyed by every value its inputs take at the frame's time, so a static
// layer is rasterized once and an edited or animated one is redrawn as soon as
// one of its values differs (inputs an expression may drive are never cached);
// and layer images reused between frames under the keys of layerKeys.ts.
import { valueAtTime } from "../aep/evaluate.ts";
import type { Layer, PropertyNode } from "../aep/model.ts";

/**
 * A string that differs whenever a value, enabled flag or the structure under
 * `nodes` differs at `time`; null when an enabled expression drives one of them.
 */
export function valuesKey(nodes: readonly PropertyNode[], time: number, layer: Layer): string | null {
  const parts: string[] = [];
  const walk = (list: readonly PropertyNode[]): boolean => {
    for (const node of list) {
      if (node.kind === "group") {
        parts.push(`(${node.matchName}${node.enabled ? "" : "!"}${node.mask ? JSON.stringify(node.mask) : ""}`);
        if (!walk(node.children)) return false;
        parts.push(")");
        continue;
      }
      if (node.expressionEnabled && node.expression) return false;
      const value = node.keyframes.length ? valueAtTime(node, time, layer) : node.value;
      parts.push(`${node.matchName}${node.enabled ? "" : "!"}=${JSON.stringify(value)}`);
    }
    return true;
  };
  return walk(nodes) ? parts.join(";") : null;
}

/**
 * One entry per owner (a layer) with the key it was made for, the least recently used dropped once the entries
 * hold more than `budget` bytes. For images reused between frames (layerKeys.ts).
 */
export class ImageCache<V> {
  private readonly entries = new Map<object, { key: string; value: V; bytes: number }>();
  private readonly budget: number;
  private readonly dispose: (value: V) => void;
  private held = 0;
  constructor(budget: number, dispose: (value: V) => void) {
    this.budget = budget;
    this.dispose = dispose;
  }

  get(owner: object, key: string): V | undefined {
    const entry = this.entries.get(owner);
    if (!entry || entry.key !== key) return undefined;
    this.entries.delete(owner);
    this.entries.set(owner, entry);
    return entry.value;
  }

  /** Stores `value` for `owner`, replacing its previous entry; returns false (keeping nothing) when it alone exceeds the budget. */
  set(owner: object, key: string, value: V, bytes: number): boolean {
    this.delete(owner);
    if (bytes > this.budget) return false;
    this.entries.set(owner, { key, value, bytes });
    this.held += bytes;
    for (const [other] of this.entries) {
      if (this.held <= this.budget) break;
      if (other !== owner) this.delete(other);
    }
    return true;
  }

  delete(owner: object): void {
    const entry = this.entries.get(owner);
    if (!entry) return;
    this.entries.delete(owner);
    this.held -= entry.bytes;
    this.dispose(entry.value);
  }

  clear(): void {
    for (const owner of [...this.entries.keys()]) this.delete(owner);
  }

  /** Bytes the entries hold. */
  get bytes(): number {
    return this.held;
  }
}

/** One entry per layer: the last cached value and the key it was made for. */
export class LayerCache<V> {
  private readonly entries = new Map<Layer, { key: string; value: V | undefined }>();
  private readonly dispose: (value: V) => void;
  constructor(dispose: (value: V) => void) {
    this.dispose = dispose;
  }

  get(layer: Layer, key: string): V | undefined {
    const entry = this.entries.get(layer);
    return entry && entry.key === key ? entry.value : undefined;
  }

  /** The layer's cached value whatever its key, to reuse its storage. */
  peek(layer: Layer): V | undefined {
    return this.entries.get(layer)?.value;
  }

  set(layer: Layer, key: string, value: V): void {
    const old = this.entries.get(layer);
    if (old?.value !== undefined && old.value !== value) this.dispose(old.value);
    this.entries.set(layer, { key, value });
  }

  /**
   * Stores `make()` once the layer was asked about the same key twice in a row,
   * so content that changes every frame does not pay for a cached copy.
   */
  offer(layer: Layer, key: string, make: () => V): void {
    const old = this.entries.get(layer);
    if (old?.key === key) {
      old.value ??= make();
      return;
    }
    if (old?.value !== undefined) this.dispose(old.value);
    this.entries.set(layer, { key, value: undefined });
  }

  clear(): void {
    for (const { value } of this.entries.values()) if (value !== undefined) this.dispose(value);
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
