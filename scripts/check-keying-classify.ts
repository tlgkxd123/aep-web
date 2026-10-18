// For a hard key (no softness), which distance to the key separates the cells After Effects keyed (alpha halved or
// more) from those it kept: per metric, the farthest keyed and the nearest kept cell, and the misclassified count at
// the best threshold. Straight 8-bit colours of the opaque cells.
//
//   node scripts/check-keying-classify.ts <comp> <frame> <quadrant> <key r,g,b>
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";

const [comp, n, quadrant, keyArg] = process.argv.slice(2);
const key = keyArg.split(",").map(Number);
const image = frame(comp, Number(n));
const luma = (c: number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const luma709 = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const METRICS: Record<string, (c: number[]) => number> = {
  max: (c) => Math.max(...c.map((v, i) => Math.abs(v - key[i]))),
  euclid: (c) => Math.hypot(...c.map((v, i) => v - key[i])),
  sum: (c) => c.reduce((s, v, i) => s + Math.abs(v - key[i]), 0),
  luma: (c) => Math.abs(luma(c) - luma(key)),
  luma709: (c) => Math.abs(luma709(c) - luma709(key)),
  lumaShift: (c) => Math.abs(((77 * c[0] + 150 * c[1] + 29 * c[2]) >> 8) - ((77 * key[0] + 150 * key[1] + 29 * key[2]) >> 8)),
  lumaRound: (c) => Math.abs(Math.round(luma(c)) - Math.round(luma(key))),
  average: (c) => Math.abs((c[0] + c[1] + c[2]) / 3 - (key[0] + key[1] + key[2]) / 3),
  value: (c) => Math.abs(Math.max(...c) - Math.max(...key)),
  lightness: (c) => Math.abs((Math.max(...c) + Math.min(...c)) / 2 - (Math.max(...key) + Math.min(...key)) / 2),
  maxMinusMin: (c) => {
    const d = c.map((v, i) => v - key[i]);
    return Math.max(...d) - Math.min(...d);
  },
};
const cells = keyingCells()
  .filter((c) => c.src[3] === 255)
  .map((cell) => {
    const [x, y] = cellPoint(cell, Number(quadrant));
    return { c: cell.src.slice(0, 3), keyed: pixel(image, x, y)[3] < 128 };
  });
console.log(`${cells.filter((c) => c.keyed).length} of ${cells.length} keyed`);
for (const [name, metric] of Object.entries(METRICS)) {
  const d = cells.map((c) => ({ d: metric(c.c), keyed: c.keyed })).sort((a, b) => a.d - b.d);
  const farKeyed = Math.max(...d.filter((x) => x.keyed).map((x) => x.d));
  const nearKept = Math.min(...d.filter((x) => !x.keyed).map((x) => x.d));
  let best = Infinity;
  let at = 0;
  for (let i = 0; i <= d.length; i++) {
    const wrong = d.slice(0, i).filter((x) => !x.keyed).length + d.slice(i).filter((x) => x.keyed).length;
    if (wrong < best) [best, at] = [wrong, i ? d[i - 1].d : 0];
  }
  console.log(`${name.padEnd(12)} farthest keyed ${farKeyed.toFixed(2)} nearest kept ${nearKept.toFixed(2)}  best threshold ${at.toFixed(2)} misclassified ${best}`);
}
