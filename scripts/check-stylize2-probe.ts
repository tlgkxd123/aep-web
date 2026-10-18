// Prints the pixels of a stylize2 reference frame (refs/frames) or of our render (refs/ours, written by
// pixel-report.ts --dump) over a rectangle, one line per row, as straight R G B A of 255: for reading After
// Effects' responses to the probe sources. With --diff, lists the pixels where the two differ by more than 3/255 in
// a premultiplied channel instead (reference, then ours).
//
//   node scripts/check-stylize2-probe.ts <comp> <frame> <x0> <y0> <x1> <y1> [--ours] [--channel r|g|b|a|rgb|rgba] [--premultiplied]
//   node scripts/check-stylize2-probe.ts <comp> <frame> --diff [limit]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const [comp, frameArg, ...rest] = args;
const frame = Number(frameArg);

function reference(): { width: number; height: number; data: Uint8Array } {
  return readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
}

function ours(): { width: number; height: number; data: Uint8Array } {
  const dir = join(ROOT, "ours");
  const name = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`)) : undefined;
  if (!name) throw new Error(`no dump of ${comp}@${frame} in ${dir}`);
  const [, w, h] = /_(\d+)x(\d+)\.rgba$/.exec(name)!.map(Number);
  return { width: w, height: h, data: new Uint8Array(readFileSync(join(dir, name))) };
}

const premultiply = (d: Uint8Array, i: number) => [0, 1, 2].map((c) => Math.round((d[i + c] * d[i + 3]) / 255)).concat(d[i + 3]);

const diffArg = args.indexOf("--diff");
if (diffArg >= 0) {
  const limit = Number(args[diffArg + 1] ?? 40) || 40;
  const a = reference();
  const b = ours();
  let count = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = 4 * (y * a.width + x);
      const pa = premultiply(a.data, i);
      const pb = premultiply(b.data, i);
      if (pa.some((v, c) => Math.abs(v - pb[c]) > 3)) {
        if (count < limit) console.log(`${x},${y}: ref ${pa.join(",")}  ours ${pb.join(",")}`);
        count++;
      }
    }
  }
  console.log(`${count} pixels off by more than 3/255`);
} else {
  const [x0, y0, x1, y1] = rest.slice(0, 4).map(Number);
  const channelArg = args.indexOf("--channel");
  const channel = channelArg >= 0 ? args[channelArg + 1] : "rgba";
  const image = args.includes("--ours") ? ours() : reference();
  const pick: Record<string, number[]> = { r: [0], g: [1], b: [2], a: [3], rgba: [0, 1, 2, 3], rgb: [0, 1, 2] };
  for (let y = y0; y <= y1; y++) {
    const cells: string[] = [];
    for (let x = x0; x <= x1; x++) {
      const i = 4 * (y * image.width + x);
      const p = args.includes("--premultiplied") ? premultiply(image.data, i) : [...image.data.subarray(i, i + 4)];
      cells.push(pick[channel].map((c) => String(p[c]).padStart(3)).join(pick[channel].length > 1 ? "," : ""));
    }
    console.log(`${String(y).padStart(3)}: ${cells.join(" ")}`);
  }
}
