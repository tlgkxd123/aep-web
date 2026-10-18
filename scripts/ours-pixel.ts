// Prints straight RGBA of pixels of a frame pixel-report.ts --dump wrote (refs/ours/<comp>_f<frame>_<w>x<h>.rgba,
// premultiplied, rows top first), to set beside scripts/ref-pixel.ts.
//
//   node scripts/ours-pixel.ts <comp> <frame> <x,y> [<x,y>...]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";

const [comp, frame, ...points] = process.argv.slice(2);
const dir = join(ROOT, "ours");
const file = readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`) && f.endsWith(".rgba"));
if (!file) throw new Error(`no dump of ${comp}@${frame} in ${dir}; run pixel-report.ts --dump`);
const width = Number(/_(\d+)x\d+\.rgba$/.exec(file)![1]);
const data = readFileSync(join(dir, file));
for (const point of points) {
  const [x, y] = point.split(",").map(Number);
  const i = (y * width + x) * 4;
  const a = data[i + 3];
  const straight = [0, 1, 2].map((c) => (a ? Math.round((data[i + c] * 255) / a) : 0));
  console.log(`${comp}@${frame} (${x},${y}): ${straight.join(" ")} ${a}`);
}
