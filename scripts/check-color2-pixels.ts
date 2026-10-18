// Prints the pixels where a `pixel-report.ts --dump` render differs most from the reference frame, each with the
// reference's 3 x 3 neighbourhood beside ours, to work out what an effect does at edges.
//   node scripts/check-color2-pixels.ts <comp> <frame> [--worst n]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg] = process.argv.slice(2);
const frame = Number(frameArg);
const worstArg = process.argv.indexOf("--worst");
const worst = worstArg > 0 ? Number(process.argv[worstArg + 1]) : 12;
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`))));
const dumpName = readdirSync(join(ROOT, "ours")).find((n) => n.startsWith(`${comp}_f${frame}_`));
if (!dumpName) throw new Error(`no dump for ${comp}@${frame}: run pixel-report.ts --dump`);
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", dumpName)));
const { width, height } = ref;
const px = (data: Uint8Array, x: number, y: number) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
const rows: { x: number; y: number; d: number }[] = [];
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const a = px(ref.data, x, y);
    const b = px(ours, x, y);
    rows.push({ x, y, d: Math.max(...a.map((v, i) => Math.abs(v - b[i]))) });
  }
rows.sort((a, b) => b.d - a.d);
for (const { x, y, d } of rows.slice(0, worst)) {
  console.log(`(${x},${y}) diff ${d}: ae ${px(ref.data, x, y)} ours ${px(ours, x, y)}`);
  for (let dy = -1; dy <= 1; dy++) {
    const line: string[] = [];
    const mine: string[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(width - 1, Math.max(0, x + dx));
      const yy = Math.min(height - 1, Math.max(0, y + dy));
      line.push(px(ref.data, xx, yy).join(",").padEnd(16));
      mine.push(px(ours, xx, yy).join(",").padEnd(16));
    }
    console.log(`    ${line.join(" ")} | ${mine.join(" ")}`);
  }
}
