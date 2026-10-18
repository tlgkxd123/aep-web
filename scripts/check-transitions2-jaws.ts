// Prints, per column of a transitions2 reference frame (or per row with rows), where the opaque part reaching in from
// each side ends: the summed alpha of the run of non-transparent pixels from that side, so sub-pixel and exact for an
// edge crossed once. For working out the profiles of the jaws and wipes. With ours, the same for our frame from
// `node scripts/pixel-report.ts --dump` on the next line.
//
//   node scripts/check-transitions2-jaws.ts <comp> <frame> [from=0] [to=width-1] [step=1] [rows] [ours]
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((s) => s.split("=")));
const { width, height, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const images: Uint8Array[] = [data];
if ("ours" in opt) {
  const dir = resolve("refs", "ours");
  const file = readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`));
  if (file) images.push(new Uint8Array(readFileSync(join(dir, file))));
}
const rows = "rows" in opt;
const [lines, n] = rows ? [height, width] : [width, height];
const from = Number(opt.from ?? 0);
const to = Number(opt.to ?? lines - 1);
const step = Number(opt.step ?? 1);
for (const image of images) {
  const out: string[] = [];
  for (let line = from; line <= to; line += step) {
    const alpha = (i: number) => image[(rows ? line * width + i : i * width + line) * 4 + 3] / 255;
    let head = 0;
    for (let i = 0; i < n && alpha(i) > 0; i++) head += alpha(i);
    let tail = 0;
    for (let i = n - 1; i >= 0 && alpha(i) > 0; i--) tail += alpha(i);
    out.push(`${line}:${head.toFixed(2)}/${(n - tail).toFixed(2)}`);
  }
  console.log(out.join(" "));
}
