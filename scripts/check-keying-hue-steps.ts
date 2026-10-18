// Linear Color Key, Using Hue: the exact hue difference to the key (in 1/256 turns) of each opaque palette cell AE
// partly keyed, and AE's 8-bit matte, sorted by the difference.
//
//   node scripts/check-keying-hue-steps.ts <comp> <frame> <quadrant> <key r,g,b 0-255>
import { rgbToHsl } from "../src/render/effects/keyingMath.ts";
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";

const [comp, n, quadrant, keyArg] = process.argv.slice(2);
const key = keyArg.split(",").map((v) => Number(v) / 255);
const image = frame(comp, Number(n));
const kh = rgbToHsl(key)[0] * 256;
const rows: [number, number, string, number][] = [];
for (const cell of keyingCells().filter((c) => c.src[3] === 255)) {
  const [x, y] = cellPoint(cell, Number(quadrant));
  const out = pixel(image, x, y);
  const m = out[3] < 255 ? -1 : Math.round(out[0]);
  const h = rgbToHsl(cell.src.slice(0, 3).map((v) => v / 255))[0] * 256;
  let d = Math.abs(h - kh) % 256;
  d = Math.min(d, 256 - d);
  if (m > 0 && m < 255) rows.push([d, m, cell.src.slice(0, 3).join(","), h]);
}
console.log(`key hue ${kh.toFixed(3)}`);
for (const [d, m, s, h] of rows.sort((a, b) => a[0] - b[0])) console.log(`${d.toFixed(3).padStart(8)} m=${String(m).padStart(3)} h=${h.toFixed(3)} ${s}`);
