// Prints, for a channel suite comp's reference frame, each card cell's input colour (as build_channel.py makes it)
// beside the colour After Effects rendered there: the data the Channel and Utility effects' formulas are fitted to.
//
//   node scripts/check-channel-probe.ts <comp> <frame> [--card b] [--at x,y] [--opaque]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

export interface Cell {
  i: number;
  j: number;
  /** Straight 8-bit colour and alpha (0 for empty cells). */
  rgba: [number, number, number, number];
}

function* scattered(seed: number): Generator<number[]> {
  let state = BigInt(seed);
  for (;;) {
    const rgb: number[] = [];
    for (let c = 0; c < 3; c++) {
      state = (state * 1103515245n + 12345n) % 2147483648n;
      rgb.push(Number((state >> 16n) % 256n));
    }
    yield rgb;
  }
}

export function cardCells(card: "a" | "b"): Cell[] {
  const [cols, rows, seed, opacities, empty] =
    card === "a"
      ? [16, 12, 7, { 9: 0.6, 10: 0.4, 11: 0.2 } as Record<number, number>, ["15,2", "15,4", "15,6", "14,10", "3,11"]]
      : [10, 8, 99, { 6: 0.6, 7: 0.2 } as Record<number, number>, ["9,3", "0,7"]];
  const colours = scattered(seed);
  const cells: Cell[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      let c = colours.next().value as number[];
      if (j === 0) c = [0, 1, 2].map(() => Math.round((i * 255) / (cols - 1)));
      if (opacities[j] !== undefined) c = c.map((v) => Math.round(v / 5) * 5);
      const a = empty.includes(`${i},${j}`) ? 0 : Math.round(255 * (opacities[j] ?? 1));
      cells.push({ i, j, rgba: [c[0], c[1], c[2], a] });
    }
  return cells;
}

/** The reference frame's straight RGBA at pixel (x, y), top row first. */
export function refPixel(comp: string, frame: number) {
  const image = readTiff(readFileSync(join(ROOT, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`)));
  return (x: number, y: number): [number, number, number, number] => {
    const o = (y * image.width + x) * 4;
    return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
  };
}

/** Our straight RGBA at pixel (x, y) from pixel-report.ts --dump, or null when not dumped. */
export function oursPixel(comp: string, frame: number) {
  const dir = join(ROOT, "ours");
  const name = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`)) : undefined;
  if (!name) return null;
  const width = Number(/_(\d+)x\d+\.rgba$/.exec(name)![1]);
  const data = readFileSync(join(dir, name));
  return (x: number, y: number): [number, number, number, number] => {
    const o = (y * width + x) * 4;
    return [data[o], data[o + 1], data[o + 2], data[o + 3]];
  };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("check-channel-probe.ts")) {
  const [comp, frameArg] = process.argv.slice(2);
  const card = process.argv.includes("--card") ? (process.argv[process.argv.indexOf("--card") + 1] as "a" | "b") : "a";
  const at = process.argv.includes("--at") ? process.argv[process.argv.indexOf("--at") + 1].split(",").map(Number) : [0, 0];
  const px = refPixel(comp, Number(frameArg));
  const ours = oursPixel(comp, Number(frameArg));
  const offOnly = process.argv.includes("--off");
  if (process.argv.includes("--greys")) {
    // Row 0's greys and the red After Effects rendered over each, on one line.
    const line = cardCells(card)
      .filter((c) => c.j === 0)
      .map((c) => `${c.rgba[0]}:${px(at[0] + c.i * 10 + 5, at[1] + 5)[0]}`);
    console.log(`${comp}@${frameArg}  ${line.join(" ")}`);
    process.exit(0);
  }
  // --second: card B centred on card A (B's cell under A's cell i, j is i - 3, j - 2); --second-tl: at its top left.
  const b = process.argv.includes("--second") || process.argv.includes("--second-tl") ? cardCells("b") : null;
  const [di, dj] = process.argv.includes("--second-tl") ? [0, 0] : [3, 2];
  for (const cell of cardCells(card)) {
    const under = b?.find((c) => c.i === cell.i - di && c.j === cell.j - dj);
    if (b && !under) continue;
    if (process.argv.includes("--opaque") && cell.rgba[3] !== 255) continue;
    const [x, y] = [at[0] + cell.i * 10 + 5, at[1] + cell.j * 10 + 5];
    const out = px(x, y);
    const mine = ours?.(x, y);
    const off = mine ? Math.max(...[0, 1, 2, 3].map((c) => Math.abs((c === 3 ? 255 : out[3]) * out[c] - (c === 3 ? 255 : mine[3]) * mine[c]) / 255)) : 0;
    if (offOnly && off <= 3) continue;
    console.log(`${cell.i},${cell.j}\t${cell.rgba.join(" ")}${under ? ` | ${under.rgba.join(" ")}` : ""}\t->\t${out.join(" ")}${mine ? `\tours ${mine.join(" ")}${off > 3 ? "  <<" : ""}` : ""}`);
  }
}
