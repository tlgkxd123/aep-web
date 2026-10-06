// Per-layer caches for content that is expensive to rasterize on the CPU (shape
// layers). An entry is keyed by every value its inputs take at
// the frame's time, so a static layer is rasterized once and an edited or
// animated one is redrawn as soon as one of its values differs. Inputs that an
// expression may drive are never cached.
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
