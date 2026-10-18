// Reads CC Threshold's Luminance weights from stylize2_threshold_luma: six 10 px strips (red, green, blue, yellow,
// cyan, magenta ramps); frame 0 shows the source (Alpha channel at 0), the later frames threshold it at
// THRESHOLDS. Prints, per strip and frame, the source colours on both sides of the flip to white, and checks given
// weights against every flip.
//
// With --t8, Threshold is rounded to an 8-bit level first.
//
//   node scripts/check-stylize2-luma.ts [wr wg wb] [--t8]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const THRESHOLDS = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7];
const weights = process.argv.slice(2).filter((a) => !a.startsWith("--")).map(Number);
const frame = (f: number) => readTiff(new Uint8Array(readFileSync(framePath("stylize2_threshold_luma", f))));
const source = frame(0);
const px = (img: { width: number; data: Uint8Array }, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
let bad = 0;
for (let f = 1; f < THRESHOLDS.length; f++) {
  const img = frame(f);
  for (let strip = 0; strip < 6; strip++) {
    const y = strip * 10 + 5;
    for (let x = 1; x < img.width; x++) {
      if (px(img, x, y)[0] > 128 && px(img, x - 1, y)[0] < 128) {
        const lo = px(source, x - 1, y);
        const hi = px(source, x, y);
        let note = "";
        if (weights.length === 3) {
          const l = (c: number[]) => (c[0] * weights[0] + c[1] * weights[1] + c[2] * weights[2]) / 255;
          const t = process.argv.includes("--t8") ? Math.round(THRESHOLDS[f] * 255) / 255 : THRESHOLDS[f];
          const ok = l(lo) <= t && l(hi) > t;
          if (!ok) bad++;
          note = ok ? "" : `  MISS ${l(lo).toFixed(5)} ${l(hi).toFixed(5)}`;
        }
        console.log(`t=${THRESHOLDS[f]} strip ${strip} x=${x} below ${lo.join(",")} at ${hi.join(",")}${note}`);
      }
    }
  }
}
if (weights.length === 3) console.log(`${bad} misses`);

if (process.argv.includes("--search")) {
  const flips: { t: number; lo: number[]; hi: number[] }[] = [];
  for (let f = 1; f < THRESHOLDS.length; f++) {
    const img = frame(f);
    for (let strip = 0; strip < 6; strip++) {
      const y = strip * 10 + 5;
      for (let x = 1; x < img.width; x++) {
        if (px(img, x, y)[0] > 128 && px(img, x - 1, y)[0] < 128) flips.push({ t: THRESHOLDS[f], lo: px(source, x - 1, y), hi: px(source, x, y) });
      }
    }
  }
  let best = { miss: Infinity, w: [0, 0, 0] };
  for (let wr = 0.28; wr <= 0.32; wr += 0.0005) {
    for (let wg = 0.5; wg <= 0.56; wg += 0.0005) {
      for (let wb = 0.15; wb <= 0.18; wb += 0.0005) {
        let miss = 0;
        for (const { t, lo, hi } of flips) {
          const l = (c: number[]) => (c[0] * wr + c[1] * wg + c[2] * wb) / 255;
          miss += Math.max(0, l(lo) - t) + Math.max(0, t - l(hi));
        }
        if (miss < best.miss) best = { miss, w: [wr, wg, wb] };
      }
    }
  }
  console.log(`least total excursion ${best.miss.toFixed(5)} at ${best.w.map((v) => v.toFixed(4)).join(" ")}`);
}
