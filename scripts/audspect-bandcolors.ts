// Prints a reference's colour (straight RGB, alpha and HSL hue) at each band's
// position along a horizontal path.
//
//   node scripts/audspect-bandcolors.ts <comp@frame> <x0> <x1> <row> <bands> [--every=4]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [spec, x0Arg, x1Arg, rowArg, bandsArg] = process.argv.slice(2);
const every = Number(process.argv.find((a) => a.startsWith("--every="))?.slice(8) ?? 4);
const [comp, frame] = spec.split("@");
const t = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const [x0, x1, row, bands] = [x0Arg, x1Arg, rowArg, bandsArg].map(Number);

function hue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return NaN;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

for (let k = 0; k < bands; k += k + every >= bands && k !== bands - 1 ? bands - 1 - k : every) {
  const x = Math.round(x0 + ((x1 - x0) * k) / (bands - 1));
  const i = (row * t.width + x) * 4;
  const [r, g, b, a] = [0, 1, 2, 3].map((c) => t.data[i + c]);
  console.log(`k=${String(k).padStart(4)} x=${x} rgb=${r},${g},${b} a=${a} hue=${hue(r, g, b).toFixed(1)}`);
}
