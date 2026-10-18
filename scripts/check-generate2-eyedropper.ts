// Eyedropper Fill's averages over the generate2 card, for candidate sample regions, next to After Effects' fill
// (straight RGBA at pixel 5,5 of each generate2_eyedropper frame).
//
//   node scripts/check-generate2-eyedropper.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CELL_COLORS = [
  [0.95, 0.85, 0.2], [0.1, 0.2, 0.6], [0.85, 0.2, 0.25], [0.2, 0.75, 0.35],
  [0.6, 0.3, 0.8], [1.0, 1.0, 1.0], [0.05, 0.05, 0.05], [0.95, 0.55, 0.1],
  [0.3, 0.85, 0.9], [0.5, 0.5, 0.5], [0.9, 0.4, 0.7], [0.15, 0.45, 0.3],
];
const HOLES = new Set(["2,1", "5,4"]);
const TRANSLUCENT = new Set(["1,3", "6,1", "3,5"]);
const W = 160;
const H = 120;

function card(x: number, y: number): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= W || y >= H) return [0, 0, 0, 0];
  const i = Math.floor(x / 20);
  const j = Math.floor(y / 20);
  if (HOLES.has(`${i},${j}`)) return [0, 0, 0, 0];
  const c = CELL_COLORS[(j * 8 + i) % CELL_COLORS.length].map((v) => Math.round(v * 255) / 255);
  return [c[0], c[1], c[2], TRANSLUCENT.has(`${i},${j}`) ? 0.5 : 1];
}

const FRAMES = [
  { point: [40, 30], radius: 10, mode: 1 },
  { point: [100, 70], radius: 25, mode: 2 },
  { point: [50, 30], radius: 3, mode: 3 },
  { point: [55, 25], radius: 60, mode: 4 },
  { point: [110, 90], radius: 15.5, mode: 1 },
  { point: [20, 70], radius: 30, mode: 2 },
];

type Region = (dx: number, dy: number, r: number) => boolean;
const REGIONS: Record<string, { offset: number; inside: Region }> = {
  disc: { offset: 0.5, inside: (dx, dy, r) => dx * dx + dy * dy <= r * r },
  discCorner: { offset: 0, inside: (dx, dy, r) => dx * dx + dy * dy <= r * r },
  square: { offset: 0.5, inside: (dx, dy, r) => Math.abs(dx) <= r && Math.abs(dy) <= r },
  squareCorner: { offset: 0, inside: (dx, dy, r) => Math.abs(dx) <= r && Math.abs(dy) <= r },
};

function average(f: (typeof FRAMES)[number], region: (typeof REGIONS)[string], outside: boolean): number[] {
  const sum = [0, 0, 0, 0];
  let n = 0;
  const reach = Math.ceil(f.radius) + 2;
  for (let y = Math.floor(f.point[1]) - reach; y <= f.point[1] + reach; y++) {
    for (let x = Math.floor(f.point[0]) - reach; x <= f.point[0] + reach; x++) {
      if (!region.inside(x + region.offset - f.point[0], y + region.offset - f.point[1], f.radius)) continue;
      if (!outside && (x < 0 || y < 0 || x >= W || y >= H)) continue;
      const c = card(x, y);
      if (f.mode === 1 && c[3] === 0) continue;
      if (f.mode === 1 || f.mode === 2) for (let k = 0; k < 3; k++) sum[k] += c[k];
      else for (let k = 0; k < 3; k++) sum[k] += c[k] * c[3];
      sum[3] += c[3];
      n++;
    }
  }
  return sum.map((v) => Math.round((v / Math.max(1, n)) * 255));
}

if (process.argv.includes("--search")) {
  const refs = FRAMES.map((_, i) => {
    const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", "generate2_eyedropper", `frame_${String(i).padStart(5, "0")}.tif`))));
    const o = (5 * ref.width + 5) * 4;
    return Array.from(ref.data.subarray(o, o + 3));
  });
  const results: { key: string; err: number }[] = [];
  for (const [name, region] of Object.entries(REGIONS)) {
    for (const outside of [false, true]) {
      for (let s = 0.8; s <= 2.01; s += 0.05) {
        for (const add of [0, 0.5, 1, 1.5, 2]) {
          let err = 0;
          for (const i of [0, 1, 3, 4]) {
            const f = { ...FRAMES[i], radius: FRAMES[i].radius * s + add };
            const a = average(f, region, outside);
            err = Math.max(err, ...[0, 1, 2].map((k) => Math.abs(a[k] - refs[i][k])));
          }
          results.push({ key: `${name}${outside ? "+out" : ""} x${s.toFixed(2)} +${add}`, err });
        }
      }
    }
  }
  for (const r of results.sort((a, b) => a.err - b.err).slice(0, 10)) console.log(r.key, r.err);
  process.exit(0);
}

for (const [i, f] of FRAMES.entries()) {
  const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", "generate2_eyedropper", `frame_${String(i).padStart(5, "0")}.tif`))));
  const o = (5 * ref.width + 5) * 4;
  console.log(`f${i} mode ${f.mode} r ${f.radius}  ae ${Array.from(ref.data.subarray(o, o + 4)).join(" ")}`);
  for (const [name, region] of Object.entries(REGIONS)) {
    for (const outside of [false, true]) console.log(`   ${(name + (outside ? "+out" : "")).padEnd(18)} ${average(f, region, outside).join(" ")}`);
  }
}
