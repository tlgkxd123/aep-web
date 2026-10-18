// Prints what After Effects adds over our render (from `pixel-report.ts --dump`) for a window of a generate2
// frame, per pixel: the largest channel difference ref - ours (0-255), or the reference alpha with --alpha.
//
//   node scripts/check-generate2-edgemap.ts <comp> <frame> <x0> <y0> <x1> <y1> [--alpha] [--channel n]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const [comp, frameArg, ...rest] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--channel");
const [x0, y0, x1, y1] = rest.map(Number);
const frame = Number(frameArg);
const ci = args.indexOf("--channel");
const channel = ci >= 0 ? Number(args[ci + 1]) : -1;
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`))));
const dumped = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`))!;
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", dumped)));
const lines = [`      ${Array.from({ length: x1 - x0 + 1 }, (_, i) => String(x0 + i).padStart(4)).join("")}`];
for (let y = y0; y <= y1; y++) {
  const cells: string[] = [];
  for (let x = x0; x <= x1; x++) {
    const o = (y * ref.width + x) * 4;
    let v: number;
    if (args.includes("--alpha")) v = ref.data[o + 3];
    else if (channel >= 0) v = ref.data[o + channel] - ours[o + channel];
    else v = Math.max(ref.data[o] - ours[o], ref.data[o + 1] - ours[o + 1], ref.data[o + 2] - ours[o + 2]);
    cells.push(String(v).padStart(4));
  }
  lines.push(`${String(y).padStart(5)} ${cells.join("")}`);
}
console.log(lines.join("\n"));
