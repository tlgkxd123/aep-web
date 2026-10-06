/** BT.709 limited-range YUV, the colour signalled in the MP4 `colr` box and WebM Colour element. */
export const BT709 = { matrix: "bt709", transfer: "bt709", primaries: "bt709", fullRange: false } as const;
/** The same colour as ISO/IEC 23091-2 code points, as Matroska and MP4 store them. */
export const BT709_CODES = { matrix: 1, transfer: 1, primaries: 1, fullRange: false } as const;

export interface I420 {
  data: Uint8Array;
  width: number;
  height: number;
  layout: { offset: number; stride: number }[];
}

function planes(width: number, height: number): { size: number; layout: I420["layout"] } {
  const cw = (width + 1) >> 1;
  const ch = (height + 1) >> 1;
  const y = width * height;
  return { size: y + 2 * cw * ch, layout: [{ offset: 0, stride: width }, { offset: y, stride: cw }, { offset: y + cw * ch, stride: cw }] };
}

const S = 1 << 16;
const YR = Math.round(((219 / 255) * 0.2126) * S);
const YG = Math.round(((219 / 255) * 0.7152) * S);
const YB = Math.round(((219 / 255) * 0.0722) * S);
const UR = Math.round(((224 / 255) * -0.2126 / 1.8556) * S);
const UG = Math.round(((224 / 255) * -0.7152 / 1.8556) * S);
const UB = Math.round(((224 / 255) * 0.5) * S);
const VR = Math.round(((224 / 255) * 0.5) * S);
const VG = Math.round(((224 / 255) * -0.7152 / 1.5748) * S);
const VB = Math.round(((224 / 255) * -0.0722 / 1.5748) * S);
const HALF = S >> 1;

/** Opaque RGB (alpha ignored) to BT.709 limited-range I420; chroma is the mean of each 2x2 block. */
export function rgbToI420(rgba: Uint8Array, width: number, height: number): I420 {
  const { size, layout } = planes(width, height);
  const data = new Uint8Array(size);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    data[i] = (16 * S + YR * rgba[p] + YG * rgba[p + 1] + YB * rgba[p + 2] + HALF) >> 16;
  }
  const cw = layout[1].stride;
  for (let cy = 0; cy < (height + 1) >> 1; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) {
        const y = 2 * cy + dy;
        if (y >= height) continue;
        for (let dx = 0; dx < 2; dx++) {
          const x = 2 * cx + dx;
          if (x >= width) continue;
          const p = (y * width + x) * 4;
          r += rgba[p];
          g += rgba[p + 1];
          b += rgba[p + 2];
          n++;
        }
      }
      const o = cy * cw + cx;
      data[layout[1].offset + o] = Math.min(255, Math.max(0, Math.round((128 * S * n + UR * r + UG * g + UB * b) / (S * n))));
      data[layout[2].offset + o] = Math.min(255, Math.max(0, Math.round((128 * S * n + VR * r + VG * g + VB * b) / (S * n))));
    }
  }
  return { data, width, height, layout };
}

/** The alpha channel as an I420 picture whose luma is alpha and whose chroma is neutral, as WebM alpha streams carry it. */
export function alphaToI420(rgba: Uint8Array, width: number, height: number): I420 {
  const { size, layout } = planes(width, height);
  const data = new Uint8Array(size).fill(128, layout[1].offset);
  for (let i = 0, p = 3; i < width * height; i++, p += 4) data[i] = rgba[p];
  return { data, width, height, layout };
}

/** Inverse of `rgbToI420` for one pixel, used to compare decoded video with rendered frames. */
export function yuvToRgb(y: number, u: number, v: number): [number, number, number] {
  const c = 1.164383 * (y - 16);
  const d = u - 128;
  const e = v - 128;
  const clamp = (n: number) => Math.min(255, Math.max(0, Math.round(n)));
  return [clamp(c + 1.792741 * e), clamp(c - 0.213249 * d - 0.532909 * e), clamp(c + 2.112402 * d)];
}
