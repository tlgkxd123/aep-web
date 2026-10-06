// Prints the tallest drawn column of reference frames (x, top y, height), for fitting bar heights.
//
//   node scripts/ref-peak.ts <comp@frame> [<comp@frame>...]
import { existsSync, readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

for (const spec of process.argv.slice(2)) {
  const [comp, frame] = spec.split("@");
  const path = framePath(comp, Number(frame));
  if (!existsSync(path)) {
    console.log(`${spec}: no reference`);
    continue;
  }
  const t = readTiff(new Uint8Array(readFileSync(path)));
  let best = { x: -1, top: t.height, bottom: 0 };
  for (let x = 0; x < t.width; x++) {
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < t.height; y++) {
      if (t.data[(y * t.width + x) * 4 + 3] < 128) continue;
      if (top < 0) top = y;
      bottom = y;
    }
    if (top >= 0 && bottom - top > best.bottom - best.top) best = { x, top, bottom };
  }
  console.log(`${spec}: tallest column x=${best.x} y=${best.top}..${best.bottom} (${best.bottom - best.top + 1}px)`);
}
