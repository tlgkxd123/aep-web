// Prints, per cell of a coarse grid, how many pixels of our dumped frame differ
// from the reference by more than 3/255 in any channel, then the worst pixels.
//
//   node scripts/diff-map.ts <comp@frame> [cell=10] [worst=12]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [spec, cellArg, worstArg] = process.argv.slice(2);
const [comp, frame] = spec.split("@");
const cell = Number(cellArg ?? 10);
const t = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const file = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`));
if (!file) throw new Error("dump the frame with pixel-report --dump first");
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", file)));
const cols = Math.ceil(t.width / cell);
const counts = new Map<number, number>();
const worst: [number, number, number, string, string][] = [];
for (let y = 0; y < t.height; y++) {
  for (let x = 0; x < t.width; x++) {
    const i = (y * t.width + x) * 4;
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(t.data[i + c] - ours[i + c]));
    if (d <= 3) continue;
    const key = Math.floor(y / cell) * cols + Math.floor(x / cell);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    worst.push([d, x, y, [...t.data.subarray(i, i + 4)].join(","), [...ours.subarray(i, i + 4)].join(",")]);
  }
}
for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`cell x ${(key % cols) * cell}..${(key % cols) * cell + cell - 1} y ${Math.floor(key / cols) * cell}..${Math.floor(key / cols) * cell + cell - 1}: ${n}`);
}
worst.sort((a, b) => b[0] - a[0]);
for (const [d, x, y, ae, us] of worst.slice(0, Number(worstArg ?? 12))) console.log(`(${x},${y}) diff ${d} ae ${ae} ours ${us}`);
