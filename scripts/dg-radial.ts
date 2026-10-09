// Prints linearised values ((v/255)^gamma of one channel) of reference frames at distances
// from a centre along +x (and along +y, averaged), one column per frame.
//
//   node scripts/dg-radial.ts <comp> <frames a,b,..> <cx> <cy> [channel=1] [gamma=2.2] [dists a,b,..]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, framesArg, cxArg, cyArg, chArg = "1", gArg = "2.2", distArg] = process.argv.slice(2);
const frames = framesArg.split(",").map(Number);
const cx = Number(cxArg);
const cy = Number(cyArg);
const ch = Number(chArg);
const gamma = Number(gArg);
const dists = (distArg ?? "0,1,2,3,4,5,6,8,10,12,16,20,24,32,40,48,64,80,96,112,127").split(",").map(Number);
const images = frames.map((f) => readTiff(new Uint8Array(readFileSync(framePath(comp, f)))));
console.log(`d     ${frames.map((f) => `f${f}`.padStart(11)).join("")}`);
for (const d of dists) {
  const cells = images.map((t) => {
    const at = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= t.width || y >= t.height) return NaN;
      const i = (y * t.width + x) * 4;
      return Math.pow((t.data[i + ch] * t.data[i + 3]) / 255 / 255, gamma);
    };
    const v = (at(cx + d, cy) + at(cx, cy + d)) / 2;
    return v.toExponential(3).padStart(11);
  });
  console.log(`${String(d).padStart(4)}  ${cells.join("")}`);
}
