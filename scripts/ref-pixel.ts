// Prints straight RGBA of reference-frame pixels.
//
//   node scripts/ref-pixel.ts <comp> <frame> <x,y> [<x,y>...]
import { readFileSync } from "node:fs";
import { readTiff } from "./lib/tiff.ts";
import { framePath } from "./lib/suites.ts";

const [comp, frame, ...points] = process.argv.slice(2);
const tiff = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
for (const point of points) {
  const [x, y] = point.split(",").map(Number);
  const i = (y * tiff.width + x) * 4;
  console.log(`${comp}@${frame} (${x},${y}): ${[...tiff.data.subarray(i, i + 4)].join(" ")}`);
}
