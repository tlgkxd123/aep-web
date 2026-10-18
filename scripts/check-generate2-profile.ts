// One line per frame of a generate2 comp's reference along a vertical or horizontal run of pixels: a channel
// (default green) and, with --alpha, the alpha.
//
//   node scripts/check-generate2-profile.ts <comp> <frame,frame,...> <x0> <y0> <x1> <y1> [--channel n] [--alpha]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const ci = args.indexOf("--channel");
const channel = ci >= 0 ? Number(args[ci + 1]) : 1;
const positional = args.filter((a, i) => !a.startsWith("--") && (ci < 0 || i !== ci + 1));
const [comp, frames, ...coords] = positional;
const [x0, y0, x1, y1] = coords.map(Number);
const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
for (const frame of frames.split(",").map(Number)) {
  const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`))));
  const values: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + Math.round(((x1 - x0) * i) / n);
    const y = y0 + Math.round(((y1 - y0) * i) / n);
    const o = (y * ref.width + x) * 4;
    values.push(String(ref.data[o + (args.includes("--alpha") ? 3 : channel)]));
  }
  console.log(`f${frame}: ${values.join(" ")}`);
}
