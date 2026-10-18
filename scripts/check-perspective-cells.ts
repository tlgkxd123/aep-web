// Applies the pixel criterion to each 160x120 cell of a perspective-suite frame
// (After Effects' reference against the frame pixel-report --dump wrote), to see
// which settings of a tiled comp still differ.
//
//   node scripts/check-perspective-cells.ts <comp> <frame> [cellWidth cellHeight]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareFrames, INTERIOR_TOLERANCE, MEAN_TOLERANCE } from "./lib/pixel-criterion.ts";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameText, cw = "160", ch = "120"] = process.argv.slice(2);
const frame = Number(frameText);
const [cellW, cellH] = [Number(cw), Number(ch)];
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
const dir = join(ROOT, "ours");
const file = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`)) : undefined;
if (!file) throw new Error(`no dump for ${comp}@${frame}; run pixel-report with --dump`);
const ours = new Uint8Array(readFileSync(join(dir, file)));

const crop = (data: Uint8Array, x0: number, y0: number) => {
  const out = new Uint8Array(cellW * cellH * 4);
  for (let y = 0; y < cellH; y++) out.set(data.subarray(((y0 + y) * ref.width + x0) * 4, ((y0 + y) * ref.width + x0 + cellW) * 4), y * cellW * 4);
  return out;
};
for (let y0 = 0, row = 0; y0 + cellH <= ref.height; y0 += cellH, row++) {
  for (let x0 = 0, col = 0; x0 + cellW <= ref.width; x0 += cellW, col++) {
    const r = compareFrames(crop(ref.data, x0, y0), crop(ours, x0, y0), cellW, cellH);
    const ok = r.interiorShare <= INTERIOR_TOLERANCE && r.meanDiff <= MEAN_TOLERANCE;
    console.log(
      `${ok ? "ok  " : "DIFF"} cell ${row * Math.floor(ref.width / cellW) + col} (col ${col}, row ${row})  interior ${(r.interiorShare * 100).toFixed(2)}%  all ${(r.badShare * 100).toFixed(2)}%  max ${Math.round(r.maxDiff)}  mean ${r.meanDiff.toFixed(2)}`,
    );
  }
}
