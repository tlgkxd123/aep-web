// Reads the orientation of every tile of stylize2_repetile_cells (CC RepeTile on 20 x 20 UV cards expanded by 100
// px on every side): per tile, where the source's x and y axes went, as "<local x><local y>" in source axes (e.g.
// "+x+y" untouched, "-y+x" turned clockwise), row by row from the top, for the layer centred at x = `centre`.
//
//   node scripts/check-stylize2-cells.ts [centre] [--ours]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const COMP = "stylize2_repetile_cells";
const TILE = 20;
const centres = process.argv.slice(2).filter((a) => !a.startsWith("--")).map(Number);

function image(): { width: number; data: Uint8Array } {
  if (!process.argv.includes("--ours")) return readTiff(new Uint8Array(readFileSync(framePath(COMP, 0))));
  const dir = join(ROOT, "ours");
  const name = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${COMP}_f0_`)) : undefined;
  if (!name) throw new Error(`no dump of ${COMP}@0 in ${dir}`);
  const [, width] = /_(\d+)x(\d+)\.rgba$/.exec(name)!.map(Number);
  return { width, data: new Uint8Array(readFileSync(join(dir, name))) };
}

const img = image();
const source = (x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [(img.data[i] / 255) * TILE, (img.data[i + 1] / 255) * TILE];
};
const axis = (d: number[]) => (Math.abs(d[0]) > Math.abs(d[1]) ? (d[0] > 0 ? "+x" : "-x") : d[1] > 0 ? "+y" : "-y");
for (const centre of centres.length ? centres : [115, 345]) {
  console.log(`layer at x = ${centre}`);
  for (let j = -5; j <= 5; j++) {
    const row: string[] = [];
    for (let i = -5; i <= 5; i++) {
      const x0 = centre - TILE / 2 + i * TILE;
      const y0 = 115 - TILE / 2 + j * TILE;
      const o = source(x0 + 4, y0 + 4);
      const dx = source(x0 + 15, y0 + 4).map((v, k) => v - o[k]);
      const dy = source(x0 + 4, y0 + 15).map((v, k) => v - o[k]);
      row.push(axis(dx) + axis(dy));
    }
    console.log(`${String(j).padStart(3)}  ${row.join(" ")}`);
  }
}
