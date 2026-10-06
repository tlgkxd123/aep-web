// Converts reference TIFF frames to PNG (alpha composited over a checkerboard) for viewing.
//
//   node scripts/tif2png.ts <out dir> <comp> <frame> [<comp> <frame>...]
//
// TIF2PNG_SCALE=n enlarges the output n times (nearest neighbour).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng } from "./lib/png.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [outDir, ...pairs] = process.argv.slice(2);
const scale = Math.max(1, Number(process.env.TIF2PNG_SCALE ?? 1));
mkdirSync(outDir, { recursive: true });
for (let i = 0; i + 1 < pairs.length; i += 2) {
  const [comp, frame] = [pairs[i], Number(pairs[i + 1])];
  const { width, height, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
  // TIF2PNG_CROP=x,y,w,h limits the output to a region.
  const [cx, cy, cw, ch] = process.env.TIF2PNG_CROP ? process.env.TIF2PNG_CROP.split(",").map(Number) : [0, 0, width, height];
  const w = cw * scale;
  const h = ch * scale;
  const out = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const x = p % w;
    const y = Math.floor(p / w);
    const s = ((cy + Math.floor(y / scale)) * width + cx + Math.floor(x / scale)) * 4;
    const checker = ((x >> 3) + (y >> 3)) % 2 ? 160 : 100;
    const a = data[s + 3] / 255;
    for (let c = 0; c < 3; c++) out[p * 4 + c] = Math.round(data[s + c] * a + checker * (1 - a));
    out[p * 4 + 3] = 255;
  }
  const file = join(outDir, `${comp}_f${frame}${scale > 1 ? `_x${scale}` : ""}.png`);
  writeFileSync(file, encodePng(w, h, out));
  console.log(file);
}
