// Reads where After Effects sampled the distort2 card in a reference frame: the card's red rises along x and its
// green along y, so the undistorted card's reference (distort2_card) turns each pixel's colour back into the card
// point it shows. Points are card (layer) pixels, the card's top-left pixel centred at (0.5, 0.5).
//
//   node scripts/check-distort2-probe.ts <comp> <frame> grid [step]   decoded points on a grid of output pixels
//   node scripts/check-distort2-probe.ts <comp> <frame> row <y> [x0 x1]
//   node scripts/check-distort2-probe.ts <comp> <frame> col <x> [y0 y1]
//   node scripts/check-distort2-probe.ts <comp> <frame> at <x,y> [<x,y>...]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CARD = { x: 20, y: 15, width: 120, height: 90 };
const [comp, frameArg, mode = "grid", ...rest] = process.argv.slice(2);
const frame = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const at = (img: typeof frame, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};
// DISTORT2_LINEAR=1 decodes with ramps of 255 (i + 0.5) / n instead of the card's reference.
const linear = (n: number) => Array.from({ length: n }, (_, i) => (255 * (i + 0.5)) / n);
const card = process.env.DISTORT2_LINEAR ? null : readTiff(new Uint8Array(readFileSync(framePath("distort2_card", 0))));
const redAlong = card ? Array.from({ length: CARD.width }, (_, x) => at(card, CARD.x + x, CARD.y + 45)[0]) : linear(CARD.width);
const greenAlong = card ? Array.from({ length: CARD.height }, (_, y) => at(card, CARD.x + 1, CARD.y + y)[1]) : linear(CARD.height);

/** The fractional pixel centre (+0.5) at which a monotonic ramp reaches v. */
function invert(ramp: number[], v: number): number {
  if (v <= ramp[0]) return 0.5 - (ramp[0] - v) / Math.max(1, ramp[1] - ramp[0]);
  for (let i = 1; i < ramp.length; i++) {
    if (v <= ramp[i]) return i - 0.5 + (v - ramp[i - 1]) / Math.max(1e-9, ramp[i] - ramp[i - 1]);
  }
  const n = ramp.length;
  return n - 0.5 + (v - ramp[n - 1]) / Math.max(1, ramp[n - 1] - ramp[n - 2]);
}

function decode(x: number, y: number): string {
  const [r, g, b, a] = at(frame, CARD.x + x, CARD.y + y);
  if (a === 0) return `(${x},${y}) -`;
  return `(${x},${y}) -> ${invert(redAlong, r).toFixed(2)},${invert(greenAlong, g).toFixed(2)} b${b} a${a}`;
}

if (mode === "grid") {
  const step = Number(rest[0] ?? 10);
  for (let y = 0; y < CARD.height; y += step) {
    const cells: string[] = [];
    for (let x = 0; x < CARD.width; x += step) {
      const [r, g, , a] = at(frame, CARD.x + x, CARD.y + y);
      cells.push(a ? `${invert(redAlong, r).toFixed(1).padStart(6)},${invert(greenAlong, g).toFixed(1).padStart(5)}` : "      -     ");
    }
    console.log(`y${String(y).padStart(3)} ${cells.join(" ")}`);
  }
} else if (mode === "row") {
  const y = Number(rest[0]);
  const [x0, x1] = [Number(rest[1] ?? 0), Number(rest[2] ?? CARD.width - 1)];
  for (let x = x0; x <= x1; x++) console.log(decode(x, y));
} else if (mode === "col") {
  const x = Number(rest[0]);
  const [y0, y1] = [Number(rest[1] ?? 0), Number(rest[2] ?? CARD.height - 1)];
  for (let y = y0; y <= y1; y++) console.log(decode(x, y));
} else {
  for (const point of rest) {
    const [x, y] = point.split(",").map(Number);
    console.log(decode(x, y));
  }
}
