// Compares, per column, how far After Effects' and our drawing reach from a
// horizontal baseline (alpha >= 128), for a frame dumped by
// `node scripts/pixel-report.ts --dump`.
//
//   node scripts/compare-extent.ts <comp@frame> <baseline y> <up|down> [step=8]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [spec, baseArg, direction, stepArg] = process.argv.slice(2);
const [comp, frame] = spec.split("@");
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const file = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`));
if (!file) throw new Error("dump the frame with pixel-report --dump first");
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", file)));
const base = Number(baseArg);
const down = direction === "down";
const step = Number(stepArg ?? 8);
const extent = (data: Uint8Array, x: number) => {
  let e = -1;
  for (let d = 0; ; d++) {
    const y = down ? base + d : base - d;
    if (y < 0 || y >= ref.height) break;
    if (data[(y * ref.width + x) * 4 + 3] >= 128) e = d;
  }
  return e;
};
const rows: string[] = [];
for (let x = 0; x < ref.width; x += step) {
  const a = extent(ref.data, x);
  const o = extent(ours, x);
  rows.push(`x=${String(x).padStart(4)} ae=${String(a).padStart(4)} ours=${String(o).padStart(4)}${Math.abs(a - o) > 1 ? `  diff ${o - a}` : ""}`);
}
console.log(rows.join("\n"));
