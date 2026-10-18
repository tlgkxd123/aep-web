// Prints, for each 40 x 30 cell of a Strobe Light timing comp (stylize2_strobe_timing[_30]), the frames where After
// Effects strobes it (the cell's centre is not white), as a row of # (strobing) and . (not).
//
//   node scripts/check-stylize2-strobe.ts <comp> <frames>
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, framesArg] = process.argv.slice(2);
const frames = Number(framesArg);
const rows: string[] = Array.from({ length: 16 }, () => "");
for (let f = 0; f < frames; f++) {
  const img = readTiff(new Uint8Array(readFileSync(framePath(comp, f))));
  for (let k = 0; k < 16; k++) {
    const x = 40 * (k % 4) + 20;
    const y = 30 * Math.floor(k / 4) + 15;
    const i = (y * img.width + x) * 4;
    rows[k] += img.data[i + 1] < 128 ? "#" : ".";
  }
}
rows.forEach((r, k) => console.log(`${String(k).padStart(2)} ${r}`));
