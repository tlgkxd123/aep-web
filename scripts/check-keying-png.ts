// Writes a keying reference frame (and our dump from pixel-report --dump, if present) as PNGs over a grey
// checkerboard into %TEMP%/keying-png, scaled up 2x, for looking at.
//
//   node scripts/check-keying-png.ts <comp> <frame>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "./lib/png.ts";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, n] = process.argv.slice(2);
const out = join(tmpdir(), "keying-png");
mkdirSync(out, { recursive: true });
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", comp, `frame_${n.padStart(5, "0")}.tif`))));
const { width, height } = ref;

function write(label: string, at: (i: number) => number[]) {
  const k = 2;
  const img = new Uint8Array(width * k * height * k * 4);
  for (let y = 0; y < height * k; y++)
    for (let x = 0; x < width * k; x++) {
      const [r, g, b, a] = at((Math.floor(y / k) * width + Math.floor(x / k)) * 4);
      const bg = ((x >> 4) + (y >> 4)) % 2 ? 90 : 140;
      const o = (y * width * k + x) * 4;
      // r, g, b premultiplied
      img[o] = r + (bg * (255 - a)) / 255;
      img[o + 1] = g + (bg * (255 - a)) / 255;
      img[o + 2] = b + (bg * (255 - a)) / 255;
      img[o + 3] = 255;
    }
  const path = join(out, `${comp}_f${n}_${label}.png`);
  writeFileSync(path, encodePng(width * k, height * k, img));
  console.log(path);
}
write("ref", (i) => {
  const a = ref.data[i + 3];
  return [0, 1, 2].map((c) => (ref.data[i + c] * a) / 255).concat(a);
});
const dumps = existsSync(join(ROOT, "ours")) ? readdirSync(join(ROOT, "ours")) : [];
const name = dumps.find((f) => f.startsWith(`${comp}_f${n}_`));
if (name) {
  const ours = new Uint8Array(readFileSync(join(ROOT, "ours", name)));
  write("ours", (i) => [0, 1, 2].map((c) => (ours[i + c] * ours[i + 3]) / 255).concat(ours[i + 3]));
}
