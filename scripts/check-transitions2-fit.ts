// Fits the alpha profile down (or across, with row=) a straight edge of a transitions2 reference frame with a Gaussian
// edge Phi((t - e) / sigma) (the edge e and sigma by least squares), printing both and the worst residual in levels.
//
//   node scripts/check-transitions2-fit.ts <comp> <frame> col=<x> | row=<y> from=<i0> to=<i1> [invert]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((s) => s.split("=")));
const { width, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const from = Number(opt.from);
const to = Number(opt.to);
const samples: [number, number][] = [];
for (let i = from; i <= to; i++) {
  const index = "col" in opt ? i * width + Number(opt.col) : Number(opt.row) * width + i;
  const a = data[index * 4 + 3] / 255;
  samples.push([i + 0.5, "invert" in opt ? 1 - a : a]);
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x < 0 ? -y : y;
}
const phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

let best = { e: 0, sigma: 0, error: Infinity, worst: 0 };
for (let e = from; e <= to + 1; e += 0.01) {
  for (let sigma = 0.2; sigma <= 30; sigma *= 1.005) {
    let error = 0;
    let worst = 0;
    for (const [t, a] of samples) {
      const r = phi((t - e) / sigma) - a;
      error += r * r;
      worst = Math.max(worst, Math.abs(r));
    }
    if (error < best.error) best = { e, sigma, error, worst };
  }
}
console.log(`edge ${best.e.toFixed(2)} sigma ${best.sigma.toFixed(3)} worst ${(best.worst * 255).toFixed(1)} levels`);
