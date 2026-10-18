// Diff sheets (reference | ours | diff x 8, enlarged) for generate2 comps into the temp folder, from the frames
// `pixel-report.ts --dump` left in refs/ours (refs/diff is emptied by every pixel-report run).
//
//   node scripts/check-generate2-sheet.ts <comp> <frame,frame,...> [zoom]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSheet, compareFrames } from "./lib/pixel-criterion.ts";
import { encodePng } from "./lib/png.ts";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameList = "0", zoomArg = "3"] = process.argv.slice(2);
const zoom = Number(zoomArg);
const outDir = join(tmpdir(), "g2sheets");
mkdirSync(outDir, { recursive: true });
for (const frame of frameList.split(",").map(Number)) {
  const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`))));
  const dumped = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`));
  const ours = dumped && existsSync(join(ROOT, "ours", dumped)) ? new Uint8Array(readFileSync(join(ROOT, "ours", dumped))) : new Uint8Array(ref.data.length);
  const { diff } = compareFrames(ref.data, ours, ref.width, ref.height);
  const sheet = diffSheet(ref.data, ours, diff, ref.width, ref.height);
  const w = ref.width * 3;
  const h = ref.height;
  const big = new Uint8Array(w * zoom * h * zoom * 4);
  for (let y = 0; y < h * zoom; y++) {
    for (let x = 0; x < w * zoom; x++) {
      const s = (Math.floor(y / zoom) * w + Math.floor(x / zoom)) * 4;
      big.set(sheet.subarray(s, s + 4), (y * w * zoom + x) * 4);
    }
  }
  const path = join(outDir, `${comp}_f${frame}.png`);
  writeFileSync(path, encodePng(w * zoom, h * zoom, big));
  console.log(path);
}
