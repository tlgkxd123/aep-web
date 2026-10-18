// The resampling kernel a distort2 reference shows on the line card (distort2_lines: one-pixel white lines on a dark
// ground): for each comp row in a range, the weights the pixels around the nearest line in a column range give the
// line (pixel minus ground, over white minus ground), and their centroid.
//
//   node scripts/check-distort2-kernel.ts <comp> <frame> <y0> <y1> <x0> <x1>
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, ...nums] = process.argv.slice(2);
const [y0, y1, x0, x1] = nums.map(Number);
const frame = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const GROUND = 26;
const WHITE = 255;
for (let y = y0; y <= y1; y++) {
  const w: number[] = [];
  for (let x = x0; x <= x1; x++) w.push((frame.data[(y * frame.width + x) * 4] - GROUND) / (WHITE - GROUND));
  const sum = w.reduce((a, b) => a + b, 0);
  const centroid = w.reduce((a, b, i) => a + b * (x0 + i), 0) / Math.max(sum, 1e-9);
  console.log(`${String(y).padStart(4)}  ${w.map((v) => v.toFixed(3).padStart(6)).join(" ")}  sum ${sum.toFixed(3)}  at ${centroid.toFixed(3)}`);
}
