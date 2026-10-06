// Prints, per drawn column of a reference frame, the vertical extent and peak colour of its pixels.
//
//   node scripts/ref-columns.ts <comp@frame> [minAlpha=8]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [spec, minArg] = process.argv.slice(2);
const [comp, frame] = spec.split("@");
const min = Number(minArg ?? 8);
const t = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const rows: string[] = [];
for (let x = 0; x < t.width; x++) {
  let top = -1;
  let bottom = -1;
  let peak = 0;
  let peakColor = "";
  for (let y = 0; y < t.height; y++) {
    const i = (y * t.width + x) * 4;
    const a = t.data[i + 3];
    if (a < min) continue;
    if (top < 0) top = y;
    bottom = y;
    if (a > peak) [peak, peakColor] = [a, `${t.data[i]},${t.data[i + 1]},${t.data[i + 2]}`];
  }
  if (top >= 0) rows.push(`x=${x} y=${top}..${bottom} (${bottom - top + 1}px) peakA=${peak} rgb=${peakColor}`);
}
console.log(rows.join("\n"));
