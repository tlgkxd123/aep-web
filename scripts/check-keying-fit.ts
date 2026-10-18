// Compares the per-pixel keying models of src/render/effects/keyingMath.ts with After Effects' output on the
// palette cells of the keying fixtures (scripts/fixtures/build_keying.py), per comp, frame and quadrant.
//
//   node scripts/check-keying-fit.ts [comp-prefix] [--verbose] [--limit n]
import { existsSync } from "node:fs";
import { keyingCases } from "./check-keying-cases.ts";
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";
import { framePath } from "./lib/suites.ts";

const args = process.argv.slice(2);
const prefix = args.find((a) => !a.startsWith("--")) ?? "";
const verbose = args.includes("--verbose");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 20;
const cells = keyingCells();
let failing = 0;
for (const c of keyingCases.filter((k) => `${k.comp}@${k.frame} q${k.quadrant}`.startsWith(prefix))) {
  if (!existsSync(framePath(c.comp, c.frame))) continue;
  const image = frame(c.comp, c.frame);
  let worst = 0;
  let bad = 0;
  let sum = 0;
  const lines: string[] = [];
  for (const cell of cells) {
    if (c.skip?.(cell)) continue;
    const [x, y] = cellPoint(cell, c.quadrant);
    const ref = pixel(image, x, y);
    const src = cell.src.map((v) => v / 255);
    const ours = c.model(src, cell).map((v) => Math.round(v * 255));
    const diff = Math.max(...ref.map((v, i) => Math.abs(v - ours[i])));
    sum += diff;
    worst = Math.max(worst, diff);
    if (diff > 3) {
      bad++;
      const fmt = (v: number[]) => v.map((x) => Math.round(x)).join(",");
      lines.push(`  #${cell.index} src ${fmt(cell.src).padEnd(16)} ref ${fmt(ref).padEnd(16)} ours ${fmt(ours)}`);
    }
  }
  if (bad) failing++;
  console.log(`${c.comp}@${c.frame} q${c.quadrant} ${c.label ?? ""}: ${bad} cells off by more than 3, worst ${worst.toFixed(1)}, mean ${(sum / cells.length).toFixed(2)}`);
  if (verbose) console.log(lines.slice(0, limit).join("\n"));
}
console.log(failing ? `KEYING-FIT: ${failing} cases off` : "KEYING-FIT-OK");
