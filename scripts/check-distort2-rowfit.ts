// Fits, per row of a distort2 reference whose rows show rows of the card shifted along x (CC Bender with a vertical
// axis, CC Slant at Height 100), the shift s and the box width W that reproduce the reference's blue checker best:
// each pixel x shows the card's mean over [x + 0.5 + s - W / 2, x + 0.5 + s + W / 2], each card pixel held across it.
//
//   node scripts/check-distort2-rowfit.ts <comp> <frame> [from to]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, fromArg, toArg] = process.argv.slice(2);
const frame = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const card = readTiff(new Uint8Array(readFileSync(framePath("distort2_card", 0))));
const { width } = frame;
const blue = (img: typeof frame, x: number, y: number) => (x < 0 || x >= width ? 0 : img.data[(y * width + x) * 4 + 2]);

function boxMean(y: number, a: number, b: number): number {
  let sum = 0;
  for (let i = Math.floor(a); i < b; i++) sum += blue(card, i, y) * (Math.min(b, i + 1) - Math.max(a, i));
  return sum / (b - a);
}

const [from, to] = [Number(fromArg ?? 0), Number(toArg ?? frame.height - 1)];
for (let y = from; y <= to; y++) {
  const xs: number[] = [];
  for (let x = 1; x < width - 1; x++) {
    const i = (y * width + x) * 4;
    if (frame.data[i + 3] === 255 && frame.data[i - 1] === 255 && frame.data[i + 7] === 255) xs.push(x);
  }
  if (xs.length < 20) continue;
  const error = (s: number, w: number) => xs.reduce((e, x) => e + (boxMean(y, x + 0.5 + s - w / 2, x + 0.5 + s + w / 2) - blue(frame, x, y)) ** 2, 0);
  let best = { s: 0, w: 1, e: Infinity };
  for (let s = -40; s <= 40; s += 0.25) {
    const e = error(s, 1.5);
    if (e < best.e) best = { s, w: 1.5, e };
  }
  for (let step = 0.1; step >= 0.004; step /= 5) {
    const start = best;
    for (let s = start.s - 5 * step; s <= start.s + 5 * step; s += step) {
      for (let w = Math.max(1, start.w - 5 * step); w <= start.w + 5 * step; w += step) {
        const e = error(s, w);
        if (e < best.e) best = { s, w, e };
      }
    }
  }
  console.log(`${String(y).padStart(4)}  s ${best.s.toFixed(3).padStart(8)}  W ${best.w.toFixed(3)}  rms ${Math.sqrt(best.e / xs.length).toFixed(2)}`);
}
