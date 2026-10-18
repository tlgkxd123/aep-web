// Prints the curve each channel follows on a probe frame, read from the 64 grey cells
// (input value, then the output red, green and blue), every `step`-th grey.
//   node scripts/check-color2-curves.ts <frame> [--comp color2_probe2] [--step 4]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff, type Image } from "./lib/tiff.ts";

const frame = Number(process.argv[2]);
const opt = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const comp = opt("--comp", "color2_probe2");
const step = Number(opt("--step", "4"));
const read = (f: number): Image => readTiff(new Uint8Array(readFileSync(framePath(comp, f))));
const src = read(0);
const out = read(frame);
const cell = (img: Image, k: number) => {
  const o = ((Math.floor(k / 16) * 8 + 4) * img.width + (k % 16) * 8 + 4) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
const rows: string[] = [];
for (let k = 192; k < 256; k += step) rows.push(`${cell(src, k)[0]}:${cell(out, k).join("/")}`);
rows.push(`255:${cell(out, 255).join("/")}`);
console.log(`frame ${frame}: ${rows.join(" ")}`);
