// Photoshop documents imported as merged footage: decodes the flattened
// composite image stored after the layer data (PSD and PSB, RGB or grayscale,
// 8 or 16 bits, raw or PackBits). Layers are not composited here.
import type { FootageFrame } from "./frames.ts";

export function isPsd(bytes: Uint8Array): boolean {
  return bytes.length >= 26 && bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53;
}

export function decodePsd(bytes: Uint8Array): FootageFrame {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isPsd(bytes)) throw new Error("not a Photoshop file");
  const version = view.getUint16(4);
  const big = version === 2;
  const channels = view.getUint16(12);
  const height = view.getUint32(14);
  const width = view.getUint32(18);
  const depth = view.getUint16(22);
  const mode = view.getUint16(24);
  if (mode !== 1 && mode !== 3) throw new Error(`unsupported Photoshop colour mode ${mode}`);
  if (depth !== 8 && depth !== 16) throw new Error(`unsupported Photoshop bit depth ${depth}`);
  let at = 26;
  at += 4 + view.getUint32(at); // colour mode data
  at += 4 + view.getUint32(at); // image resources
  at += big ? 8 + Number(view.getBigUint64(at)) : 4 + view.getUint32(at); // layer and mask information
  const compression = view.getUint16(at);
  at += 2;
  const bps = depth / 8;
  const rowBytes = width * bps;
  const planes: Uint8Array[] = [];
  if (compression === 0) {
    for (let c = 0; c < channels; c++) planes.push(bytes.subarray(at + c * rowBytes * height, at + (c + 1) * rowBytes * height));
  } else if (compression === 1) {
    const countSize = big ? 4 : 2;
    const counts = Array.from({ length: channels * height }, (_, i) => (big ? view.getUint32(at + i * 4) : view.getUint16(at + i * 2)));
    let data = at + channels * height * countSize;
    for (let c = 0; c < channels; c++) {
      const plane = new Uint8Array(rowBytes * height);
      for (let r = 0; r < height; r++) {
        const end = data + counts[c * height + r];
        let o = r * rowBytes;
        const rowEnd = o + rowBytes;
        while (data < end && o < rowEnd) {
          const n = (bytes[data++] << 24) >> 24;
          if (n >= 0) {
            plane.set(bytes.subarray(data, data + n + 1), o);
            data += n + 1;
            o += n + 1;
          } else if (n !== -128) {
            plane.fill(bytes[data++], o, o + 1 - n);
            o += 1 - n;
          }
        }
        data = end;
      }
      planes.push(plane);
    }
  } else {
    throw new Error(`unsupported Photoshop compression ${compression}`);
  }
  const color = mode === 3 ? 3 : 1;
  const sample = (plane: Uint8Array, i: number) => (bps === 1 ? plane[i] : Math.round(((plane[i * 2] << 8) | plane[i * 2 + 1]) / 257));
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const r = sample(planes[0], p);
    data[p * 4] = r;
    data[p * 4 + 1] = color === 3 ? sample(planes[1], p) : r;
    data[p * 4 + 2] = color === 3 ? sample(planes[2], p) : r;
    data[p * 4 + 3] = channels > color ? sample(planes[color], p) : 255;
  }
  return { kind: "rgba", data, width, height };
}
