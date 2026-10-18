// Fits Fractal's mapping from layer pixels to the complex plane: compares the Mandelbrot set (iterated in double
// precision) with After Effects' black pixels in a generate2_fractal frame, for candidate scales and centres.
//
//   node scripts/check-generate2-fractal.ts [frame] [x] [y] [magnification]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [frame = 0, X = -0.703, Y = 0, MAG = 0] = process.argv.slice(2).map(Number);
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", "generate2_fractal", `frame_${String(frame).padStart(5, "0")}.tif`))));
const { width, height, data } = ref;
const black = (x: number, y: number) => {
  const o = (y * width + x) * 4;
  return data[o] === 0 && data[o + 1] === 0 && data[o + 2] === 0 && data[o + 3] === 255;
};

function inSet(cr: number, ci: number, limit: number): boolean {
  let zr = 0;
  let zi = 0;
  for (let n = 0; n < limit; n++) {
    const r2 = zr * zr;
    const i2 = zi * zi;
    if (r2 + i2 > 4) return false;
    zi = 2 * zr * zi + ci;
    zr = r2 - i2 + cr;
  }
  return true;
}

const background = (x: number, y: number) => {
  const o = (y * width + x) * 4;
  return data[o] === 31 && data[o + 1] === 41 && data[o + 2] === 77;
};
function escape(cr: number, ci: number, limit: number): number {
  let zr = 0;
  let zi = 0;
  for (let n = 0; n < limit; n++) {
    const r2 = zr * zr;
    const i2 = zi * zi;
    if (r2 + i2 > 4) return n;
    zi = 2 * zr * zi + ci;
    zr = r2 - i2 + cr;
  }
  return limit;
}

// --palette s cx cy: After Effects' colours by the escape count of all four subsamples (pixels whose subsamples agree).
const pal = process.argv.indexOf("--palette");
if (pal >= 0) {
  const [s, cx, cy] = process.argv.slice(pal + 1, pal + 4).map(Number);
  const scale = s / 2 ** MAG;
  const seen = new Map<number, Set<string>>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (background(x, y)) continue;
      const counts = [0, 0.5].flatMap((oy) => [0, 0.5].map((ox) => escape(X + (x + ox - cx) * scale, Y + (y + oy - cy) * scale, 300)));
      if (counts.some((c) => c !== counts[0])) continue;
      const o = (y * width + x) * 4;
      if (!seen.has(counts[0])) seen.set(counts[0], new Set());
      seen.get(counts[0])!.add(`${data[o]},${data[o + 1]},${data[o + 2]},${data[o + 3]}`);
    }
  }
  for (const n of [...seen.keys()].sort((a, b) => a - b)) console.log(n, [...seen.get(n)!].slice(0, 4).join("  "), seen.get(n)!.size > 4 ? `(+${seen.get(n)!.size - 4})` : "");
  process.exit(0);
}

const rows: { key: string; miss: number }[] = [];
for (let s = 0.0250; s <= 0.0265; s += 0.00005) {
  const scale = s / 2 ** MAG;
  for (let cx = 79.5; cx <= 81.5; cx += 0.25) {
    for (let cy = 59; cy <= 61; cy += 0.25) {
      for (const flip of [1]) {
        let miss = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (background(x, y)) continue;
            const cr = X + (x + 0.5 - cx) * scale;
            const ci = Y + flip * (y + 0.5 - cy) * scale;
            if (inSet(cr, ci, 300) !== black(x, y)) miss++;
          }
        }
        rows.push({ key: `s ${s.toFixed(5)} centre ${cx},${cy} flip ${flip}`, miss });
      }
    }
  }
}
for (const r of rows.sort((a, b) => a.miss - b.miss).slice(0, 8)) console.log(r.key, r.miss);
