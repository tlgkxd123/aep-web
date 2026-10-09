// CPU helpers for fitting Deep Glow 2 offline: dumped sources, references and float Gaussian blurs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

export const GAMMA = 2.2;
export const SRC_DIR = process.env.DG_SRC ?? join(tmpdir(), "dgsrc");

export interface Img {
  width: number;
  height: number;
  /** Premultiplied, 0..1, top row first, 4 channels. */
  data: Float64Array;
}

function toImg(width: number, height: number, bytes: Uint8Array): Img {
  const data = new Float64Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = bytes[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) data[i * 4 + c] = (bytes[i * 4 + c] / 255) * a;
    data[i * 4 + 3] = a;
  }
  return { width, height, data };
}

/** Our render of the comp with the effect skipped (pixel-report --dump with PEDG2 unregistered). */
export function source(comp: string, frame: number): Img {
  const name = readdirSync(SRC_DIR).find((f) => f.startsWith(`${comp}_f${frame}_`));
  if (!name) throw new Error(`no source dump for ${comp}@${frame} in ${SRC_DIR}`);
  const [w, h] = /_(\d+)x(\d+)\.rgba$/.exec(name)!.slice(1).map(Number);
  return toImg(w, h, new Uint8Array(readFileSync(join(SRC_DIR, name))));
}

export function reference(comp: string, frame: number): Img {
  const t = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
  return toImg(t.width, t.height, t.data);
}

/** Separable Gaussian blur of one plane (zero outside), truncated at 4 sigma. */
export function blurPlane(src: Float64Array, w: number, h: number, sigmaX: number, sigmaY = sigmaX): Float64Array {
  const pass = (input: Float64Array, sigma: number, horizontal: boolean) => {
    if (sigma < 0.05) return input.slice();
    const r = Math.ceil(sigma * 4);
    const k = new Float64Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp((-0.5 * i * i) / (sigma * sigma));
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const out = new Float64Array(w * h);
    const n = horizontal ? w : h;
    const lines = horizontal ? h : w;
    for (let l = 0; l < lines; l++) {
      for (let p = 0; p < n; p++) {
        let acc = 0;
        const lo = Math.max(0, p - r);
        const hi = Math.min(n - 1, p + r);
        for (let q = lo; q <= hi; q++) acc += k[q - p + r] * input[horizontal ? l * w + q : q * w + l];
        out[horizontal ? l * w + p : p * w + l] = acc;
      }
    }
    return out;
  };
  return pass(pass(src, sigmaX, true), sigmaY, false);
}

export function plane(img: Img, c: number, map: (v: number) => number = (v) => v): Float64Array {
  const out = new Float64Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) out[i] = map(img.data[i * 4 + c]);
  return out;
}

export const toLin = (v: number) => Math.pow(Math.max(0, v), GAMMA);
export const toGamma = (v: number) => Math.pow(Math.max(0, v), 1 / GAMMA);
