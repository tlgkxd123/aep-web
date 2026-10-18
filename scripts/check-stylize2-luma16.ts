// Reads CC Threshold's Luminance weights from stylize2_threshold_luma assuming the comparison runs on 16-bit levels
// (8-bit v -> floor((v * 32768 + 127) / 255), Threshold -> floor(t * 32768)): prints, for the red, green and blue
// strips, the interval of the weight every flip allows, then checks given weights against all six strips.
//
//   node scripts/check-stylize2-luma16.ts [wr wg wb]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const THRESHOLDS = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7];
const weights = process.argv.slice(2).map(Number);
const frame = (f: number) => readTiff(new Uint8Array(readFileSync(framePath("stylize2_threshold_luma", f))));
const source = frame(0);
const px = (img: { width: number; data: Uint8Array }, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const to16 = (v: number) => Math.floor((v * 32768 + 127) / 255);
const range = [0, 1, 2].map(() => [0, Infinity]);
let bad = 0;
for (let f = 1; f < THRESHOLDS.length; f++) {
  const img = frame(f);
  const t16 = Math.floor(THRESHOLDS[f] * 32768);
  for (let strip = 0; strip < 6; strip++) {
    const y = strip * 10 + 5;
    for (let x = 1; x < img.width; x++) {
      if (!(px(img, x, y)[0] > 128 && px(img, x - 1, y)[0] < 128)) continue;
      const lo = px(source, x - 1, y).map(to16);
      const hi = px(source, x, y).map(to16);
      if (strip < 3) {
        range[strip][0] = Math.max(range[strip][0], t16 / hi[strip]);
        range[strip][1] = Math.min(range[strip][1], t16 / lo[strip]);
      }
      if (weights.length === 3) {
        const l = (c: number[]) => c[0] * weights[0] + c[1] * weights[1] + c[2] * weights[2];
        if (!(l(lo) <= t16 && l(hi) > t16)) {
          bad++;
          console.log(`MISS t=${THRESHOLDS[f]} strip ${strip} x=${x} ${l(lo).toFixed(1)} ${l(hi).toFixed(1)} vs ${t16}`);
        }
      }
    }
  }
}
console.log(["r", "g", "b"].map((c, i) => `${c} in (${range[i][0].toFixed(5)}, ${range[i][1].toFixed(5)}]`).join("  "));
if (weights.length === 3) console.log(`${bad} misses`);
