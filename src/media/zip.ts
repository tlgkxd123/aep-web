// ZIP archives, for projects saved with their footage. Footage is stored as is
// (media is compressed already) and the archive is a Blob made of the footage's
// own Blobs, so gigabytes of video are never copied into memory; reading slices
// the archive the same way. ZIP64 records take over past 4 GiB or 65535 entries.
import { deflateSync, inflateSync } from "fflate";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const UTF8_NAMES = 0x0800;
const ENCRYPTED = 0x0001;
const STORE = 0;
const DEFLATE = 8;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const VERSION = 20;
const VERSION64 = 45;
/** Bytes read at a time to checksum a Blob. */
const CHUNK = 8 << 20;
/** The end record and the longest comment it can carry. */
const MAX_TAIL = 22 + MAX16;

export interface ZipInput {
  /** "/"-separated path inside the archive. */
  path: string;
  data: Blob | Uint8Array;
  /** Modification time in ms since the epoch; now when omitted. */
  modified?: number;
  /** Deflates the entry (byte data only). */
  compress?: boolean;
}

export interface ZipOutput {
  blob: Blob;
  /** Where each input's data starts in `blob` (its stored or deflated bytes). */
  offsets: number[];
}

export interface ZipWriteOptions {
  /** Writes ZIP64 records even when the archive does not need them. */
  zip64?: boolean;
  /** Called as entries are checksummed, with the bytes done and the total. */
  onProgress?: (done: number, total: number) => void;
}

/** Byte data, whichever realm made the array (an iframe's or a test environment's). */
const isBytes = (data: Blob | Uint8Array): data is Uint8Array => ArrayBuffer.isView(data);

const CRC_TABLES = (() => {
  const t = new Int32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) for (let k = 1; k < 8; k++) t[k * 256 + n] = (t[(k - 1) * 256 + n] >>> 8) ^ t[t[(k - 1) * 256 + n] & 0xff];
  return t;
})();

