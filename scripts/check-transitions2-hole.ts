// Where a hole over a solid background colour ends along rays from a centre in a transitions2 reference frame: per
// angle, the distance at which the background gives way, from the coverage of the first pixel that is not background
// (its colour mixed with the background towards the next pixel out). For CC Radial ScaleWipe on the card.
//
//   node scripts/check-transitions2-hole.ts <comp> <frame> <cx> <cy> [angles=0,90,180,270] [ours]
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, cxs, cys, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((s) => s.split("=")));
const [cx, cy] = [Number(cxs), Number(cys)];
const { width, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const images: [string, Uint8Array][] = [["ae", data]];
if ("ours" in opt) {
  const dir = resolve("refs", "ours");
  const file = readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`));
  if (file) images.push(["ours", new Uint8Array(readFileSync(join(dir, file)))]);
}
const angles = (opt.angles ?? "0,90,180,270").split(",").map(Number);
for (const [name, image] of images) {
  const px = (x: number, y: number) => Array.from(image.slice((y * width + x) * 4, (y * width + x) * 4 + 3));
  const bg = px(Math.floor(cx), Math.floor(cy));
  const out: string[] = [];
  for (const angle of angles) {
    const [dx, dy] = [Math.round(Math.cos((angle * Math.PI) / 180)), Math.round(Math.sin((angle * Math.PI) / 180))];
    let [x, y] = [Math.floor(cx), Math.floor(cy)];
    while (px(x, y).every((v, i) => Math.abs(v - bg[i]) <= 1)) [x, y] = [x + dx, y + dy];
    const next = px(x + dx, y + dy);
    const here = px(x, y);
    let num = 0;
    let den = 0;
    for (let i = 0; i < 3; i++) {
      num += (here[i] - bg[i]) * (next[i] - bg[i]);
      den += (next[i] - bg[i]) ** 2;
    }
    const cover = den > 0 ? num / den : 0;
    const d = Math.abs(dx ? x + 0.5 - cx : y + 0.5 - cy);
    out.push(`${angle}: ${(d + 0.5 - cover).toFixed(2)}`);
  }
  console.log(`${name.padEnd(5)}${out.join("  ")}`);
}
