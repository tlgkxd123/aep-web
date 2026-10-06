import { zlibSync } from "fflate";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Encodes straight RGBA pixels (rows top to bottom) as an 8-bit PNG, RGB or RGBA.
 * Every row uses the Paeth filter, which suits both flat graphics and gradients.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array, channels: "rgb" | "rgba", level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  const bpp = channels === "rgba" ? 4 : 3;
  const stride = width * bpp;
  const raw = new Uint8Array((stride + 1) * height);
  const prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    if (bpp === 4) row.set(rgba.subarray(src, src + stride));
    else for (let x = 0, o = 0; x < width; x++, o += 3) {
      row[o] = rgba[src + x * 4];
      row[o + 1] = rgba[src + x * 4 + 1];
      row[o + 2] = rgba[src + x * 4 + 2];
    }
    const dst = y * (stride + 1);
    raw[dst] = 4;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const c = i >= bpp ? prev[i - bpp] : 0;
      raw[dst + 1 + i] = (row[i] - paeth(a, prev[i], c)) & 0xff;
    }
    prev.set(row);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = bpp === 4 ? 6 : 2;
  const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", header), chunk("IDAT", zlibSync(raw, { level })), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
