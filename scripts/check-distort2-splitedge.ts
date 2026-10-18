// CC Split's antialiased tear in a distort2 reference: for the pixels around the tear above the line, the model's
// signed distance from the pixel centre to the tear's edge (pixels, positive outside the tear; see distortExtra.ts),
// the reference's alpha, and the average alpha per tenth of a pixel of that distance.
//
//   node scripts/check-distort2-splitedge.ts <comp> <frame> <ax> <ay> <bx> <by> <split>
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CARD = { x: 20, y: 15 };
const [comp, frameArg, ...nums] = process.argv.slice(2);
const [ax, ay, bx, by, split] = nums.map(Number);
const frame = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const a = [ax + 0.5, ay + 0.5];
const length = Math.hypot(bx - ax, by - ay);
const M = 0.006 * split * length;
const D = 0.86 * length;
const bins = new Map<number, { n: number; sum: number }>();
for (let x = Math.ceil(ax); x < bx; x++) {
  const t = (x + 0.5 - a[0]) / length;
  if (t <= 0 || t >= 1) continue;
  const m0 = M * Math.sin(Math.PI * t) ** 2;
  const g = m0 / (1 + m0 / D);
  for (let y = Math.floor(a[1] - g - 3); y + 0.5 < a[1]; y++) {
    const d = a[1] - (y + 0.5);
    const e = d - g;
    if (e > 3) continue;
    const alpha = frame.data[((CARD.y + y) * frame.width + CARD.x + x) * 4 + 3] / 255;
    const k = Math.round(e * 10);
    const b = bins.get(k) ?? { n: 0, sum: 0 };
    b.n++;
    b.sum += alpha;
    bins.set(k, b);
  }
}
for (const k of [...bins.keys()].sort((p, q) => p - q)) {
  const b = bins.get(k)!;
  console.log(`${(k / 10).toFixed(1).padStart(5)} ${String(b.n).padStart(4)} ${(b.sum / b.n).toFixed(3)}`);
}