/** CRC-32 of `bytes`, continuing from `crc` (slicing by 8). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  const t = CRC_TABLES;
  let c = ~crc;
  let i = 0;
  const end8 = bytes.length - 8;
  for (; i <= end8; i += 8) {
    const a = c ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
    c =
      t[1792 + (a & 0xff)] ^ t[1536 + ((a >>> 8) & 0xff)] ^ t[1280 + ((a >>> 16) & 0xff)] ^ t[1024 + (a >>> 24)] ^
      t[768 + bytes[i + 4]] ^ t[512 + bytes[i + 5]] ^ t[256 + bytes[i + 6]] ^ t[bytes[i + 7]];
  }
  for (; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

async function blobCrc(blob: Blob, progress: (bytes: number) => void): Promise<number> {
  let crc = 0;
  for (let at = 0; at < blob.size; at += CHUNK) {
    const bytes = new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer());
    crc = crc32(bytes, crc);
    progress(bytes.length);
  }
  return crc;
}

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

class Writer {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private at = 0;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(v: number) {
    this.view.setUint16(this.at, v, true);
    this.at += 2;
  }
  u32(v: number) {
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
  }
  u64(v: number) {
    this.view.setBigUint64(this.at, BigInt(v), true);
    this.at += 8;
  }
  raw(b: Uint8Array) {
    this.bytes.set(b, this.at);
    this.at += b.length;
  }
}

interface Prepared {
  name: Uint8Array;
  data: Blob | Uint8Array;
  method: number;
  crc: number;
  size: number;
  stored: number;
  time: number;
  date: number;
}

/** Writes an archive of `inputs`, in order. */
export async function writeZip(inputs: readonly ZipInput[], options: ZipWriteOptions = {}): Promise<ZipOutput> {
  const encoder = new TextEncoder();
  const total = inputs.reduce((n, e) => n + (isBytes(e.data) ? e.data.length : e.data.size), 0);
  let done = 0;
  const progress = (bytes: number) => {
    done += bytes;
    options.onProgress?.(done, total);
  };
  const prepared: Prepared[] = [];
  for (const input of inputs) {
    const path = input.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path) throw new Error("An archive entry has no name");
    const { time, date } = dosTime(input.modified ?? Date.now());
    let crc: number;
    let data = input.data;
    let method = STORE;
    let size: number;
    if (isBytes(data)) {
      size = data.length;
      crc = crc32(data);
      progress(size);
      if (input.compress) {
        data = deflateSync(data);
        method = DEFLATE;
      }
    } else {
      size = data.size;
      crc = await blobCrc(data, progress);
    }
    const stored = isBytes(data) ? data.length : data.size;
    prepared.push({ name: encoder.encode(path), data, method, crc, size, stored, time, date });
  }

  const parts: BlobPart[] = [];
  const offsets: number[] = [];
  const locals: number[] = [];
  let offset = 0;
  for (const e of prepared) {
    const big = options.zip64 || e.size >= MAX32 || e.stored >= MAX32;
    const header = new Writer(30 + e.name.length + (big ? 20 : 0));
    header.u32(LOCAL);
    header.u16(big ? VERSION64 : VERSION);
    header.u16(UTF8_NAMES);
    header.u16(e.method);
    header.u16(e.time);
    header.u16(e.date);
    header.u32(e.crc);
    header.u32(big ? MAX32 : e.stored);
    header.u32(big ? MAX32 : e.size);
    header.u16(e.name.length);
    header.u16(big ? 20 : 0);
    header.raw(e.name);
    if (big) {
      header.u16(ZIP64_EXTRA);
      header.u16(16);
      header.u64(e.size);
      header.u64(e.stored);
    }
    locals.push(offset);
    parts.push(header.bytes as BlobPart, e.data as BlobPart);
    offset += header.bytes.length;
    offsets.push(offset);
    offset += e.stored;
  }

  const centralStart = offset;
  let centralSize = 0;
  let any64 = !!options.zip64;
  for (const [i, e] of prepared.entries()) {
    const fields: number[] = [];
    const sizes = options.zip64 || e.size >= MAX32 || e.stored >= MAX32;
    if (sizes) fields.push(e.size, e.stored);
    const far = options.zip64 || locals[i] >= MAX32;
    if (far) fields.push(locals[i]);
    const extra = fields.length ? 4 + fields.length * 8 : 0;
    if (extra) any64 = true;
    const record = new Writer(46 + e.name.length + extra);
    record.u32(CENTRAL);
    record.u16(VERSION64);
    record.u16(extra ? VERSION64 : VERSION);
    record.u16(UTF8_NAMES);
    record.u16(e.method);
    record.u16(e.time);
    record.u16(e.date);
    record.u32(e.crc);
    record.u32(sizes ? MAX32 : e.stored);
    record.u32(sizes ? MAX32 : e.size);
    record.u16(e.name.length);
    record.u16(extra);
    record.u16(0);
    record.u16(0);
    record.u16(0);
    record.u32(0);
    record.u32(far ? MAX32 : locals[i]);
    record.raw(e.name);
    if (extra) {
      record.u16(ZIP64_EXTRA);
      record.u16(fields.length * 8);
      for (const f of fields) record.u64(f);
    }
    parts.push(record.bytes as BlobPart);
    centralSize += record.bytes.length;
  }

  const count = prepared.length;
  const needs64 = any64 || count >= MAX16 || centralStart >= MAX32 || centralSize >= MAX32;
  if (needs64) {
    const end64 = new Writer(56 + 20);
    end64.u32(END64);
    end64.u64(44);
    end64.u16(VERSION64);
    end64.u16(VERSION64);
    end64.u32(0);
    end64.u32(0);
    end64.u64(count);
    end64.u64(count);
    end64.u64(centralSize);
    end64.u64(centralStart);
    end64.u32(LOCATOR64);
    end64.u32(0);
    end64.u64(centralStart + centralSize);
    end64.u32(1);
    parts.push(end64.bytes as BlobPart);
  }
  const end = new Writer(22);
  end.u32(END);
  end.u16(0);
  end.u16(0);
  end.u16(needs64 ? MAX16 : count);
  end.u16(needs64 ? MAX16 : count);
  end.u32(needs64 ? MAX32 : centralSize);
  end.u32(needs64 ? MAX32 : centralStart);
  end.u16(0);
  parts.push(end.bytes as BlobPart);
  return { blob: new Blob(parts, { type: "application/zip" }), offsets };
}

export interface ZipEntry {
  /** "/"-separated path inside the archive. */
  path: string;
  /** Uncompressed size. */
  size: number;
  /** Whether the entry is stored as is (reading it is a slice of the archive). */
  stored: boolean;
  /** The entry's contents. */
  read(): Promise<Blob>;
}

