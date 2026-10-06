// Baseline TIFF decoding for footage, in the browser: 8/16-bit gray or RGB with
// optional alpha, chunky or planar strips, uncompressed / LZW / Deflate /
// PackBits, horizontal predictor. Samples are returned as stored; whether alpha
// is straight or premultiplied is the footage interpretation's business.
import type { FootageFrame } from "./frames.ts";

function lzwDecode(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let outPos = 0;
  const dict: Uint8Array[] = [];
  const reset = () => {
    dict.length = 258;
    for (let i = 0; i < 256; i++) dict[i] = Uint8Array.of(i);
  };
  reset();
  let bitPos = 0;
  let width = 9;
  let prev: Uint8Array | null = null;
  const totalBits = input.length * 8;
  while (bitPos + width <= totalBits) {
    let code = 0;
    for (let i = 0; i < width; i++) {
      const bit = (input[(bitPos + i) >> 3] >> (7 - ((bitPos + i) & 7))) & 1;
      code = (code << 1) | bit;
    }
    bitPos += width;
    if (code === 257) break;
    if (code === 256) {
      reset();
      width = 9;
      prev = null;
      continue;
    }
    let entry: Uint8Array;
    if (code < dict.length) {
      entry = dict[code];
      if (prev) {
        const added = new Uint8Array(prev.length + 1);
        added.set(prev);
        added[prev.length] = entry[0];
        dict.push(added);
      }
    } else if (prev) {
      entry = new Uint8Array(prev.length + 1);
      entry.set(prev);
      entry[prev.length] = prev[0];
      dict.push(entry);
    } else {
      throw new Error("corrupt LZW stream");
    }
    const n = Math.min(entry.length, expected - outPos);
    out.set(entry.subarray(0, n), outPos);
    outPos += n;
    prev = entry;
    // TIFF LZW switches code width one code early.
    if (dict.length + 1 >= 1 << width && width < 12) width++;
  }
  return out;
}

function packBitsDecode(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0;
  let o = 0;
  while (i < input.length && o < expected) {
    const n = (input[i++] << 24) >> 24;
    if (n >= 0) {
      out.set(input.subarray(i, i + n + 1), o);
      i += n + 1;
      o += n + 1;
    } else if (n !== -128) {
      out.fill(input[i++], o, o + 1 - n);
      o += 1 - n;
    }
  }
  return out;
}

async function inflate(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function isTiff(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 42));
}

export async function decodeTiff(bytes: Uint8Array): Promise<FootageFrame> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[0] === 0x49;
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  if (!isTiff(bytes)) throw new Error("not a TIFF file");
  const ifd = u32(4);
  const tags = new Map<number, number[]>();
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e);
    const type = u16(e + 2);
    const count = u32(e + 4);
    const size = type === 3 ? 2 : type === 4 ? 4 : 1;
    const at = count * size <= 4 ? e + 8 : u32(e + 8);
    const values: number[] = [];
    for (let k = 0; k < count; k++) values.push(size === 2 ? u16(at + k * 2) : size === 4 ? u32(at + k * 4) : bytes[at + k]);
    tags.set(tag, values);
  }
  const get = (tag: number, fallback: number) => tags.get(tag)?.[0] ?? fallback;
  const width = get(256, 0);
  const height = get(257, 0);
  const bits = get(258, 8);
  const compression = get(259, 1);
  const photometric = get(262, 2);
  const spp = get(277, 1);
  const rowsPerStrip = Math.min(get(278, height), height);
  const planar = get(284, 1);
  const predictor = get(317, 1);
  if (tags.has(322)) throw new Error("tiled TIFF files are not supported");
  if (bits !== 8 && bits !== 16) throw new Error(`unsupported TIFF bit depth ${bits}`);
  if (photometric !== 1 && photometric !== 2) throw new Error(`unsupported TIFF photometric interpretation ${photometric}`);
  const offsets = tags.get(273) ?? [];
  const counts = tags.get(279) ?? [];
  const bps = bits / 8;
  const planes = planar === 2 ? spp : 1;
  const samplesPerPlaneRow = (planar === 2 ? 1 : spp) * width;
  const stripsPerPlane = Math.ceil(height / rowsPerStrip);
  const planeData = Array.from({ length: planes }, () => new Uint8Array(samplesPerPlaneRow * height * bps));

  for (let s = 0; s < offsets.length; s++) {
    const plane = Math.floor(s / stripsPerPlane);
    if (plane >= planes) break;
    const firstRow = (s % stripsPerPlane) * rowsPerStrip;
    const rows = Math.min(rowsPerStrip, height - firstRow);
    const expected = rows * samplesPerPlaneRow * bps;
    const raw = bytes.subarray(offsets[s], offsets[s] + counts[s]);
    let strip: Uint8Array;
    if (compression === 1) strip = raw.slice(0, expected);
    else if (compression === 5) strip = lzwDecode(raw, expected);
    else if (compression === 8 || compression === 32946) strip = await inflate(raw);
    else if (compression === 32773) strip = packBitsDecode(raw, expected);
    else throw new Error(`unsupported TIFF compression ${compression}`);
    if (predictor === 2) {
      const stride = planar === 2 ? 1 : spp;
      for (let r = 0; r < rows; r++) {
        if (bps === 1) {
          const row = r * samplesPerPlaneRow;
          for (let i = stride; i < samplesPerPlaneRow; i++) strip[row + i] = (strip[row + i] + strip[row + i - stride]) & 0xff;
        } else {
          const dv = new DataView(strip.buffer, strip.byteOffset, strip.byteLength);
          const row = r * samplesPerPlaneRow * 2;
          for (let i = stride; i < samplesPerPlaneRow; i++) {
            const v = (dv.getUint16(row + i * 2, little) + dv.getUint16(row + (i - stride) * 2, little)) & 0xffff;
            dv.setUint16(row + i * 2, v, little);
          }
        }
      }
    }
    planeData[plane].set(strip.subarray(0, expected), firstRow * samplesPerPlaneRow * bps);
  }

  const data = new Uint8Array(width * height * 4);
  const sample = (plane: Uint8Array, index: number) => {
    if (bps === 1) return plane[index];
    const v = little ? plane[index * 2] | (plane[index * 2 + 1] << 8) : (plane[index * 2] << 8) | plane[index * 2 + 1];
    return Math.round(v / 257);
  };
  const color = photometric === 2 ? 3 : 1;
  for (let p = 0; p < width * height; p++) {
    const channel = (c: number) => (planar === 2 ? sample(planeData[c], p) : sample(planeData[0], p * spp + c));
    const r = channel(0);
    data[p * 4] = r;
    data[p * 4 + 1] = color === 3 ? channel(1) : r;
    data[p * 4 + 2] = color === 3 ? channel(2) : r;
    data[p * 4 + 3] = spp > color ? channel(color) : 255;
  }
  return { kind: "rgba", data, width, height };
}
