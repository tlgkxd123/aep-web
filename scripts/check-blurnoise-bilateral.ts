// Fits Bilateral Blur's spatial kernel and range weight to blurnoise_bilateral_kernel: the reference's 1 px white
// column (x = 30) and white quadrant edge (x = 100) on transparency, at row 100, against a simulation in CIE L
// (transparent pixels count as black, L = 0) over candidate kernels.
//
//   node scripts/check-blurnoise-bilateral.ts <frame> <radius> <threshold>
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [frame, radius, threshold] = process.argv.slice(2).map(Number);
const ref = readTiff(new Uint8Array(readFileSync(framePath("blurnoise_bilateral_kernel", frame))));
const red = (x: number, y: number) => ref.data[(y * ref.width + x) * 4];

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const toL = (y: number) => (y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y);
const fromL = (l: number) => (l > 8 ? ((l + 16) / 116) ** 3 : (l * 27) / 24389);

// Sample points: [x offset from the white region's first column, white is a column (true) or a half plane].
const samples: { column: boolean; d: number; value: number }[] = [{ column: true, d: 0, value: red(30, 100) }];
for (let d = 0; d < Math.ceil(radius * 1.5); d++) samples.push({ column: false, d, value: red(100 + d, 100) });

type Model = { name: string; spatial: (r: number) => number; reach: number; range: (dl: number) => number };

function simulate(m: Model, column: boolean, d: number): number {
  let sum = 0;
  let wsum = 0;
  const n = Math.ceil(m.reach);
  for (let dy = -n; dy <= n; dy++)
    for (let dx = -n; dx <= n; dx++) {
      const r = Math.hypot(dx, dy);
      if (r > m.reach + 1e-9) continue;
      const white = column ? dx === 0 : d + dx >= 0;
      const l = white ? 100 : 0;
      const w = m.spatial(r) * m.range(Math.abs(l - 100));
      sum += w * l;
      wsum += w;
    }
  return Math.round(srgb(fromL(sum / wsum)) * 255);
}

function score(m: Model): number {
  return samples.reduce((e, s) => e + (simulate(m, s.column, s.d) - s.value) ** 2, 0);
}

const candidates: Model[] = [];
const ranges: [string, (c: number) => (dl: number) => number][] = [
  ["gauss", (c) => (dl) => Math.exp(-0.5 * (dl / (threshold * c)) ** 2)],
  ["exp", (c) => (dl) => Math.exp(-dl / (threshold * c))],
  ["flat", () => () => 1],
];
for (const reachK of [1, 1.5, 2, 3])
  for (let s = 0.2; s <= 1.2; s += 0.02)
    for (const [rname, range] of ranges)
      for (const c of rname === "flat" ? [1] : [0.25, 0.5, 0.75, 1, 1.5, 2, 3]) {
        const sigma = s * radius;
        candidates.push({ name: `gauss σ=${s.toFixed(2)}r reach=${reachK}r ${rname} c=${c}`, spatial: (r) => Math.exp(-0.5 * (r / sigma) ** 2), reach: reachK * radius, range: range(c) });
        candidates.push({ name: `exp s=${s.toFixed(2)}r reach=${reachK}r ${rname} c=${c}`, spatial: (r) => Math.exp(-r / sigma), reach: reachK * radius, range: range(c) });
      }
const ranked = candidates.map((m) => ({ m, e: score(m) })).sort((a, b) => a.e - b.e);
console.log(`ref: ${samples.map((s) => `${s.column ? "col" : `d${s.d}`}=${s.value}`).join(" ")}`);
for (const { m, e } of ranked.slice(0, 8)) {
  console.log(`${e.toFixed(0).padStart(6)} ${m.name}: ${samples.map((s) => simulate(m, s.column, s.d)).join(" ")}`);
}
void lin;
void toL;
