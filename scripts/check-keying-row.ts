// A row of a keying comp: After Effects' alpha against ours (refs/ours, written by pixel-report --dump), for
// looking at keyed edges.
//
//   node scripts/check-keying-row.ts <comp> <frame> <y> <x0> <x1> [channel 0-3, default 3]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, n, yArg, x0Arg, x1Arg, chArg] = process.argv.slice(2);
const [y, x0, x1, ch] = [Number(yArg), Number(x0Arg), Number(x1Arg), Number(chArg ?? 3)];
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", comp, `frame_${n.padStart(5, "0")}.tif`))));
const name = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${n}_`));
if (!name) throw new Error(`no dump of ${comp}@${n}: run pixel-report with --dump`);
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", name)));
// Both are straight; compare premultiplied channels as the pixel criterion does.
const premul = (data: Uint8Array, i: number) => (ch === 3 ? data[i + 3] : Math.round((data[i + ch] * data[i + 3]) / 255));
if (process.argv.includes("--bounds")) {
  for (const [label, data, straight] of [["ref", ref.data, true], ["us", ours, false]] as const) {
    let [minX, minY, maxX, maxY, count] = [Infinity, Infinity, -1, -1, 0];
    for (let yy = 0; yy < ref.height; yy++)
      for (let xx = 0; xx < ref.width; xx++)
        if (data[(yy * ref.width + xx) * 4 + 3] > 0) {
          [minX, minY, maxX, maxY] = [Math.min(minX, xx), Math.min(minY, yy), Math.max(maxX, xx), Math.max(maxY, yy)];
          count++;
        }
    console.log(`${label}${straight ? " (straight)" : ""}: ${count} pixels with alpha, x ${minX}-${maxX}, y ${minY}-${maxY}, size ${ref.width}x${ref.height}`);
  }
}
const refs: number[] = [];
const ourRow: number[] = [];
for (let x = x0; x <= x1; x++) {
  const i = (y * ref.width + x) * 4;
  refs.push(premul(ref.data, i));
  ourRow.push(premul(ours, i));
}
console.log(`x   ${Array.from({ length: x1 - x0 + 1 }, (_, k) => String(x0 + k).padStart(4)).join("")}`);
console.log(`ref ${refs.map((v) => String(v).padStart(4)).join("")}`);
console.log(`us  ${ourRow.map((v) => String(v).padStart(4)).join("")}`);
