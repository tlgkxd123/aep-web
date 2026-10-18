// Fits CC Split's displacement across the line through Point A and Point B at a fraction t of the way, in a
// distort2 reference: the sampled point's offset towards the line, m = M (1 - |v| / D) at distance |v| from it, by
// least squares over the opaque pixels of the column above the line whose sample is inside the card.
//
//   node scripts/check-distort2-splitfit.ts <comp> <frame> <line y> <column x>
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CARD = { x: 20, y: 15, width: 120, height: 90 };
const [comp, frameArg, lineArg, colArg] = process.argv.slice(2);
const [line, col] = [Number(lineArg), Number(colArg)];
const frame = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const card = readTiff(new Uint8Array(readFileSync(framePath("distort2_card", 0))));
const at = (img: typeof frame, x: number, y: number) => img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
const greenAlong = Array.from({ length: CARD.height }, (_, y) => at(card, CARD.x + 1, CARD.y + y)[1]);
function invert(ramp: number[], v: number): number {
  if (v <= ramp[0]) return 0.5 - (ramp[0] - v) / Math.max(1, ramp[1] - ramp[0]);
  for (let i = 1; i < ramp.length; i++) if (v <= ramp[i]) return i - 0.5 + (v - ramp[i - 1]) / Math.max(1e-9, ramp[i] - ramp[i - 1]);
  const n = ramp.length;
  return n - 0.5 + (v - ramp[n - 1]) / Math.max(1, ramp[n - 1] - ramp[n - 2]);
}
const pts: [number, number][] = [];
for (let y = 0; y + 0.5 < line; y++) {
  const [, g, , a] = at(frame, CARD.x + col, CARD.y + y);
  if (a < 255) continue;
  const s = invert(greenAlong, g);
  if (s < 1 || s > CARD.height - 1) continue;
  const v = line - (y + 0.5);
  pts.push([v, s - (y + 0.5)]);
}
const n = pts.length;
const sx = pts.reduce((a, p) => a + p[0], 0);
const sy = pts.reduce((a, p) => a + p[1], 0);
const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0);
const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
const m0 = (sy - slope * sx) / n;
const rms = Math.sqrt(pts.reduce((a, [v, m]) => a + (m - (m0 + slope * v)) ** 2, 0) / n);
console.log(`${comp}@${frameArg} col ${col}: M ${m0.toFixed(2)}  D ${(-m0 / slope).toFixed(2)}  rms ${rms.toFixed(2)}  n ${n}  |v| ${pts[pts.length - 1]?.[0].toFixed(1)}..${pts[0]?.[0].toFixed(1)}`);
