// Fits Color Range's YUV: Y = 255 (wr R + wg G + (1 - wr - wg) B), U = 255 (ku (B - Y) + ou), V = 255 (kv (R - Y) + ov)
// with keyingMath's box-and-ease model, by Nelder-Mead over every YUV quadrant of keying_crange; prints the fit and
// the cells off by more than 3.
//
//   node scripts/check-keying-range-yuv.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";
import { nelderMead } from "./check-keying-nm.ts";
import { ROOT } from "./lib/suites.ts";

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x));
const table = JSON.parse(readFileSync(join(ROOT, "fixtures", "keying.palette.json"), "utf8")).comps.keying_crange;
const at = (v: unknown, f: number) => (Array.isArray(v) ? v[Math.min(f, v.length - 1)] : v) as number;
const cells = keyingCells().filter((c) => c.src[3] === 255);
const SPACE = 2;
const cases: { min: number[]; max: number[]; fuzz: number; data: { s: number[]; m: number }[] }[] = [];
for (let f = 0; f < table.frames; f++) {
  const image = frame("keying_crange", f);
  table.tiles.forEach((tile: { params: Record<string, unknown> }, q: number) => {
    const p = (i: number) => at(tile.params[`p${i}`], f);
    if (p(3) !== SPACE) return;
    cases.push({
      min: [p(4), p(6), p(8)],
      max: [p(5), p(7), p(9)],
      fuzz: p(2),
      data: cells.map((cell) => {
        const [x, y] = cellPoint(cell, q);
        return { s: cell.src.slice(0, 3).map((v) => v / 255), m: pixel(image, x, y)[3] / 255 };
      }),
    });
  });
}
const coords = (w: number[], s: number[]) => {
  const y = w[0] * s[0] + w[1] * s[1] + (1 - w[0] - w[1]) * s[2];
  return [y * 255, (w[2] * (s[2] - y) + w[4]) * 255, (w[3] * (s[0] - y) + w[5]) * 255];
};
function model(w: number[], c: (typeof cases)[number], s: number[]) {
  const q = coords(w, s);
  let keyed = 1;
  for (let i = 0; i < 3; i++) {
    const d = Math.max(c.min[i] - q[i], q[i] - c.max[i]);
    keyed *= 1 - (c.fuzz > 0 ? ease(d / c.fuzz) : d > 0 ? 1 : 0);
  }
  return 1 - keyed;
}
const cost = (w: number[]) => cases.reduce((sum, c) => sum + (c.fuzz > 0 ? c.data.reduce((s, d) => s + (model(w, c, d.s) - d.m) ** 2, 0) : 0), 0);
let w = [0.299, 0.587, 0.564, 0.713, 0.5, 0.5];
for (let round = 0; round < 4; round++) w = nelderMead(cost, w, 3000, 0.05);
console.log(`wr ${w[0].toFixed(5)} wg ${w[1].toFixed(5)} ku ${w[2].toFixed(5)} kv ${w[3].toFixed(5)} ou ${w[4].toFixed(5)} ov ${w[5].toFixed(5)}`);
for (const c of cases) {
  const off = c.data.filter((d) => Math.abs(model(w, c, d.s) - d.m) * 255 > 3).length;
  console.log(`  fuzz ${c.fuzz} box ${c.min.map((v, i) => `${v}-${c.max[i]}`).join(" ")}: ${off} cells off`);
}
