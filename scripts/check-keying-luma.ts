// Luma Key at its threshold: the opaque palette cells whose Rec. 601 luma (0-255) lies within 1.5 of the
// threshold, and whether After Effects keyed them.
//
//   node scripts/check-keying-luma.ts <comp> <frame> <quadrant> <threshold>
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";

const [comp, n, quadrant, thresholdArg] = process.argv.slice(2);
const threshold = Number(thresholdArg);
const image = frame(comp, Number(n));
const rows = keyingCells()
  .filter((c) => c.src[3] === 255)
  .map((cell) => {
    const [x, y] = cellPoint(cell, Number(quadrant));
    const [r, g, b] = cell.src;
    return { c: [r, g, b], l: 0.299 * r + 0.587 * g + 0.114 * b, out: pixel(image, x, y)[3] };
  })
  .filter((row) => Math.abs(row.l - threshold) <= 1.5)
  .sort((a, b) => a.l - b.l);
for (const row of rows) console.log(`${row.l.toFixed(4).padStart(9)} ${row.c.join(",").padEnd(12)} alpha ${row.out}`);
