// Writes a stylize2 frame as a PNG for looking at: After Effects' reference, ours (refs/ours from pixel-report.ts
// --dump) and their difference x8, side by side over a checkerboard, enlarged.
//
//   node scripts/check-stylize2-view.ts <comp> <frame> [--scale n] [--out dir] [--crop x,y,w,h]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "./lib/png.ts";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const [comp, frameArg] = args;
const frame = Number(frameArg);
const scaleArg = args.indexOf("--scale");
const scale = scaleArg >= 0 ? Number(args[scaleArg + 1]) : 4;
const outArg = args.indexOf("--out");
const outDir = outArg >= 0 ? args[outArg + 1] : join(tmpdir(), "stylize2-view");

const cropArg = args.indexOf("--crop");
const full = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
const dir = join(ROOT, "ours");
const name = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`)) : undefined;
const oursFull = name ? new Uint8Array(readFileSync(join(dir, name))) : new Uint8Array(full.data.length);
const [cx, cy, width, height] = cropArg >= 0 ? args[cropArg + 1].split(",").map(Number) : [0, 0, full.width, full.height];
const crop = (d: Uint8Array) => {
  const c = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) c.set(d.subarray(4 * ((y + cy) * full.width + cx), 4 * ((y + cy) * full.width + cx + width)), 4 * y * width);
  return c;
};
const ref = { data: crop(full.data) };
const ours = crop(oursFull);

const panels = 3;
const out = new Uint8Array(width * scale * panels * height * scale * 4);
const over = (d: Uint8Array, i: number, bg: number) => [0, 1, 2].map((c) => Math.round((d[i + c] * d[i + 3] + bg * (255 - d[i + 3])) / 255));
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = 4 * (y * width + x);
    const bg = ((x >> 2) + (y >> 2)) % 2 ? 200 : 140;
    const a = over(ref.data, i, bg);
    const b = over(ours, i, bg);
    const d = [0, 1, 2].map((c) => Math.min(255, 8 * Math.abs(a[c] - b[c])));
    [a, b, d].forEach((rgb, panel) => {
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const o = 4 * ((y * scale + sy) * width * scale * panels + panel * width * scale + x * scale + sx);
          out.set([...rgb, 255], o);
        }
      }
    });
  }
}
mkdirSync(outDir, { recursive: true });
const path = join(outDir, `${comp}_f${frame}.png`);
writeFileSync(path, encodePng(width * scale * panels, height * scale, out));
console.log(path);
