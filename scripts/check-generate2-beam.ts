// Where After Effects' Beam starts and ends along row 60 of generate2_beam_perspective (the beam runs from x 20.5 to
// 140.5), against the linear head/tail and their perspective mappings.
//
//   node scripts/check-generate2-beam.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const L = [0.25, 0.5, 0.3, 0.2, 0.4, 1.0, 0.5];
const TIME = [0.8, 0.5, 0.5, 0.6, 0.4, 0.5, 0.25];
const T0 = [12, 4, 8, 16, 4, 10, 6];
const T1 = [4, 12, 8, 4, 16, 5, 12];

for (let f = 0; f < L.length; f++) {
  const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", "generate2_beam_perspective", `frame_${String(f).padStart(5, "0")}.tif`))));
  // Fraction of the core colour (white over the card's blue-grey) along the row.
  const cov: number[] = [];
  for (let x = 0; x < ref.width; x++) {
    const o = (60 * ref.width + x) * 4;
    cov.push(Math.max(0, (ref.data[o] - 31) / (255 - 31)));
  }
  // Sub-pixel crossings of half coverage.
  let left = NaN;
  let right = NaN;
  for (let x = 1; x < cov.length; x++) {
    if (Number.isNaN(left) && cov[x - 1] < 0.5 && cov[x] >= 0.5) left = x - 1 + 0.5 + (0.5 - cov[x - 1]) / (cov[x] - cov[x - 1]);
    if (cov[x - 1] >= 0.5 && cov[x] < 0.5) right = x - 1 + 0.5 + (cov[x - 1] - 0.5) / (cov[x - 1] - cov[x]);
  }
  const head = Math.min(1, TIME[f] * (1 + L[f]));
  const tail = Math.min(1, Math.max(0, TIME[f] * (1 + L[f]) - L[f]));
  const persp = (u: number) => (u * T0[f]) / ((1 - u) * T1[f] + u * T0[f]);
  const persp2 = (u: number) => (u * T1[f]) / ((1 - u) * T0[f] + u * T1[f]);
  const toU = (x: number) => (x - 20.5) / 120;
  console.log(
    `f${f} L ${L[f]} t ${TIME[f]} T ${T0[f]}->${T1[f]}: ae ${toU(left).toFixed(3)}..${toU(right).toFixed(3)} (x ${left.toFixed(2)}..${right.toFixed(2)})` +
      `  linear ${tail.toFixed(3)}..${head.toFixed(3)}  persp ${persp(tail).toFixed(3)}..${persp(head).toFixed(3)}  persp2 ${persp2(tail).toFixed(3)}..${persp2(head).toFixed(3)}`,
  );
}
