// Fits 1D kernels to a blurnoise reference's response to a one-pixel white line: a Gaussian and box blurs of 1 to 4
// passes with a fractional half-width, printing each model's best parameter and its error in levels.
//
//   node scripts/check-blurnoise-kernel.ts <comp> <frame> <row|col> <index> <centre> <reach> [channel]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, axis, indexArg, centreArg, reachArg, channel = "a"] = process.argv.slice(2);
if (!comp || !reachArg) throw new Error("usage: node scripts/check-blurnoise-kernel.ts <comp> <frame> <row|col> <index> <centre> <reach> [channel]");
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const c = "rgba".indexOf(channel);
const index = Number(indexArg);
const centre = Number(centreArg);
const reach = Number(reachArg);
const sample = (o: number) => {
  const x = axis === "row" ? centre + o : index;
  const y = axis === "row" ? index : centre + o;
  const i = (y * ref.width + x) * 4;
  return c === 3 ? ref.data[i + 3] : (ref.data[i + c] * ref.data[i + 3]) / 255;
};
const measured = Array.from({ length: 2 * reach + 1 }, (_, i) => sample(i - reach));

function convolve(a: number[], b: number[]): number[] {
  const out = new Array(a.length + b.length - 1).fill(0);
  a.forEach((x, i) => b.forEach((y, j) => (out[i + j] += x * y)));
  return out;
}

function box(half: number): number[] {
  const n = Math.ceil(half + 0.5);
  const w = Array.from({ length: 2 * n + 1 }, (_, i) => Math.min(1, Math.max(0, half + 0.5 - Math.abs(i - n))));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / s);
}

function gaussian(sigma: number): number[] {
  const n = Math.ceil(4 * sigma) + 1;
  const w = Array.from({ length: 2 * n + 1 }, (_, i) => Math.exp(-0.5 * ((i - n) / sigma) ** 2));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / s);
}

function error(kernel: number[]): { rms: number; max: number } {
  const n = (kernel.length - 1) / 2;
  let sq = 0;
  let max = 0;
  measured.forEach((m, i) => {
    const k = i - reach + n;
    const v = k >= 0 && k < kernel.length ? kernel[k] * 255 : 0;
    sq += (v - m) ** 2;
    max = Math.max(max, Math.abs(v - m));
  });
  return { rms: Math.sqrt(sq / measured.length), max };
}

function fit(label: string, make: (t: number) => number[], lo: number, hi: number) {
  let best = { t: lo, rms: Infinity, max: 0 };
  for (let t = lo; t <= hi; t += (hi - lo) / 4000) {
    const e = error(make(t));
    if (e.rms < best.rms) best = { t, ...e };
  }
  console.log(`${label.padEnd(10)} param ${best.t.toFixed(3).padStart(8)}  rms ${best.rms.toFixed(2)}  max ${best.max.toFixed(1)}`);
}

console.log(`${comp}@${frameArg} ${axis} ${index} around ${centre}: ${measured.map((v) => Math.round(v)).join(" ")}`);
fit("gaussian", gaussian, 0.2, reach);
if (process.argv.includes("--free")) {
  let best = { h: [0, 0, 0], rms: Infinity, max: 0 };
  for (let a = 0.5; a <= reach; a += 0.02)
    for (let b = 0.5; b <= a; b += 0.02)
      for (let c = 0.5; c <= b; c += 0.02) {
        const e = error(convolve(convolve(box(a), box(b)), box(c)));
        if (e.rms < best.rms) best = { h: [a, b, c], ...e };
      }
  console.log(`free x3    ${best.h.map((v) => v.toFixed(2)).join(" ")}  rms ${best.rms.toFixed(2)}  max ${best.max.toFixed(1)}`);
}
for (const passes of [1, 2, 3, 4]) {
  fit(`box x${passes}`, (h) => {
    let k = [1];
    for (let i = 0; i < passes; i++) k = convolve(k, box(h));
    return k;
  }, 0, reach);
}
