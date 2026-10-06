// Prints a region of a reference frame as characters, one per pixel, with a legend
// of the distinct colours (straight RGBA) it found.
//
//   node scripts/fxextra-ascii.ts <comp> <frame> <x0> <y0> <x1> <y1>
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, ...box] = process.argv.slice(2);
const [x0, y0, x1, y1] = box.map(Number);
const tiff = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const symbols = ".#+=*o%@&$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const legend = new Map<string, string>();
const lines: string[] = [];
for (let y = y0; y <= y1; y++) {
  let line = `${String(y).padStart(4)} `;
  for (let x = x0; x <= x1; x++) {
    const i = (y * tiff.width + x) * 4;
    const key = [...tiff.data.subarray(i, i + 4)].join(",");
    if (!legend.has(key)) legend.set(key, symbols[Math.min(legend.size, symbols.length - 1)]);
    line += legend.get(key);
  }
  lines.push(line);
}
console.log(lines.join("\n"));
for (const [key, symbol] of legend) console.log(`${symbol} = ${key}`);
