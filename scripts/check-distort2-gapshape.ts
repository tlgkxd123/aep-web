// The shape of the gap a distort2 reference opens across a horizontal line (see check-distort2-gap.ts): the gap
// above the line at fractions t of the way from x0 to x1 (pixel centres), divided by its extent half way.
//
//   node scripts/check-distort2-gapshape.ts <comp> <frame> <line y> <x0> <x1> [reach]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CARD = { x: 20, y: 15 };
const [comp, frameArg, lineArg, x0Arg, x1Arg, reachArg] = process.argv.slice(2);
const frame = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const [line, x0, x1] = [Number(lineArg), Number(x0Arg), Number(x1Arg)];
const reach = Number(reachArg ?? 40);
const alpha = (x: number, y: number) => frame.data[((CARD.y + y) * frame.width + CARD.x + x) * 4 + 3] / 255;
const above = (x: number) => {
  let sum = 0;
  for (let y = Math.floor(line - reach); y < line; y++) sum += (1 - alpha(x, y)) * Math.max(0, Math.min(y + 1, line) - Math.max(y, line - reach));
  return sum;
};
const mid = above(Math.round((x0 + x1) / 2 - 0.5));
const out: string[] = [];
for (let x = Math.ceil(x0 - 0.5); x + 0.5 <= (x0 + x1) / 2; x++) {
  const t = (x + 0.5 - x0) / (x1 - x0);
  out.push(`${t.toFixed(3)}:${(above(x) / mid).toFixed(3)}`);
}
console.log(`mid ${mid.toFixed(3)}  ${out.join(" ")}`);
