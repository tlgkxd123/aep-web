// Prints a reference frame's pixels (straight RGBA, 0..255) over a rectangle, for
// fitting the perspective suite's effects to After Effects' renders. With
// --ours, prints the frame pixel-report --dump wrote instead (premultiplied).
//
//   node scripts/check-perspective-probe.ts <comp> <frame> <x0> <y0> <x1> <y1> [step] [--ours] [--alpha|--channel n]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const channelArg = args.indexOf("--channel");
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--channel");
const [comp, frameText, ...nums] = positional;
const frame = Number(frameText);
const [x0, y0, x1, y1, step = 1] = nums.map(Number);

let width: number;
let height: number;
let data: Uint8Array;
if (flags.has("--ours")) {
  const dir = join(ROOT, "ours");
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`)) : undefined;
  if (!file) throw new Error(`no dump for ${comp}@${frame}; run pixel-report with --dump`);
  [width, height] = file.slice(file.lastIndexOf("_") + 1, -".rgba".length).split("x").map(Number);
  data = new Uint8Array(readFileSync(join(dir, file)));
} else {
  ({ width, height, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, frame)))));
}
const channel = flags.has("--alpha") ? 3 : channelArg >= 0 ? Number(args[channelArg + 1]) : -1;
console.log(`${comp}@${frame} ${width}x${height}`);
for (let y = y0; y <= Math.min(y1, height - 1); y += step) {
  const row: string[] = [];
  for (let x = x0; x <= Math.min(x1, width - 1); x += step) {
    const i = (y * width + x) * 4;
    row.push(channel >= 0 ? String(data[i + channel]).padStart(3) : `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
  }
  console.log(`${String(y).padStart(4)}: ${row.join(" ")}`);
}
