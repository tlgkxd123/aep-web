// Scratch: decisively fit the scale the identity render applies to the source image.
// For a candidate scale s about the comp centre, identity(x) should equal source(centre + (x-centre)/s).
// Full-frame mean absolute difference; no patch matching (which is degenerate on a flat sky).
import { readFileSync } from "node:fs";
import { decodePng } from "../scripts/lib/png-decode.ts";

const W = 960, H = 540, CX = 480, CY = 270;
const src = decodePng(new Uint8Array(readFileSync("refs/probe/portal-cards/source.png"))).rgba;
const idn = decodePng(new Uint8Array(readFileSync("refs/probe/portal-cards/identity.png"))).rgba;

const sample = (p: Uint8Array, x: number, y: number, c: number) => {
  const xi = Math.min(W - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(H - 1, Math.max(0, Math.round(y)));
  return p[(yi * W + xi) * 4 + c];
};

function meanDiffForScale(s: number): number {
  let sum = 0, n = 0;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const ux = CX + (x - CX) / s;
      const uy = CY + (y - CY) / s;
      for (let c = 0; c < 3; c++) {
        sum += Math.abs(idn[(y * W + x) * 4 + c] - sample(src, ux, uy, c));
        n++;
      }
    }
  }
  return sum / n;
}

const results: [number, number][] = [];
for (let s = 0.60; s <= 1.4001; s += 0.005) results.push([Number(s.toFixed(3)), meanDiffForScale(s)]);
results.sort((a, b) => a[1] - b[1]);
console.log("best-fitting scales (identity = source scaled by s about the centre):");
for (const [s, d] of results.slice(0, 8)) console.log(`  s=${s.toFixed(3)}  mean|diff|=${d.toFixed(3)}`);
console.log(`\nreference: s=1.000 gives mean|diff|=${meanDiffForScale(1).toFixed(3)}`);
console.log(`size for zoom=100 (fallback) = 1.5*1.00*0.62 = ${(1.5 * 1 * 0.62).toFixed(4)}`);
console.log(`size for zoom=100/(1.5*0.62)  = 1.5*1.075269*0.62 = ${(1.5 * (100 / (1.5 * 0.62)) / 100 * 0.62).toFixed(4)}`);
