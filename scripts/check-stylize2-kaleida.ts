// Reads how a kaleidoscope-like mode maps a UV card (stylize2_uv, red across, green down): for output offsets d from
// a centre, folded into one period, it fits per octant (sign of d.x, d.y and which is larger) the signed
// permutation M with source = source centre + M d, and prints the share of pixels each fits.
//
//   node scripts/check-stylize2-kaleida.ts <comp> <frame> <centre x> <centre y> <source centre x> <source centre y> <period> [source width height]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, ...rest] = process.argv.slice(2);
const [cx, cy, sx, sy, period, w = 100, h = 80] = rest.map(Number);
const img = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const MATS: [string, number[]][] = [
  ["id", [1, 0, 0, 1]],
  ["-x", [-1, 0, 0, 1]],
  ["-y", [1, 0, 0, -1]],
  ["-xy", [-1, 0, 0, -1]],
  ["T", [0, 1, 1, 0]],
  ["T-x", [0, -1, 1, 0]],
  ["T-y", [0, 1, -1, 0]],
  ["T-xy", [0, -1, -1, 0]],
];
const half = period / 2;
const fold = (v: number) => v - period * Math.round(v / period);
const octants = new Map<string, number[]>();
const residuals = new Map<string, [number, number][][]>();
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] < 250) continue;
    const dx = fold(x + 0.5 - cx);
    const dy = fold(y + 0.5 - cy);
    if (Math.abs(Math.abs(dx) - Math.abs(dy)) < 1 || Math.abs(dx) > half - 1 || Math.abs(dy) > half - 1 || Math.abs(dx) < 1 || Math.abs(dy) < 1) continue;
    const ux = (img.data[i] / 255) * w - sx;
    const uy = (img.data[i + 1] / 255) * h - sy;
    const key = `${dx < 0 ? "-" : "+"}x ${dy < 0 ? "-" : "+"}y ${Math.abs(dx) > Math.abs(dy) ? "|x|>|y|" : "|y|>|x|"}`;
    const hits = octants.get(key) ?? [0, 0, 0, 0, 0, 0, 0, 0, 0];
    MATS.forEach(([, m], k) => {
      if (Math.abs(m[0] * dx + m[1] * dy - ux) < 1.5 && Math.abs(m[2] * dx + m[3] * dy - uy) < 1.5) hits[k]++;
    });
    hits[8]++;
    octants.set(key, hits);
    const res = residuals.get(key) ?? MATS.map(() => []);
    MATS.forEach(([, m], k) => res[k].push([ux - (m[0] * dx + m[1] * dy), uy - (m[2] * dx + m[3] * dy)]));
    residuals.set(key, res);
  }
}
const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
for (const [key, res] of [...residuals].sort()) {
  const ranked = res
    .map((pairs, k) => {
      const ox = median(pairs.map((p) => p[0]));
      const oy = median(pairs.map((p) => p[1]));
      const share = pairs.filter((p) => Math.abs(p[0] - ox) < 1.5 && Math.abs(p[1] - oy) < 1.5).length / pairs.length;
      return { name: MATS[k][0], ox, oy, share };
    })
    .sort((a, b) => b.share - a.share);
  console.log(`${key}: ${ranked.slice(0, 2).map((r) => `${r.name} +(${r.ox.toFixed(1)},${r.oy.toFixed(1)}) ${(r.share * 100).toFixed(0)}%`).join(", ")}`);
}