async function bytesAt(blob: Blob, start: number, length: number): Promise<DataView> {
  const buffer = await blob.slice(start, start + length).arrayBuffer();
  if (buffer.byteLength < length) throw new Error("The archive is truncated");
  return new DataView(buffer);
}

const u64 = (view: DataView, at: number) => Number(view.getBigUint64(at, true));

function entryName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder("latin1").decode(bytes);
    }
  }
  return new TextDecoder().decode(bytes);
}

async function inflate(slice: Blob): Promise<Blob> {
  if (typeof DecompressionStream === "function" && typeof slice.stream === "function") {
    try {
      return await new Response(slice.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
    } catch {
      // Browsers without "deflate-raw" fall through to the JavaScript decoder.
    }
  }
  return new Blob([inflateSync(new Uint8Array(await slice.arrayBuffer())) as BlobPart]);
}

/** Lists the files of an archive (folders left out). Throws when `archive` is not a ZIP archive. */
export async function readZip(archive: Blob): Promise<ZipEntry[]> {
  const tailLength = Math.min(archive.size, MAX_TAIL);
  const tail = await bytesAt(archive, archive.size - tailLength, tailLength);
  let endAt = -1;
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === END && i + 22 + tail.getUint16(i + 20, true) <= tailLength) {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) throw new Error("This is not a ZIP archive");
  let count = tail.getUint16(endAt + 10, true);
  let centralSize = tail.getUint32(endAt + 12, true);
  let centralStart = tail.getUint32(endAt + 16, true);
  const endOffset = archive.size - tailLength + endAt;
  if ((count === MAX16 || centralSize === MAX32 || centralStart === MAX32) && endOffset >= 20) {
    const locator = await bytesAt(archive, endOffset - 20, 20);
    if (locator.getUint32(0, true) === LOCATOR64) {
      const end64 = await bytesAt(archive, u64(locator, 8), 56);
      if (end64.getUint32(0, true) !== END64) throw new Error("The archive's ZIP64 directory is damaged");
      count = u64(end64, 32);
      centralSize = u64(end64, 40);
      centralStart = u64(end64, 48);
    }
  }
  const central = await bytesAt(archive, centralStart, centralSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (central.getUint32(p, true) !== CENTRAL) throw new Error("The archive's directory is damaged");
    const flags = central.getUint16(p + 8, true);
    const method = central.getUint16(p + 10, true);
    let stored = central.getUint32(p + 20, true);
    let size = central.getUint32(p + 24, true);
    const nameLength = central.getUint16(p + 28, true);
    const extraLength = central.getUint16(p + 30, true);
    const commentLength = central.getUint16(p + 32, true);
    let local = central.getUint32(p + 42, true);
    const nameBytes = new Uint8Array(central.buffer, central.byteOffset + p + 46, nameLength);
    for (let e = p + 46 + nameLength; e + 4 <= p + 46 + nameLength + extraLength; ) {
      const id = central.getUint16(e, true);
      const length = central.getUint16(e + 2, true);
      if (id === ZIP64_EXTRA) {
        let f = e + 4;
        if (size === MAX32) (size = u64(central, f)), (f += 8);
        if (stored === MAX32) (stored = u64(central, f)), (f += 8);
        if (local === MAX32) local = u64(central, f);
      }
      e += 4 + length;
    }
    p += 46 + nameLength + extraLength + commentLength;
    const path = entryName(nameBytes, (flags & UTF8_NAMES) !== 0).replace(/\\/g, "/").replace(/^(\.?\/)+/, "");
    if (!path || path.endsWith("/")) continue;
    const at = local;
    const length = stored;
    entries.push({
      path,
      size,
      stored: method === STORE,
      read: async () => {
        if (flags & ENCRYPTED) throw new Error(`${path} is encrypted`);
        const header = await bytesAt(archive, at, 30);
        if (header.getUint32(0, true) !== LOCAL) throw new Error(`The archive's entry for ${path} is damaged`);
        const start = at + 30 + header.getUint16(26, true) + header.getUint16(28, true);
        const slice = archive.slice(start, start + length);
        if (method === STORE) return slice;
        if (method === DEFLATE) return inflate(slice);
        throw new Error(`${path} is compressed with a method this app cannot read`);
      },
    });
  }
  return entries;
}

/** Whether the bytes start like a ZIP archive. */
export const isZipHeader = (head: Uint8Array) => head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5) && head[3] === head[2] + 1;
