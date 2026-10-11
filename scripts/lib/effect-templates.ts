// Effect templates (src/edit/effectTemplates.ts) packed as their chunks, gzipped in one
// base64 string, with [offset, length] pairs into it.
import { gzipSync } from "node:zlib";
import type { Chunk } from "../../src/aep/riff.ts";
import { writeChunkBytes } from "../../src/aep/write.ts";

/** Packs chunks into one gzipped blob, returning [offset, length] for each. */
export class ChunkPacker {
  private parts: Uint8Array[] = [];
  private offset = 0;

  add(chunk: Chunk): [number, number] {
    const bytes = writeChunkBytes(chunk);
    this.parts.push(bytes);
    const at: [number, number] = [this.offset, bytes.length];
    this.offset += bytes.length;
    return at;
  }

  /** The raw byte count and the gzipped blob as base64. */
  pack(): { raw: number; gzipped: number; base64: string } {
    const raw = Buffer.concat(this.parts);
    const packed = gzipSync(raw, { level: 9 });
    return { raw: raw.length, gzipped: packed.length, base64: packed.toString("base64") };
  }
}
