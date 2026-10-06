// Converts reference frames to PNG (composited over black) for viewing.
//
//   node scripts/ref-png.ts <out-dir> <comp@frame> [<comp@frame>...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { framePath } from "./lib/suites.ts";
import { encodePng } from "./lib/png.ts";
import { readTiff } from "./lib/tiff.ts";

const [out, ...frames] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
for (const spec of frames) {
  const [comp, frame] = spec.split("@");
  const tiff = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
  const rgba = new Uint8Array(tiff.data.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = tiff.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(tiff.data[i + c] * a);
    rgba[i + 3] = 255;
  }
  writeFileSync(join(out, `${comp}_${frame}.png`), encodePng(tiff.width, tiff.height, rgba));
  console.log(`${comp}@${frame}: ${tiff.width}x${tiff.height}`);
}
