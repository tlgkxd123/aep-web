// Per row of a distort2 frame, the mean card point shown at opaque interior pixels minus the pixel's own card point
// (the card sits at comp (20, 15)), in After Effects' reference and in ours (written by `pixel-report.ts --dump`).
//
//   node scripts/check-distort2-rowshift.ts <comp> <frame> [col]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, mode] = process.argv.slice(2);
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const prefix = `${comp}_f${frameArg}_`;
const file = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(prefix) && f.endsWith(".rgba"));
const ours = file ? new Uint8Array(readFileSync(join(ROOT, "ours", file))) : undefined;
const { width, height } = ref;
const byColumn = mode === "col";

function shift(data: Uint8Array, line: number): string {
  let n = 0;
  let dx = 0;
  let dy = 0;
  const count = byColumn ? height : width;
  for (let k = 1; k < count - 1; k++) {
    const [x, y] = byColumn ? [line, k] : [k, line];
    const i = (y * width + x) * 4;
    const opaque = [i, i - 4, i + 4, i - width * 4, i + width * 4].every((j) => j >= 0 && j < data.length && data[j + 3] === 255);
    if (!opaque) continue;
    dx += (data[i] * 120) / 255 - (x + 0.5 - 20);
    dy += (data[i + 1] * 90) / 255 - (y + 0.5 - 15);
    n++;
  }
  return n ? `${(dx / n).toFixed(2).padStart(7)} ${(dy / n).toFixed(2).padStart(7)} (${String(n).padStart(3)})` : "      -       -      ";
}

for (let line = 0; line < (byColumn ? width : height); line++) {
  console.log(`${String(line).padStart(4)}  ref ${shift(ref.data, line)}   ours ${ours ? shift(ours, line) : "-"}`);
}
