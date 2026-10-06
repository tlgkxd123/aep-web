// 8-bit RGB/RGBA PNG decoder (non-interlaced) that checks every chunk CRC.
import { crc32, inflateSync } from "node:zlib";

export interface DecodedPng {
  width: number;
  height: number;
  /** 2 (RGB) or 6 (RGBA). */
  colorType: number;
  /** Pixels as RGBA, alpha 255 for RGB images. */
  rgba: Uint8Array;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => buf[i] === b)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  let ended = false;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    const crc = buf.readUInt32BE(offset + 8 + length);
    if (crc32(buf.subarray(offset + 4, offset + 8 + length)) !== crc) throw new Error(`bad CRC in ${type}`);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`bit depth ${data[8]}`);
      colorType = data[9];
      if (colorType !== 2 && colorType !== 6) throw new Error(`colour type ${colorType}`);
      if (data[12] !== 0) throw new Error("interlaced PNG");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") {
      ended = true;
      break;
    }
    offset += 12 + length;
  }
  if (!ended) throw new Error("missing IEND");
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error(`IDAT holds ${raw.length} bytes, expected ${(stride + 1) * height}`);
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? pixels[row + i - bpp] : 0;
      const b = y > 0 ? pixels[row - stride + i] : 0;
      const c = i >= bpp && y > 0 ? pixels[row - stride + i - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`filter ${filter}`);
      pixels[row + i] = (src[i] + predictor) & 0xff;
    }
  }
  if (bpp === 4) return { width, height, colorType, rgba: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0, q = 0; p < pixels.length; p += 3, q += 4) {
    rgba[q] = pixels[p];
    rgba[q + 1] = pixels[p + 1];
    rgba[q + 2] = pixels[p + 2];
    rgba[q + 3] = 255;
  }
  return { width, height, colorType, rgba };
}
