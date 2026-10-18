// Color Range's partly keyed cells: per channel of the colour space the signed distance to the box (positive outside,
// negative inside), and After Effects' matte (alpha kept, 0-1).
//
//   node scripts/check-keying-range.ts <comp> <frame> <quadrant> <space 1 Lab|2 YUV|3 RGB> lo1,hi1,lo2,hi2,lo3,hi3
import { rangeCoordinates } from "../src/render/effects/keyingMath.ts";
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";

const [comp, n, quadrant, space, boxArg] = process.argv.slice(2);
const box = boxArg.split(",").map(Number);
const image = frame(comp, Number(n));
const rows = keyingCells()
  .filter((c) => c.src[3] === 255)
  .map((cell) => {
    const [x, y] = cellPoint(cell, Number(quadrant));
    const q = rangeCoordinates(cell.src.slice(0, 3).map((v) => v / 255), Number(space));
    const d = q.map((v, i) => Math.max(box[2 * i] - v, v - box[2 * i + 1]));
    return { c: cell.src.slice(0, 3), q, d, m: pixel(image, x, y)[3] / 255 };
  })
  .filter((r) => r.m > 0.01 && r.m < 0.99)
  .sort((a, b) => a.m - b.m);
for (const r of rows)
  console.log(`${r.m.toFixed(3)}  ${r.c.join(",").padEnd(12)} q ${r.q.map((v) => v.toFixed(1).padStart(6)).join(" ")}  d ${r.d.map((v) => v.toFixed(1).padStart(6)).join(" ")}`);
