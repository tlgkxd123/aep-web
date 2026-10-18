// Per 20 px block of a distort2 frame, the mean card point After Effects' reference shows minus the one ours shows
// (written by `pixel-report.ts --dump`), decoded from the card's red (column) and green (row) ramps at pixels opaque
// in both with opaque neighbours; and the alpha totals, to see which one covers more.
//
//   node scripts/check-distort2-srcdiff.ts <comp> <frame>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg] = process.argv.slice(2);
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const prefix = `${comp}_f${frameArg}_`;
const file = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(prefix) && f.endsWith(".rgba"));
if (!file) throw new Error(`no dump for ${prefix}`);
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", file)));
const { width, height } = ref;
const B = 20;
const opaque = (d: Uint8Array, x: number, y: number) =>
  [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].every(([dx, dy]) => {
    const [u, v] = [x + dx, y + dy];
    return u >= 0 && v >= 0 && u < width && v < height && d[(v * width + u) * 4 + 3] === 255;
  });

let alphaRef = 0;
let alphaOurs = 0;
for (let i = 3; i < ref.data.length; i += 4) {
  alphaRef += ref.data[i];
  alphaOurs += ours[i];
}
console.log(`alpha total: ref ${(alphaRef / 255).toFixed(1)} ours ${(alphaOurs / 255).toFixed(1)}`);
const lines: string[] = [];
for (let by = 0; by < height; by += B) {
  const cells: string[] = [];
  for (let bx = 0; bx < width; bx += B) {
    let [n, dx, dy] = [0, 0, 0];
    for (let y = by; y < Math.min(height, by + B); y++) {
      for (let x = bx; x < Math.min(width, bx + B); x++) {
        if (!opaque(ref.data, x, y) || !opaque(ours, x, y)) continue;
        const i = (y * width + x) * 4;
        dx += ((ref.data[i] - ours[i]) * 120) / 255;
        dy += ((ref.data[i + 1] - ours[i + 1]) * 90) / 255;
        n++;
      }
    }
    cells.push(n ? `${(dx / n).toFixed(2).padStart(6)},${(dy / n).toFixed(2).padStart(6)}` : "      -      ".padStart(13));
  }
  lines.push(`${String(by).padStart(4)} ${cells.join(" ")}`);
}
console.log(lines.join("\n"));
