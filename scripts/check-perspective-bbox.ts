// Prints, for each 160x120 cell of a perspective-suite reference frame, the bounding box (in cell pixels) of the
// pixels that differ from the background colour, to locate where an effect placed its output.
//
//   node scripts/check-perspective-bbox.ts <comp> <frame> [threshold]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameText, thresholdText = "6"] = process.argv.slice(2);
const threshold = Number(thresholdText);
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameText)))));
const [cellW, cellH] = [160, 120];
const bg = Array.from(ref.data.subarray(0, 4));
const cols = Math.floor(ref.width / cellW);
for (let y0 = 0, row = 0; y0 + cellH <= ref.height; y0 += cellH, row++) {
  for (let x0 = 0, col = 0; x0 + cellW <= ref.width; x0 += cellW, col++) {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -1, -1];
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const i = ((y0 + y) * ref.width + x0 + x) * 4;
        if (Math.max(...[0, 1, 2, 3].map((c) => Math.abs(ref.data[i + c] - bg[c]))) <= threshold) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    console.log(`cell ${row * cols + col}: ${maxX < 0 ? "empty" : `x ${minX}..${maxX + 1}  y ${minY}..${maxY + 1}`}`);
  }
}
