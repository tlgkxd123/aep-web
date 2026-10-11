// RIFX (big-endian RIFF) chunk tree reader for After Effects project files.

export interface Chunk {
  type: string;
  /** Absolute file offset of the 8-byte chunk header. */
  offset: number;
  /** Body bytes. For LIST/RIFX chunks this excludes the 4-byte list type. */
  data: Uint8Array;
  listType?: string;
  children?: Chunk[];
  /** Set when the declared size overruns the parent; the tree below is partial. */
  error?: string;
  /** Non-zero value of the pad byte that follows an odd-sized body. */
  pad?: number;
  /** Bytes after the last whole child chunk of a container body. */
  tail?: Uint8Array;
}

/** Chunks whose body is a run of child chunks without a list-type prefix. */
const CONTAINER_TYPES = new Set(["fnam", "pdnm", "RCom", "tdsn", "vfdn"]);
/** LIST subtypes whose body is opaque binary rather than child chunks. */
const OPAQUE_LIST_TYPES = new Set(["btdk"]);

const ascii = new TextDecoder("latin1");

/** A chunk type. A project holds hundreds of thousands, so the ASCII ones skip the decoder (which reads them alike). */
function fourCC(bytes: Uint8Array, at: number): string {
  if (at + 4 <= bytes.length) {
    const a = bytes[at];
    const b = bytes[at + 1];
    const c = bytes[at + 2];
    const d = bytes[at + 3];
    if ((a | b | c | d) < 0x80) return String.fromCharCode(a, b, c, d);
  }
  return ascii.decode(bytes.subarray(at, at + 4));
}

function readChildren(file: Uint8Array, view: DataView, start: number, end: number): { chunks: Chunk[]; tail?: Uint8Array } {
  const chunks: Chunk[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const type = fourCC(file, pos);
    const size = view.getUint32(pos + 4, false);
    const bodyStart = pos + 8;
    let bodyEnd = bodyStart + size;
    let error: string | undefined;
    if (bodyEnd > end) {
      error = `chunk ${type} at ${pos} declares ${size} bytes but only ${end - bodyStart} remain`;
      bodyEnd = end;
    }
    const chunk = buildChunk(file, view, type, pos, bodyStart, bodyEnd, error);
    if (size & 1 && bodyEnd < end && file[bodyEnd] !== 0) chunk.pad = file[bodyEnd];
    chunks.push(chunk);
    if (error) return { chunks };
    pos = bodyEnd + (size & 1);
  }
  return pos < end ? { chunks, tail: file.subarray(pos, end) } : { chunks };
}

function buildChunk(
  file: Uint8Array,
  view: DataView,
  type: string,
  offset: number,
  bodyStart: number,
  bodyEnd: number,
  error: string | undefined,
): Chunk {
  if ((type === "LIST" || type === "RIFX") && bodyEnd - bodyStart >= 4) {
    const listType = fourCC(file, bodyStart);
    const data = file.subarray(bodyStart + 4, bodyEnd);
    if (OPAQUE_LIST_TYPES.has(listType)) return { type, offset, data, listType, error };
    const { chunks, tail } = readChildren(file, view, bodyStart + 4, bodyEnd);
    return { type, offset, data, listType, children: chunks, error, ...(tail && { tail }) };
  }
  const data = file.subarray(bodyStart, bodyEnd);
  if (CONTAINER_TYPES.has(type)) {
    const { chunks, tail } = readChildren(file, view, bodyStart, bodyEnd);
    return { type, offset, data, children: chunks, error, ...(tail && { tail }) };
  }
  return { type, offset, data, error };
}

export interface RifxFile {
  root: Chunk;
  /** XMP metadata packet appended after the RIFX chunk. */
  xmp: string;
  /** The raw bytes after the RIFX chunk (the XMP packet as stored). */
  trailer: Uint8Array;
}

export function readRifx(bytes: Uint8Array): RifxFile {
  if (bytes.length < 12 || fourCC(bytes, 0) !== "RIFX") {
    throw new Error("Not an After Effects project: missing RIFX header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(4, false);
  const end = Math.min(8 + size, bytes.length);
  const error = 8 + size > bytes.length ? "RIFX size exceeds file length" : undefined;
  const root = buildChunk(bytes, view, "RIFX", 0, 8, end, error);
  if (size & 1 && end < bytes.length && bytes[end] !== 0) root.pad = bytes[end];
  const trailer = bytes.subarray(Math.min(bytes.length, end + (size & 1)));
  return { root, xmp: new TextDecoder("utf-8").decode(trailer), trailer };
}

export function findChild(parent: Chunk | undefined, type: string): Chunk | undefined {
  return parent?.children?.find((c) => c.type === type);
}

export function findList(parent: Chunk | undefined, listType: string): Chunk | undefined {
  return parent?.children?.find((c) => c.type === "LIST" && c.listType === listType);
}

export function filterLists(parent: Chunk | undefined, listType: string): Chunk[] {
  return parent?.children?.filter((c) => c.type === "LIST" && c.listType === listType) ?? [];
}

export function chunkLabel(chunk: Chunk): string {
  return chunk.listType ? `${chunk.type}:${chunk.listType}` : chunk.type;
}
