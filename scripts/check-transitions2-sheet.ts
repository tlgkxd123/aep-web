// Writes After Effects' frame, ours (from `node scripts/pixel-report.ts --dump`) and their difference x8 side by side,
// enlarged, as PNGs in <out dir> (refs/diff is emptied by every pixel-report run, also those of other suites).
//
//   node scripts/check-transitions2-sheet.ts <out dir> <comp> <frame> [<comp> <frame>...]   (SHEET_SCALE=n, default 2)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodePng } from "./lib/png.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [outDir, ...pairs] = process.argv.slice(2);
const scale = Math.max(1, Number(process.env.SHEET_SCALE ?? 2));
mkdirSync(outDir, { recursive: true });
const oursDir = resolve("refs", "ours");
for (let i = 0; i + 1 < pairs.length; i += 2) {
  const [comp, frame] = [pairs[i], Number(pairs[i + 1])];
  const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
  const file = readdirSync(oursDir).find((f) => f.startsWith(`${comp}_f${frame}_`));
  const ours = file ? new Uint8Array(readFileSync(join(oursDir, file))) : new Uint8Array(ref.data.length);
  const { width, height } = ref;
  const w = width * 3 * scale;
  const h = height * scale;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const panel = Math.floor(x / (width * scale));
      const s = (Math.floor(y / scale) * width + Math.floor((x % (width * scale)) / scale)) * 4;
      const checker = ((x >> 3) + (y >> 3)) % 2 ? 160 : 100;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const r = (ref.data[s + c] * ref.data[s + 3]) / 255;
        const u = (ours[s + c] * ours[s + 3]) / 255;
        if (panel === 2) out[o + c] = Math.min(255, Math.abs(r - u) * 8 + Math.abs(ref.data[s + 3] - ours[s + 3]) * 8 * (c === 1 ? 1 : 0));
        else {
          const [v, a] = panel === 0 ? [ref.data[s + c], ref.data[s + 3]] : [ours[s + c], ours[s + 3]];
          out[o + c] = Math.round((v * a) / 255 + checker * (1 - a / 255));
        }
      }
      out[o + 3] = 255;
    }
  }
  const path = join(outDir, `${comp}_f${frame}.png`);
  writeFileSync(path, encodePng(w, h, out));
  console.log(path);
}
