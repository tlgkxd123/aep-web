// Lists runs of equal non-background pixels along a row or column of a reference frame.
//
//   node scripts/fxextra-runs.ts <comp> <frame> row|col <index> [r,g,b background]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, kind, index, bgArg = "31,41,77"] = process.argv.slice(2);
const tiff = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const bg = bgArg.split(",").map(Number);
const n = kind === "row" ? tiff.width : tiff.height;
const at = (k: number) => {
  const [x, y] = kind === "row" ? [k, Number(index)] : [Number(index), k];
  return [...tiff.data.subarray((y * tiff.width + x) * 4, (y * tiff.width + x) * 4 + 3)];
};
const runs: string[] = [];
let start = 0;
for (let k = 1; k <= n; k++) {
  const prev = at(k - 1);
  if (k < n && at(k).join() === prev.join()) continue;
  if (prev.some((v, c) => Math.abs(v - bg[c]) > 2)) runs.push(`${start}-${k - 1}:${prev.join(",")}`);
  start = k;
}
console.log(runs.join("  "));
