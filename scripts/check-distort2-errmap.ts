// Where a distort2 frame's error is: our render (pixel-report.ts --dump) against the reference, as the share of the
// frame's total error (the per-pixel worst premultiplied channel difference) in each block of comp pixels, and
// the frame's mean.
//
//   node scripts/check-distort2-errmap.ts <comp> <frame> [block]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, blockArg] = process.argv.slice(2);
const block = Number(blockArg ?? 10);
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const file = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frameArg}_`));
if (!file) throw new Error(`no dump of ${comp}@${frameArg} in refs/ours`);
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", file)));
const { width, height } = ref;
const premul = (d: Uint8Array, i: number, c: number) => (c === 3 ? d[i + 3] : (d[i + c] * d[i + 3]) / 255);
const cols = Math.ceil(width / block);
const rows = Math.ceil(height / block);
const sums = new Float64Array(cols * rows);
let total = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    let worst = 0;
    for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(premul(ref.data, i, c) - premul(ours, i, c)));
    sums[Math.floor(y / block) * cols + Math.floor(x / block)] += worst;
    total += worst;
  }
}
console.log(`mean ${(total / (width * height)).toFixed(3)}; per mille of the total error by ${block}px block:`);
for (let r = 0; r < rows; r++) {
  let line = String(r * block).padStart(4) + " ";
  for (let c = 0; c < cols; c++) line += String(Math.round((1000 * sums[r * cols + c]) / Math.max(total, 1e-9))).padStart(5);
  console.log(line);
}
