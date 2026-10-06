// Prints straight RGBA along a row or column of a reference frame, or of the
// dumped render (pixel-report --dump) with --ours.
//
//   node scripts/fxextra-row.ts <comp> <frame> row|col <index> <from> <to> [step] [--ours]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2).filter((a) => a !== "--ours");
const [comp, frame, kind, index, from, to, step = "1"] = args;
const tiff = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
let data = tiff.data;
if (process.argv.includes("--ours")) {
  const name = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`));
  if (!name) throw new Error("no dump; run pixel-report --dump");
  data = new Uint8Array(readFileSync(join(ROOT, "ours", name)));
}
const out: string[] = [];
for (let v = Number(from); v <= Number(to); v += Number(step)) {
  const [x, y] = kind === "row" ? [v, Number(index)] : [Number(index), v];
  const i = (y * tiff.width + x) * 4;
  out.push(`${v}:${[...data.subarray(i, i + 4)].join(",")}`);
}
console.log(out.join("  "));
