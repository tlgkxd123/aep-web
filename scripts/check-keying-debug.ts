// The first palette cells of keying_dmatte: source and plate colours, their RGB distance, and the matte of After
// Effects and ours (refs/ours, from pixel-report --dump) in quadrant 1 of a frame.
//
//   node scripts/check-keying-debug.ts <frame> [count]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";
import { ROOT } from "./lib/suites.ts";

const [n, count] = [Number(process.argv[2] ?? 0), Number(process.argv[3] ?? 12)];
const image = frame("keying_dmatte", n);
const name = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`keying_dmatte_f${n}_`));
const ours = name ? new Uint8Array(readFileSync(join(ROOT, "ours", name))) : null;
for (const cell of keyingCells().slice(0, count)) {
  const [x, y] = cellPoint(cell, 1);
  const d = Math.hypot(...cell.src.slice(0, 3).map((v, i) => v - (cell.plate[i] ?? NaN)));
  const us = ours ? ours[(y * image.width + x) * 4] : NaN;
  console.log(`#${cell.index} src ${cell.src.join(",")} plate ${cell.plate.map(Math.round).join(",")} d ${d.toFixed(1)} ref ${pixel(image, x, y)[0]} us ${us}`);
}
