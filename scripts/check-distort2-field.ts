// The displacement field of a distort2 reference (see check-distort2-probe.ts): for output pixels on a grid, the
// decoded sample's offset from the pixel along x and y, '.' where nothing is drawn.
//
//   node scripts/check-distort2-field.ts <comp> <frame> <x0> <x1> <dx> <y0> <y1> <dy> [x|y]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CARD = { x: 20, y: 15, width: 120, height: 90 };
const [comp, frameArg, ...nums] = process.argv.slice(2);
const [x0, x1, dx, y0, y1, dy] = nums.slice(0, 6).map(Number);
const axis = nums[6] ?? "y";
const frame = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const card = readTiff(new Uint8Array(readFileSync(framePath("distort2_card", 0))));
const at = (img: typeof frame, x: number, y: number) => img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
const redAlong = Array.from({ length: CARD.width }, (_, x) => at(card, CARD.x + x, CARD.y + 45)[0]);
const greenAlong = Array.from({ length: CARD.height }, (_, y) => at(card, CARD.x + 1, CARD.y + y)[1]);
function invert(ramp: Uint8Array | number[], v: number): number {
  if (v <= ramp[0]) return 0.5 - (ramp[0] - v) / Math.max(1, ramp[1] - ramp[0]);
  for (let i = 1; i < ramp.length; i++) if (v <= ramp[i]) return i - 0.5 + (v - ramp[i - 1]) / Math.max(1e-9, ramp[i] - ramp[i - 1]);
  const n = ramp.length;
  return n - 0.5 + (v - ramp[n - 1]) / Math.max(1, ramp[n - 1] - ramp[n - 2]);
}
let head = "     ";
for (let x = x0; x <= x1; x += dx) head += String(x).padStart(6);
console.log(head);
for (let y = y0; y <= y1; y += dy) {
  let row = String(y).padStart(4) + " ";
  for (let x = x0; x <= x1; x += dx) {
    const [r, g, , a] = at(frame, CARD.x + x, CARD.y + y);
    if (a < 255) {
      row += "     .";
      continue;
    }
    const d = axis === "x" ? invert(redAlong, r) - (x + 0.5) : invert(greenAlong, g) - (y + 0.5);
    row += d.toFixed(1).padStart(6);
  }
  console.log(row);
}
