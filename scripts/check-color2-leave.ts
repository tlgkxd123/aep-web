// Tabulates how much Leave Color / Change To Color style effects change each probe cell
// against its distance from a target colour, to fit their softness falloff:
// f = (input - output) / (input - grey) per cell, with the distance in RGB (Euclidean over
// 256·sqrt(3)) or hue (turns).
//   node scripts/check-color2-leave.ts <frame> <r,g,b target 0..255> [--hue] [--comp color2_probe]
import { existsSync, readFileSync } from "node:fs";
import { rgbToHsl } from "../src/render/effects/colorExtraMath.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff, type Image } from "./lib/tiff.ts";

const [frameArg, targetArg] = process.argv.slice(2);
const compArg = process.argv.indexOf("--comp");
const comp = compArg > 0 ? process.argv[compArg + 1] : "color2_probe";
const hue = process.argv.includes("--hue");
const target = targetArg.split(",").map(Number);
const read = (f: number): Image => {
  if (!existsSync(framePath(comp, f))) throw new Error(`no frame ${f} of ${comp}`);
  return readTiff(new Uint8Array(readFileSync(framePath(comp, f))));
};
const src = read(0);
const out = read(Number(frameArg));
const mask = process.argv.includes("--mask");
const cell = (img: Image, k: number) => {
  const o = ((Math.floor(k / 16) * 8 + 4) * img.width + (k % 16) * 8 + 4) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
};
const rows: string[][] = [];
const th = rgbToHsl(target.map((v) => v / 255));
for (let k = 0; k < 192; k++) {
  const c = cell(src, k);
  const o = cell(out, k);
  const grey = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const ch = [0, 1, 2].reduce((best, i) => (Math.abs(c[i] - grey) > Math.abs(c[best] - grey) ? i : best), 0);
  if (!mask && Math.abs(c[ch] - grey) < 20) continue;
  const f = mask ? 1 - (o[0] * o[3]) / 255 / 255 : (c[ch] - o[ch]) / (c[ch] - grey);
  let d: number;
  if (hue) {
    const h = rgbToHsl(c.map((v) => v / 255));
    const dh = Math.abs(h[0] - th[0]);
    d = Math.min(dh, 1 - dh);
  } else d = Math.hypot(c[0] - target[0], c[1] - target[1], c[2] - target[2]) / (256 * Math.sqrt(3));
  if (mask && (f <= 0.001 || f >= 0.999) && !process.argv.includes("--all")) continue;
  rows.push([d.toFixed(4), f.toFixed(3), `${c.slice(0, 3)} -> ${o}`]);
}
rows.sort((a, b) => Number(a[0]) - Number(b[0]));
const fitArg = process.argv.indexOf("--fit");
if (fitArg > 0) {
  // f = (d² - t²) / (K · softness): the K that fits best.
  const [t, s] = process.argv[fitArg + 1].split(",").map(Number);
  let best = { k: 0, err: Infinity };
  for (let k = 0.5; k <= 0.9; k += 0.001) {
    let err = 0;
    for (const [d, f] of rows.map((r) => [Number(r[0]), Number(r[1])])) {
      const p = Math.min(1, Math.max(0, (d * d - t * t) / (k * s)));
      if (d > t) err += (p - f) ** 2;
    }
    if (err < best.err) best = { k, err };
  }
  console.log(`K ${best.k.toFixed(3)} (squared error ${best.err.toFixed(4)})`);
} else for (const r of rows) console.log(r.join("  "));
