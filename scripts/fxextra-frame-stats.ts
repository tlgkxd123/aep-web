// Coverage statistics of a reference frame: pixels with alpha, their bounds, alpha and
// colour ranges, and the mean premultiplied error an empty (transparent) frame would have.
//
//   node scripts/fxextra-frame-stats.ts <comp> <frame> [background r,g,b,a to compare against]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, bgArg] = process.argv.slice(2);
const bg = bgArg ? bgArg.split(",").map(Number) : [0, 0, 0, 0];
const { width, height, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
let count = 0;
let sum = 0;
let bad = 0;
let maxA = 0;
const bounds = [width, height, -1, -1];
const hist = new Map<number, number>();
const premul = (v: number[]) => [v[0] * v[3] / 255, v[1] * v[3] / 255, v[2] * v[3] / 255, v[3]];
const bgP = premul(bg);
for (let p = 0; p < width * height; p++) {
  const px = [...data.subarray(p * 4, p * 4 + 4)];
  const d = Math.max(...premul(px).map((v, c) => Math.abs(v - bgP[c])));
  sum += d;
  if (d > 3) bad++;
  if (px.join() !== bg.join()) {
    count++;
    const x = p % width;
    const y = Math.floor(p / width);
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
    maxA = Math.max(maxA, px[3]);
    const bucket = Math.floor(d / 16) * 16;
    hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
  }
}
console.log(`${comp}@${frame} ${width}x${height}: ${count} pixels differ from ${bg} (${((100 * count) / (width * height)).toFixed(3)}%), bounds ${bounds}, max alpha ${maxA}`);
console.log(`  vs background: mean error ${(sum / (width * height)).toFixed(3)}, ${((100 * bad) / (width * height)).toFixed(3)}% off by more than 3`);
console.log(`  difference histogram (bucket of 16): ${[...hist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(" ")}`);
