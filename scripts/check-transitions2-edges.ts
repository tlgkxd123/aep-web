// Prints, for rows (or columns) of a transitions2 reference frame, where the alpha crosses one half: sub-pixel edge
// positions from the coverage of the pixels around each crossing, for working out wipe geometry. With `ours`, the same
// for our frame from `node scripts/pixel-report.ts --dump` on the next line.
//
//   node scripts/check-transitions2-edges.ts <comp> <frame> rows=<y0,y1,...> | cols=<x0,x1,...> [ours]
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, spec, withOurs] = process.argv.slice(2);
const { width, height, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const images: [string, Uint8Array][] = [["ae", data]];
if (withOurs === "ours") {
  const dir = resolve("refs", "ours");
  const file = readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`));
  if (file) images.push(["ours", new Uint8Array(readFileSync(join(dir, file)))]);
}
const [axis, list] = spec.split("=");
for (const line of list.split(",").map(Number)) {
  for (const [name, pixels] of images) {
    const n = axis === "rows" ? width : height;
    const alpha = (i: number) => pixels[(axis === "rows" ? line * width + i : i * width + line) * 4 + 3] / 255;
    const edges: string[] = [];
    for (let i = 0; i + 1 < n; i++) {
      const [a, b] = [alpha(i), alpha(i + 1)];
      if ((a - 0.5) * (b - 0.5) < 0 || (a === 0.5 && i > 0)) {
        // The crossing between pixel centres i + 0.5 and i + 1.5, linearly.
        edges.push(`${(i + 0.5 + (0.5 - a) / (b - a)).toFixed(2)}${b > a ? "+" : "-"}`);
      }
    }
    console.log(`${name.padEnd(4)} ${axis === "rows" ? "y" : "x"}=${line}: ${edges.join(" ")}`);
  }
}
