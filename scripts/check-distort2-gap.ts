// Measures the transparent gap a distort2 reference opens across a horizontal line: for each column, the gap's
// extent above and below the line as the sum of the missing coverage (1 - alpha) on each side, in pixels.
//
//   node scripts/check-distort2-gap.ts <comp> <frame> <line y (layer px)> [x0 x1] [reach]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CARD = { x: 20, y: 15 };
const [comp, frameArg, lineArg, x0Arg, x1Arg, reachArg] = process.argv.slice(2);
const frame = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const line = Number(lineArg);
const [x0, x1] = [Number(x0Arg ?? 0), Number(x1Arg ?? 119)];
const reach = Number(reachArg ?? 40);
const alpha = (x: number, y: number) => frame.data[((CARD.y + y) * frame.width + CARD.x + x) * 4 + 3] / 255;
for (let x = x0; x <= x1; x++) {
  let above = 0;
  let below = 0;
  for (let y = Math.floor(line - reach); y < line + reach; y++) {
    const lo = Math.max(y, line - reach);
    const hi = Math.min(y + 1, line + reach);
    const missing = 1 - alpha(x, y);
    above += missing * Math.max(0, Math.min(hi, line) - lo);
    below += missing * Math.max(0, hi - Math.max(lo, line));
  }
  console.log(`${String(x).padStart(4)} ${above.toFixed(3).padStart(8)} ${below.toFixed(3).padStart(8)}`);
}
