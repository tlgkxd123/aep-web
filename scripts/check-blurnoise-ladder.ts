// Reads the blurnoise ladder probes (patches k = 1..40 levels above grey 128, every 8 pixels, grey on top and red
// only below): for Smart Blur's Edge Only frames, which patches After Effects outlines; for the blur frames, the
// red channel at each patch's centre.
//
//   node scripts/check-blurnoise-ladder.ts <comp> <frames> [--ours]   (frames: 0,1,2 or 0-11; --ours reads our
//   render that pixel-report.ts --dump wrote instead of the reference)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, framesArg] = process.argv.slice(2);
if (!comp || !framesArg) throw new Error("usage: node scripts/check-blurnoise-ladder.ts <comp> <frames>");
const frames = framesArg.includes("-")
  ? (([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))(framesArg.split("-").map(Number))
  : framesArg.split(",").map(Number);

const oursDir = join(ROOT, "ours");
const oursOf = (frame: number) => {
  const file = existsSync(oursDir) ? readdirSync(oursDir).find((f) => f.startsWith(`${comp}_f${frame}_`)) : undefined;
  return file ? new Uint8Array(readFileSync(join(oursDir, file))) : undefined;
};

for (const frame of frames) {
  const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
  const ours = oursOf(frame);
  const red = (x: number, y: number) => ref.data[(y * ref.width + x) * 4];
  if (ours && process.argv.includes("--ours")) ref.data.set(ours.subarray(0, ref.data.length));
  const outlined = (k: number, top: number) => {
    const x0 = 8 * (k - 1) + 2;
    for (let y = top - 1; y <= top + 20; y++) for (let x = x0 - 1; x <= x0 + 4; x++) if (red(x, y) > 200 && ref.data[(y * ref.width + x) * 4 + 1] > 200) return true;
    return false;
  };
  const marks = (top: number) => Array.from({ length: 40 }, (_, i) => (outlined(i + 1, top) ? "#" : ".")).join("");
  const centres = (top: number) => Array.from({ length: 40 }, (_, i) => red(8 * i + 3, top + 10) - 128).join(" ");
  if (comp.includes("smart_ladder") && !comp.includes("normal")) console.log(`@${frame} grey ${marks(5)}  red ${marks(35)}`);
  else console.log(`@${frame} grey: ${centres(5)}\n   red: ${centres(35)}`);
}
