// Precise vertical sample positions in a distort2 reference from the blue checker's cell edges: where a pixel's blue
// is between none and full, its bilinear sample straddles a horizontal cell edge, so the fraction places it to a
// hundredth of a pixel (the green ramp only to a third). Prints, for one column, each such pixel's distance d above
// a line and the pull m towards it (sample y - pixel y).
//
//   node scripts/check-distort2-blue.ts <comp> <frame> <column x> <line y>
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CARD = { x: 20, y: 15, width: 120, height: 90 };
const [comp, frameArg, colArg, lineArg] = process.argv.slice(2);
const [col, line] = [Number(colArg), Number(lineArg)];
const frame = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const card = readTiff(new Uint8Array(readFileSync(framePath("distort2_card", 0))));
const at = (img: typeof frame, x: number, y: number) => img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
const greenAlong = Array.from({ length: CARD.height }, (_, y) => at(card, CARD.x + 1, CARD.y + y)[1]);
function invert(ramp: number[], v: number): number {
  for (let i = 1; i < ramp.length; i++) if (v <= ramp[i]) return i - 0.5 + (v - ramp[i - 1]) / Math.max(1e-9, ramp[i] - ramp[i - 1]);
  return ramp.length - 0.5;
}
const i = Math.floor((col + 0.5) / 10);
for (let y = 0; y < CARD.height; y++) {
  const [, g, b, a] = at(frame, CARD.x + col, CARD.y + y);
  if (a < 255 || b === 0 || b >= 203) continue;
  const rough = invert(greenAlong, g);
  const edge = Math.round(rough / 10) * 10;
  const aboveBlue = (i + edge / 10 - 1) % 2 === 0;
  const f = b / 204;
  const ys = aboveBlue ? edge + 0.5 - f : edge - 0.5 + f;
  const d = line - (y + 0.5);
  console.log(`y ${String(y).padStart(3)}  d ${d.toFixed(2).padStart(7)}  sample ${ys.toFixed(3).padStart(8)}  m ${(ys - (y + 0.5)).toFixed(3).padStart(8)}`);
}
