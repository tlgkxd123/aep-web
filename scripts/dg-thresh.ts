// For the deepglow ramp-strip fixtures (6 strips of 16 rows, black -> colour left to right):
// per frame and strip, the source pixel where the glow input switches on and the
// ratio output/source across the transition.
//
//   node scripts/dg-thresh.ts <comp> <frames a,b,..> [x step=8]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, framesArg, stepArg = "8"] = process.argv.slice(2);
const plain = readTiff(new Uint8Array(readFileSync(framePath("deepglow_input_plain", 0))));
const step = Number(stepArg);
for (const f of framesArg.split(",").map(Number)) {
  const t = readTiff(new Uint8Array(readFileSync(framePath(comp, f))));
  console.log(`${comp}@${f}`);
  for (let k = 0; k < 6; k++) {
    const y = 8 + 16 * k;
    const px = (img: typeof t, x: number) => [0, 1, 2].map((c) => img.data[(y * img.width + x) * 4 + c]);
    let first = -1;
    for (let x = 0; x < t.width; x++) if (px(t, x).some((v) => v > 0)) { first = x; break; }
    const cells: string[] = [];
    for (let x = 0; x < t.width; x += step) {
      const s = px(plain, x);
      const o = px(t, x);
      const c = s.indexOf(Math.max(...s));
      cells.push(s[c] ? (o[c] / s[c]).toFixed(2) : " -  ");
    }
    console.log(`  strip ${k} first=${first} src=${first >= 0 ? px(plain, first).join(",") : "-"} ${cells.join(" ")}`);
  }
}
