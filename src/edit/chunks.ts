// Chunk-tree mutation primitives for the editor. Every change goes through a
// Transaction, which records the state of each chunk before its first change,
// so a command can be undone and redone by restoring chunk states.
import type { Chunk } from "../aep/riff.ts";

interface ChunkState {
  data: Uint8Array;
  children: Chunk[] | undefined;
  tail: Uint8Array | undefined;
}

const capture = (chunk: Chunk): ChunkState => ({ data: chunk.data, children: chunk.children?.slice(), tail: chunk.tail });

function restore(chunk: Chunk, state: ChunkState): void {
  chunk.data = state.data;
  chunk.tail = state.tail;
  if (state.children) chunk.children = state.children.slice();
  else delete chunk.children;
}

/** Chunk states on either side of a committed change. */
export interface ChunkChange {
  before: Map<Chunk, ChunkState>;
  after: Map<Chunk, ChunkState>;
}

export class Transaction {
  private readonly before = new Map<Chunk, ChunkState>();

  touch(chunk: Chunk): void {
    if (!this.before.has(chunk)) this.before.set(chunk, capture(chunk));
  }

  /** Replaces a leaf body. */
  setData(chunk: Chunk, data: Uint8Array): void {
    this.touch(chunk);
    chunk.data = data;
  }

  /** Copies a leaf body, lets `edit` change the copy, and stores it. */
  patch(chunk: Chunk, edit: (view: DataView, bytes: Uint8Array) => void, minLength = 0): void {
    const bytes = new Uint8Array(Math.max(chunk.data.length, minLength));
    bytes.set(chunk.data);
    edit(new DataView(bytes.buffer), bytes);
    this.setData(chunk, bytes);
  }

  setChildren(chunk: Chunk, children: Chunk[]): void {
    this.touch(chunk);
    chunk.children = children;
  }

  get empty(): boolean {
    return this.before.size === 0;
  }

  commit(): ChunkChange {
    const after = new Map<Chunk, ChunkState>();
    for (const chunk of this.before.keys()) after.set(chunk, capture(chunk));
    return { before: new Map(this.before), after };
  }
}

export function applyStates(states: Map<Chunk, ChunkState>): void {
  for (const [chunk, state] of states) restore(chunk, state);
}

export function leaf(type: string, data: Uint8Array): Chunk {
  return { type, offset: -1, data };
}

export function list(listType: string, children: Chunk[]): Chunk {
  return { type: "LIST", offset: -1, data: new Uint8Array(0), listType, children };
}

export function utf8Chunk(text: string): Chunk {
  return leaf("Utf8", new TextEncoder().encode(text));
}

/** Big-endian doubles, or little-endian inside an orientation. */
export function doubles(values: number[], littleEndian = false): Uint8Array {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setFloat64(i * 8, v, littleEndian));
  return bytes;
}

export function readDoubles(data: Uint8Array, littleEndian = false): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: number[] = [];
  for (let o = 0; o + 8 <= data.length; o += 8) out.push(view.getFloat64(o, littleEndian));
  return out;
}

/** The chain of chunks from `root` down to `target` (both included), or undefined. */
export function chunkPath(root: Chunk, target: Chunk): Chunk[] | undefined {
  if (root === target) return [root];
  for (const c of root.children ?? []) {
    const path = chunkPath(c, target);
    if (path) return [root, ...path];
  }
  return undefined;
}
