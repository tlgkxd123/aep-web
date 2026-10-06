// Prints, for the Keylight gain 0.6 Final Result quadrant (fxextra_keylight_final2 q0),
// After Effects' straight colour minus the gain-scaled screen subtraction, per cell.
//
//   node scripts/fxextra-fit-gain.ts [comp quadrant gain]
import { readFileSync } from "node:fs";
import { paletteCells } from "./fxextra-cells.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp = "fxextra_keylight_final2", quadrant = "0", gainArg = "0.6"] = process.argv.slice(2);
const gain = Number(gainArg);
const q = Number(quadrant);
const S = [1, 0.003921568859368563, 0];
const tiff = readTiff(new Uint8Array(readFileSync(framePath(comp, 0))));
const sat = (c: number[]) => c[0] - 0.5 * (c[1] + c[2]);
for (const cell of paletteCells()) {
  if (cell.src[3] !== 255) continue;
  const s = cell.src.slice(0, 3).map((v) => v / 255);
  const k = Math.max(0, sat(s) / sat(S));
  if (k <= 0) continue;
  const x = (q % 2) * 160 + cell.col * 8 + 4;
  const y = Math.floor(q / 2) * 120 + cell.row * 8 + 4;
  const i = (y * tiff.width + x) * 4;
  const ref = [...tiff.data.subarray(i, i + 4)].map((v) => v / 255);
  const sub = s.map((v, c) => v - gain * k * S[c]);
  const u = ref.slice(0, 3).map((v, c) => (v - sub[c]).toFixed(3));
  console.log(`${cell.src.slice(0, 3).join(",").padEnd(12)} k ${k.toFixed(3)} a ${ref[3].toFixed(3)} 1-a ${(1 - ref[3]).toFixed(3)} ref ${ref.slice(0, 3).map((v) => v.toFixed(3))} add ${u}`);
}
