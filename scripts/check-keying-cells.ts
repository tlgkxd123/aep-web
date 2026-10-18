// Reads the palette cells of the keying fixtures (scripts/fixtures/build_keying.py): for each cell, the source
// colour After Effects drew (keying_src) and its output in one quadrant of a keying comp, both premultiplied
// RGBA 0-255.
//
//   node scripts/check-keying-cells.ts <comp> <frame> <quadrant 0-3> [--json]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff, type Image } from "./lib/tiff.ts";

export interface KeyingCell {
  index: number;
  col: number;
  row: number;
  /** The colour and opacity (%) the fixture asked for. */
  asked: number[];
  opacity: number;
  /** Premultiplied RGBA 0-255 of the source, and of the plate (the shifted palette). */
  src: number[];
  plate: number[];
}

interface PaletteFile {
  cell: number;
  cols: number;
  palette: [number[], number][];
  palette2: [number[], number][];
}

const palette = (): PaletteFile => JSON.parse(readFileSync(join(ROOT, "fixtures", "keying.palette.json"), "utf8"));

/** Premultiplied RGBA 0-255 at (x, y). */
export function pixel(image: Image, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  const a = image.data[i + 3];
  return [0, 1, 2].map((c) => (image.data[i + c] * a) / 255).concat(a);
}

export const frame = (comp: string, n: number): Image => readTiff(new Uint8Array(readFileSync(framePath(comp, n))));

/** The cell's sample point in quadrant q of a 320x240 tile comp. */
export function cellPoint(cell: { col: number; row: number }, q: number, size = 4): [number, number] {
  return [(q % 2) * 160 + cell.col * size + size / 2, Math.floor(q / 2) * 120 + cell.row * size + size / 2];
}

export function keyingCells(): KeyingCell[] {
  const p = palette();
  const src = frame("keying_src", 0);
  // The plate is drawn as the source is, so its 8-bit colour is the asked colour as the source's is.
  return p.palette.map(([asked, opacity], index) => {
    const col = index % p.cols;
    const row = Math.floor(index / p.cols);
    const [x, y] = cellPoint({ col, row }, 0, p.cell);
    // The renderer holds whole premultiplied 8-bit steps.
    const s = pixel(src, x, y).map(Math.round);
    const [plateColour, plateOpacity] = p.palette2[index];
    const a = s[3];
    const plate = plateOpacity === opacity ? plateColour.map((v) => (v * a) / 255).concat(a) : [];
    return { index, col, row, asked, opacity, src: s, plate };
  });
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const [comp, n, quadrant] = process.argv.slice(2);
  const image = frame(comp, Number(n));
  const rows = keyingCells().map((cell) => {
    const [x, y] = cellPoint(cell, Number(quadrant));
    return { ...cell, out: pixel(image, x, y) };
  });
  const fmt = (v: number[]) => v.map((x) => Math.round(x)).join(",");
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows));
  else for (const r of rows) console.log(`${String(r.index).padStart(4)} ${fmt(r.src).padEnd(16)} -> ${fmt(r.out)}`);
}
