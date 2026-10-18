// Reads CS BlockLoad on a UV card (stylize2_blockload_uv*): per frame, the share of transparent pixels, the largest
// square block (aligned to the layer's corner) the image is constant over, row by row bands of it, and which source
// pixel of a block it shows (decoded from the card).
//
//   node scripts/check-stylize2-blockload.ts <comp> <frames> [layer x] [layer y] [w] [h]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, framesArg, ...rest] = process.argv.slice(2);
const [lx, ly, w, h] = rest.length ? rest.map(Number) : [30, 20, 100, 80];
for (let f = 0; f < Number(framesArg); f++) {
  const img = readTiff(new Uint8Array(readFileSync(framePath(comp, f))));
  const at = (x: number, y: number) => {
    const i = ((ly + y) * img.width + lx + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  };
  let clear = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (at(x, y)[3] < 128) clear++;
  const blockOf = (y0: number, y1: number) => {
    let best = 1;
    for (const b of [2, 4, 8, 16, 32, 64]) {
      let ok = true;
      for (let y = y0; y < y1 && ok; y++) for (let x = 0; x < w && ok; x++) if (at(x, y).join() !== at(x - (x % b), y - (y % b)).join()) ok = false;
      if (ok) best = b;
    }
    return best;
  };
  const bands: string[] = [];
  for (let y0 = 0; y0 < h; y0 += 8) bands.push(String(blockOf(y0, Math.min(h, y0 + 8))));
  const c = at(5, 5);
  const sx = ((c[0] / 255) * w).toFixed(1);
  const sy = ((c[1] / 255) * h).toFixed(1);
  console.log(`f${f}: clear ${((clear / (w * h)) * 100).toFixed(1)}%  blocks per 8-row band ${bands.join(" ")}  pixel (5,5) from ${sx},${sy}`);
}
