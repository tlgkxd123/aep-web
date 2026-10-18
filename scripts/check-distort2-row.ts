// Prints a row (or column) of a distort2 frame, After Effects' reference beside ours (written by
// `pixel-report.ts --dump` to refs/ours), as straight RGBA in comp pixels.
//
//   node scripts/check-distort2-row.ts <comp> <frame> row|col <index> [from to]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, mode, indexArg, fromArg, toArg] = process.argv.slice(2);
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const prefix = `${comp}_f${frameArg}_`;
const file = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(prefix) && f.endsWith(".rgba"));
const ours = file ? new Uint8Array(readFileSync(join(ROOT, "ours", file))) : undefined;
const index = Number(indexArg);
const length = mode === "col" ? ref.height : ref.width;
const [from, to] = [Number(fromArg ?? 0), Number(toArg ?? length - 1)];
const fmt = (d: Uint8Array | undefined, i: number) => (d ? [...d.subarray(i, i + 4)].map((v) => String(v).padStart(3)).join(" ") : "-");
for (let j = from; j <= to; j++) {
  const [x, y] = mode === "col" ? [index, j] : [j, index];
  const i = (y * ref.width + x) * 4;
  console.log(`${String(j).padStart(4)}  ref ${fmt(ref.data, i)}   ours ${fmt(ours, i)}`);
}
