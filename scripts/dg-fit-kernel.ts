// Fits Deep Glow 2's kernel per Radius as non-negative weights of a Gaussian basis
// (sigma = 0.5 * 2^(j/2)) to the deepglow_dot / deepglow_dot_hot references
// (a 4x4 white square at the centre of 256x256, Exposure 1 and 20), in gamma-2.2 units.
//
//   node scripts/dg-fit-kernel.ts [frames a,b,..]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

export function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

/** Gaussian (sigma) blur of the box [a0, a1) sampled at x (1D). */
export function boxBlur(x: number, a0: number, a1: number, sigma: number): number {
  const k = 1 / (sigma * Math.SQRT2);
  return 0.5 * (erf((a1 - x) * k) - erf((a0 - x) * k));
}

/** Non-negative least squares by projected coordinate descent on the normal equations. */
export function nnls(rows: Float64Array[], rhs: number[], n: number, iterations = 4000): number[] {
  const ata = Array.from({ length: n }, () => new Float64Array(n));
  const atb = new Float64Array(n);
  rows.forEach((r, i) => {
    for (let a = 0; a < n; a++) {
      if (!r[a]) continue;
      atb[a] += r[a] * rhs[i];
      for (let b = 0; b < n; b++) ata[a][b] += r[a] * r[b];
    }
  });
  const w = new Array(n).fill(0);
  for (let it = 0; it < iterations; it++) {
    for (let a = 0; a < n; a++) {
      if (ata[a][a] <= 0) continue;
      let g = atb[a];
      for (let b = 0; b < n; b++) if (b !== a) g -= ata[a][b] * w[b];
      w[a] = Math.max(0, g / ata[a][a]);
    }
  }
  return w;
}

const GAMMA = 2.2;
// DG_BASIS="s0,ratio,count" picks another basis grid.
const [s0, ratio, count] = (process.env.DG_BASIS ?? "0.5,1.41421356,24").split(",").map(Number);
const SIGMAS = Array.from({ length: count }, (_, j) => s0 * Math.pow(ratio, j));

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const frames = (process.argv[2] ?? "0,1,2,3,4,5,6").split(",").map(Number);
  const radii = [8, 16, 32, 64, 128, 256, 512];
  for (const f of frames) {
    const rows: Float64Array[] = [];
    const rhs: number[] = [];
    const meta: { v: number; e: number; basis: Float64Array }[] = [];
    // DG_COMP="comp:exposure" fits one other dot comp; DG_CH picks the channel.
    const comps = process.env.DG_COMP
      ? [[process.env.DG_COMP.split(":")[0], Number(process.env.DG_COMP.split(":")[1])] as const]
      : ([["deepglow_dot", 1], ["deepglow_dot_hot", 20]] as const);
    const ch = Number(process.env.DG_CH ?? 1);
    for (const [comp, exposure] of comps) {
      const t = readTiff(new Uint8Array(readFileSync(framePath(comp, f))));
      for (let y = 128; y < 256; y++) {
        for (let x = y; x < 256; x++) {
          if (x < 130 && y < 130) continue;
          const v = t.data[(y * t.width + x) * 4 + ch];
          if (v >= 255) continue;
          const lin = Math.pow(v / 255, GAMMA);
          const basis = new Float64Array(SIGMAS.length);
          SIGMAS.forEach((s, j) => (basis[j] = exposure * boxBlur(x + 0.5, 126, 130, s) * boxBlur(y + 0.5, 126, 130, s)));
          // Residuals in 8-bit gamma units: d(255 lin^(1/g)) / d lin, floored at the first code value.
          const scale = (255 / GAMMA) * Math.pow(Math.max(lin, Math.pow(0.5 / 255, GAMMA)), 1 / GAMMA - 1);
          rows.push(basis.map((b) => b * scale));
          rhs.push(lin * scale);
          meta.push({ v, e: exposure, basis });
        }
      }
    }
    const w = nnls(rows, rhs, SIGMAS.length);
    let sum = 0;
    let max = 0;
    for (const m of meta) {
      const lin = m.basis.reduce((s, b, j) => s + b * w[j], 0);
      const v = 255 * Math.pow(Math.min(1, lin), 1 / GAMMA);
      const d = Math.abs(Math.round(v) - m.v);
      sum += d;
      max = Math.max(max, d);
    }
    const total = w.reduce((a, b) => a + b, 0);
    console.log(`R=${radii[f]} mean ${(sum / meta.length).toFixed(3)} max ${max} total weight ${total.toFixed(3)}`);
    console.log("  " + SIGMAS.map((s, j) => (w[j] > 1e-4 ? `${s.toFixed(1)}:${w[j].toFixed(4)}` : "")).filter(Boolean).join("  "));
  }
}
