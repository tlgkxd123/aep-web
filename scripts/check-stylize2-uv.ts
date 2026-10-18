// Decodes a stylize2 frame rendered from a UV card (red across, green down): prints, every `step` pixels over a
// rectangle, the source pixel each output pixel came from ("x,y"; ".." where transparent), for reading how an
// effect maps its source.
//
//   node scripts/check-stylize2-uv.ts <comp> <frame> <x0> <y0> <x1> <y1> <source width> <source height> [step] [--ours]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [comp, frameArg, ...nums] = args;
const [x0, y0, x1, y1, w, h, step = 5] = nums.map(Number);
const frame = Number(frameArg);

function image(): { width: number; data: Uint8Array } {
  if (!process.argv.includes("--ours")) return readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
  const dir = join(ROOT, "ours");
  const name = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`)) : undefined;
  if (!name) throw new Error(`no dump of ${comp}@${frame} in ${dir}`);
  const [, width] = /_(\d+)x(\d+)\.rgba$/.exec(name)!.map(Number);
  const data = new Uint8Array(readFileSync(join(dir, name)));
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a > 0) for (let c = 0; c < 3; c++) data[i + c] = Math.min(255, Math.round((data[i + c] * 255) / a));
  }
  return { width, data };
}

const img = image();
const header = ["     "];
for (let x = x0; x < x1; x += step) header.push(String(x).padStart(6));
console.log(header.join(""));
for (let y = y0; y < y1; y += step) {
  const row = [String(y).padStart(4) + " "];
  for (let x = x0; x < x1; x += step) {
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] < 128) {
      row.push("    ..");
      continue;
    }
    const sx = Math.floor((img.data[i] / 255) * w);
    const sy = Math.floor((img.data[i + 1] / 255) * h);
    row.push(`${sx},${sy}`.padStart(6));
  }
  console.log(row.join(""));
}
