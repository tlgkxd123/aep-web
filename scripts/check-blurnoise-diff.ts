// Lists where our render of a blurnoise frame (pixel-report.ts --dump) differs from the reference: the worst
// pixels by premultiplied channel difference, with both values, and a coarse map of where the differences are.
//
//   node scripts/check-blurnoise-diff.ts <comp> <frame> [count]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, countArg] = process.argv.slice(2);
if (!comp || !frameArg) throw new Error("usage: node scripts/check-blurnoise-diff.ts <comp> <frame> [count]");
const frame = Number(frameArg);
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
const file = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`));
if (!file) throw new Error(`no dump of ${comp}@${frame}; run pixel-report.ts --dump`);
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", file)));
const { width, height } = ref;
const premul = (d: Uint8Array, i: number, c: number) => (c === 3 ? d[i + 3] : (d[i + c] * d[i + 3]) / 255);
const px = (d: Uint8Array, i: number) => [0, 1, 2, 3].map((c) => Math.round(premul(d, i, c)));

const rows: { x: number; y: number; diff: number; ref: number[]; ours: number[] }[] = [];
const cell = 8;
const map: number[][] = Array.from({ length: Math.ceil(height / cell) }, () => new Array(Math.ceil(width / cell)).fill(0));
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const a = px(ref.data, i);
    const b = px(ours, i);
    const diff = Math.max(...a.map((v, c) => Math.abs(v - b[c])));
    if (diff > 3) {
      rows.push({ x, y, diff, ref: a, ours: b });
      map[Math.floor(y / cell)][Math.floor(x / cell)]++;
    }
  }
}
rows.sort((a, b) => b.diff - a.diff);
console.log(`${comp}@${frame}: ${rows.length} pixels off by more than 3`);
for (const r of rows.slice(0, Number(countArg ?? 20))) console.log(`(${r.x},${r.y}) diff ${r.diff} ref ${r.ref.join(",")} ours ${r.ours.join(",")}`);
console.log(`count per ${cell}x${cell} cell:`);
for (const line of map) console.log(line.map((v) => (v ? String(Math.min(99, v)).padStart(2) : " .")).join(""));
