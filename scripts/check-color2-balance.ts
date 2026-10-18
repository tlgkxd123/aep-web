// Fits the shadow, midtone and highlight balances each channel of a Color Balance probe frame follows,
// from the 64 grey cells, by grid search over colorBalanceChannel.
// --hold holds balances (shadow,mid,high per channel, "x" searched).
//   node scripts/check-color2-balance.ts <frame> [--comp color2_probe] [--hold .3,x,.2/-.4,x,0/0,x,.8]
import { readFileSync } from "node:fs";
import { colorBalanceChannel } from "../src/render/effects/colorExtraMath.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff, type Image } from "./lib/tiff.ts";

const frame = Number(process.argv[2]);
const i = process.argv.indexOf("--comp");
const comp = i > 0 ? process.argv[i + 1] : "color2_probe";
const read = (f: number): Image => readTiff(new Uint8Array(readFileSync(framePath(comp, f))));
const src = read(0);
const out = read(frame);
const cell = (img: Image, k: number) => {
  const o = ((Math.floor(k / 16) * 8 + 4) * img.width + (k % 16) * 8 + 4) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
const greys: number[][] = [];
for (let k = 192; k < 256; k++) greys.push([cell(src, k)[0], ...cell(out, k)]);

const j = process.argv.indexOf("--hold");
const hold = j > 0 ? process.argv[j + 1].split("/").map((ch) => ch.split(",")) : [];
const range = (c: number, k: number) => {
  const v = hold[c]?.[k];
  if (v !== undefined && v !== "x") return [Number(v)];
  const r: number[] = [];
  for (let x = -1.5; x <= 1.5001; x += 0.01) r.push(x);
  return r;
};

for (let c = 0; c < 3; c++) {
  let best = { err: Infinity, s: 0, m: 0, h: 0 };
  for (const s of range(c, 0))
    for (const m of range(c, 1))
      for (const h of range(c, 2)) {
        let err = 0;
        for (const g of greys) err = Math.max(err, Math.abs(colorBalanceChannel(g[0] / 255, s, m, h) * 255 - g[c + 1]));
        if (err < best.err) best = { err, s, m, h };
      }
  console.log(`${"RGB"[c]}: shadow ${best.s.toFixed(2)} mid ${best.m.toFixed(2)} high ${best.h.toFixed(2)} max ${best.err.toFixed(1)}`);
}
