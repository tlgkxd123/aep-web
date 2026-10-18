// Writes a frame of a perspective-suite comp as PNGs for inspection: After
// Effects' reference and, when pixel-report --dump wrote it, ours, into
// refs/view/<comp>_f<frame>_{ref,ours}.png, scaled up by an integer factor.
//
//   node scripts/check-perspective-view.ts <comp> <frame> [zoom]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng } from "./lib/png.ts";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameText, zoomText = "2"] = process.argv.slice(2);
const frame = Number(frameText);
const zoom = Math.max(1, Math.round(Number(zoomText)));
const out = join(ROOT, "view");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Image viewers cache by path; every run writes new names.
const run = Date.now().toString(36).slice(-5);

function write(name: string, width: number, height: number, rgba: Uint8Array): void {
  const big = new Uint8Array(width * zoom * height * zoom * 4);
  for (let y = 0; y < height * zoom; y++) {
    for (let x = 0; x < width * zoom; x++) {
      const s = ((Math.floor(y / zoom) * width + Math.floor(x / zoom)) * 4);
      big.set(rgba.subarray(s, s + 4), (y * width * zoom + x) * 4);
    }
  }
  const path = join(out, `${comp}_f${frame}_${name}_${run}.png`);
  writeFileSync(path, encodePng(width * zoom, height * zoom, big));
  console.log(path);
}

const ref = existsSync(framePath(comp, frame)) ? readTiff(new Uint8Array(readFileSync(framePath(comp, frame)))) : undefined;
if (ref) write("ref", ref.width, ref.height, ref.data);
const dumps = join(ROOT, "ours");
const file = existsSync(dumps) ? readdirSync(dumps).find((f) => f.startsWith(`${comp}_f${frame}_`)) : undefined;
if (file) {
  const [width, height] = file.slice(file.lastIndexOf("_") + 1, -".rgba".length).split("x").map(Number);
  const data = new Uint8Array(readFileSync(join(dumps, file)));
  if (ref && ref.width === width && ref.height === height) {
    // The worst premultiplied channel difference times 8, red where it exceeds the pixel criterion's 3/255.
    const diff = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 4) {
      let worst = 0;
      for (let c = 0; c < 4; c++) {
        const a = c === 3 ? ref.data[i + 3] : (ref.data[i + c] * ref.data[i + 3]) / 255;
        const b = c === 3 ? data[i + 3] : (data[i + c] * data[i + 3]) / 255;
        worst = Math.max(worst, Math.abs(a - b));
      }
      const v = Math.min(255, worst * 8);
      diff.set(worst > 3 ? [255, v / 2, v / 2, 255] : [v, v, v, 255], i);
    }
    write("diff", width, height, diff);
  }
  write("ours", width, height, data);
}
