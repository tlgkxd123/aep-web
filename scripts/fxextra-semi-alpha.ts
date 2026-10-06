// Lists reference frames of all suites with many semi-transparent pixels (0 < alpha < 255),
// i.e. the frames whose comparison depends on how the TIFF alpha is interpreted.
//
//   node scripts/fxextra-semi-alpha.ts [min count]
import { existsSync, readFileSync } from "node:fs";
import { framePath, loadSuites } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const min = Number(process.argv[2] ?? 200);
for (const suite of loadSuites()) {
  for (const { comp, frames } of suite.comps) {
    const frame = frames[0];
    if (!existsSync(framePath(comp, frame))) continue;
    const { width, height, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
    let semi = 0;
    let coloured = 0;
    for (let p = 0; p < width * height; p++) {
      const a = data[p * 4 + 3];
      if (a > 0 && a < 255) {
        semi++;
        if (data[p * 4] + data[p * 4 + 1] + data[p * 4 + 2] > 30) coloured++;
      }
    }
    if (semi >= min) console.log(`${suite.file.padEnd(28)} ${comp.padEnd(40)} semi ${semi} (coloured ${coloured}) of ${width * height}`);
  }
}
