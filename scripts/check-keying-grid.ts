// A block of a keying comp's alpha as characters, After Effects' beside ours (refs/ours, written by pixel-report
// --dump): '#' opaque, '+' partly transparent, '.' transparent.
//
//   node scripts/check-keying-grid.ts <comp> <frame> <x0> <x1> <y0> <y1>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, n, ...bounds] = process.argv.slice(2);
const [x0, x1, y0, y1] = bounds.map(Number);
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", comp, `frame_${n.padStart(5, "0")}.tif`))));
const name = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${n}_`));
if (!name) throw new Error(`no dump of ${comp}@${n}: run pixel-report with --dump`);
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", name)));
const glyph = (a: number) => (a >= 250 ? "#" : a > 5 ? "+" : ".");
if (process.argv.includes("--quadrants")) {
  const [qw, qh] = [ref.width / 2, ref.height / 2];
  for (let q = 0; q < 4; q++) {
    let bad = 0;
    for (let y = (q >> 1) * qh; y < ((q >> 1) + 1) * qh; y++)
      for (let x = (q & 1) * qw; x < ((q & 1) + 1) * qw; x++) {
        const i = (y * ref.width + x) * 4;
        for (let c = 0; c < 4; c++) {
          const premul = (d: Uint8Array) => (c === 3 ? d[i + 3] : Math.round((d[i + c] * d[i + 3]) / 255));
          if (Math.abs(premul(ref.data) - premul(ours)) > 3) {
            bad++;
            break;
          }
        }
      }
    console.log(`quadrant ${q}: ${bad} pixels differ`);
  }
  process.exit(0);
}
for (let y = y0; y <= y1; y++) {
  let a = "";
  let b = "";
  for (let x = x0; x <= x1; x++) {
    const i = (y * ref.width + x) * 4 + 3;
    a += glyph(ref.data[i]);
    b += glyph(ours[i]);
  }
  console.log(`${String(y).padStart(4)} ${a}   ${b}`);
}
