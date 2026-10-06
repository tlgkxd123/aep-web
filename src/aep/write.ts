// RIFX (big-endian RIFF) chunk tree writer: the inverse of riff.ts. Bodies are
// rebuilt from the leaves, so a tree whose leaves were replaced serializes with
// every enclosing size updated.
import type { Chunk, RifxFile } from "./riff.ts";

const ascii = (text: string, into: Uint8Array, at: number) => {
  for (let i = 0; i < 4; i++) into[at + i] = text.charCodeAt(i) & 0xff;
};

function bodySize(chunk: Chunk): number {
  if (!chunk.children) return (chunk.listType !== undefined ? 4 : 0) + chunk.data.length;
  let size = chunk.listType !== undefined ? 4 : 0;
  for (const child of chunk.children) size += chunkSize(child);
  return size + (chunk.tail?.length ?? 0);
}

/** Header, body and pad byte. */
export function chunkSize(chunk: Chunk): number {
  const body = bodySize(chunk);
  return 8 + body + (body & 1);
}

function writeChunk(chunk: Chunk, out: Uint8Array, view: DataView, at: number): number {
  const body = bodySize(chunk);
  ascii(chunk.type, out, at);
  view.setUint32(at + 4, body, false);
  let pos = at + 8;
  if (chunk.listType !== undefined) {
    ascii(chunk.listType, out, pos);
    pos += 4;
  }
  if (chunk.children) {
    for (const child of chunk.children) pos = writeChunk(child, out, view, pos);
    if (chunk.tail) {
      out.set(chunk.tail, pos);
      pos += chunk.tail.length;
    }
  } else {
    out.set(chunk.data, pos);
    pos += chunk.data.length;
  }
  if (body & 1) out[pos++] = chunk.pad ?? 0;
  return pos;
}

/** Serializes one chunk (header included). */
export function writeChunkBytes(chunk: Chunk): Uint8Array {
  const out = new Uint8Array(chunkSize(chunk));
  writeChunk(chunk, out, new DataView(out.buffer), 0);
  return out;
}

/** Serializes a project file: the RIFX tree followed by its XMP trailer. */
export function writeRifx(file: RifxFile): Uint8Array {
  const size = chunkSize(file.root);
  const out = new Uint8Array(size + file.trailer.length);
  writeChunk(file.root, out, new DataView(out.buffer), 0);
  out.set(file.trailer, size);
  return out;
}
