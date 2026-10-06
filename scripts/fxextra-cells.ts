// Prints, for the colour cells of the fxextra palette (scripts/fixtures/build_fxextra.py),
// the source colour and After Effects' straight RGBA at the cell centre in one quadrant
// of a 320x240 tile comp. Used to fit per-pixel effects such as Keylight.
//
//   node scripts/fxextra-cells.ts <comp> <frame> <quadrant 0-3> [--json]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const STEPS = [0, 0.2, 0.4, 0.6, 0.8, 1];
const EXTRA = [
  [1.0, 0.02, 0.0], [1.0, 0.05, 0.02], [1.0, 0.1, 0.05], [1.0, 0.15, 0.1], [0.9, 0.05, 0.0], [0.8, 0.1, 0.05],
  [0.7, 0.0, 0.0], [0.6, 0.12, 0.06], [0.64, 0.12, 0.06], [0.5, 0.1, 0.1], [1.0, 0.3, 0.3], [1.0, 0.5, 0.4],
  [0.95, 0.7, 0.6], [0.85, 0.55, 0.45], [0.6, 0.4, 0.3], [0.4, 0.25, 0.2], [1.0, 0.09, 0.0], [1.0, 0.0, 0.1],
  [1.0, 0.0, 0.3], [1.0, 0.2, 0.0], [1.0, 0.35, 0.0], [0.3, 0.0, 0.0], [0.15, 0.0, 0.0], [0.05, 0.05, 0.05],
  [0.1, 0.9, 0.1], [0.0, 0.7, 0.2], [0.2, 1.0, 0.3], [0.0, 0.3, 1.0], [0.1, 0.1, 0.8], [0.5, 0.5, 0.5],
  [0.25, 0.25, 0.25], [0.75, 0.75, 0.75], [0.9, 0.9, 0.9], [0.1, 0.2, 0.3], [0.3, 0.2, 0.1], [0.2, 0.3, 0.1],
  [1.0, 0.11, 1.0], [0.9, 0.1, 0.9], [1.0, 0.6, 1.0], [0.5, 0.0, 0.5], [0.0, 1.0, 1.0], [1.0, 1.0, 0.0],
  [0.98, 0.0, 0.0], [0.95, 0.03, 0.03], [0.85, 0.0, 0.0], [0.75, 0.05, 0.0], [1.0, 0.25, 0.15], [1.0, 0.45, 0.2],
  [0.55, 0.45, 0.42], [0.35, 0.3, 0.3], [0.2, 0.05, 0.05], [0.45, 0.02, 0.02], [0.3, 0.1, 0.0], [0.7, 0.3, 0.0],
  [0.12, 0.16, 0.3], [1.0, 0.5, 0.0], [0.1, 0.7, 0.65], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.66, 0.0, 0.33],
  [0.33, 0.0, 0.66], [0.0, 0.33, 0.0], [0.4, 0.8, 0.2], [0.8, 0.4, 0.6],
];
const HALF = [
  [1.0, 0.0, 0.0], [1.0, 0.5, 0.0], [0.2, 0.8, 0.2], [0.2, 0.4, 1.0], [1.0, 1.0, 1.0], [0.0, 0.0, 0.0],
  [0.8, 0.2, 0.1], [0.6, 0.6, 0.6], [1.0, 0.1, 0.05], [0.4, 0.1, 0.5],
];

export interface Cell {
  col: number;
  row: number;
  /** Source straight RGB (0-255) and alpha (0-255). */
  src: number[];
}

export function paletteCells(): Cell[] {
  const grid: number[][] = [];
  for (const r of STEPS) for (const g of STEPS) for (const b of STEPS) grid.push([r, g, b]);
  grid.push(...EXTRA);
  const to8 = (c: number[]) => c.map((v) => Math.round(v * 255));
  const cells: Cell[] = grid.slice(0, 280).map((c, i) => ({ col: i % 20, row: Math.floor(i / 20), src: [...to8(c), 255] }));
  HALF.forEach((c, i) => cells.push({ col: i, row: 14, src: [...to8(c), 128] }));
  return cells;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const [comp, frame, quadrant] = process.argv.slice(2);
  const tiff = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
  const q = Number(quadrant);
  const ox = (q % 2) * 160;
  const oy = Math.floor(q / 2) * 120;
  const rows = paletteCells().map((cell) => {
    const x = ox + cell.col * 8 + 4;
    const y = oy + cell.row * 8 + 4;
    const i = (y * tiff.width + x) * 4;
    return { ...cell, out: [...tiff.data.subarray(i, i + 4)] };
  });
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows));
  else for (const r of rows) console.log(`${r.src.join(",").padEnd(16)} -> ${r.out.join(",")}`);
}
