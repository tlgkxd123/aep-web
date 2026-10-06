// Prints Remove Color Matting samples from the fxextra_rcm fixture: source straight RGBA
// and After Effects' output per quadrant (black, black + clipping, white, purple + clipping).
//
//   node scripts/fxextra-fit-rcm.ts
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const COLORS = [[1, 0, 0], [1, 0.5, 0], [0.2, 0.8, 0.2], [0.2, 0.4, 1], [1, 1, 1], [0.1, 0.1, 0.1], [0.8, 0.2, 0.6], [0.5, 0.5, 0.5], [0.05, 0.3, 0.2], [0.9, 0.9, 0.2]];
const OPACITIES = [10, 25, 40, 50, 60, 75, 90, 100];
const tiff = readTiff(new Uint8Array(readFileSync(framePath("fxextra_rcm", 0))));
for (let row = 0; row < 15; row++) {
  for (let col = 0; col < 20; col++) {
    if ((row + col) % 7 === 3 || row > 3) continue;
    const src = [...COLORS[(col + 3 * row) % 10].map((v) => Math.round(v * 255)), Math.round((OPACITIES[(2 * col + row) % 8] / 100) * 255)];
    const outs = [0, 1, 2, 3].map((q) => {
      const x = (q % 2) * 160 + col * 8 + 4;
      const y = Math.floor(q / 2) * 120 + row * 8 + 4;
      const i = (y * tiff.width + x) * 4;
      return [...tiff.data.subarray(i, i + 4)].join(",").padEnd(15);
    });
    console.log(`${src.join(",").padEnd(15)} -> ${outs.join(" | ")}`);
  }
}
