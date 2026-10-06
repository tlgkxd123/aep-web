// Prints reference vs browser pixels along a row or column of one frame, from
// refs/frames and the refs/ours dump of `pixel-report.ts --dump`.
//
//   node scripts/probe-profile.ts <comp> <frame> col <x> <y0> <y1>
//   node scripts/probe-profile.ts <comp> <frame> row <y> <x0> <x1>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, mode, fixed, from, to] = process.argv.slice(2);
const frame = Number(frameArg);
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`))));
const dump = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`));
if (!dump) throw new Error("run pixel-report.ts --dump first");
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", dump)));
const px = (data: Uint8Array, x: number, y: number) => [...data.subarray((y * ref.width + x) * 4, (y * ref.width + x) * 4 + 4)].join(",");
for (let i = Number(from); i <= Number(to); i++) {
  const [x, y] = mode === "col" ? [Number(fixed), i] : [i, Number(fixed)];
  console.log(`${x},${y}  ref ${px(ref.data, x, y).padEnd(16)} ours ${px(ours, x, y)}`);
}
