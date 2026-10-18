// Scratch: measure the displacement field between the source render and the identity render.
// Reports, per sample point, the (dx, dy) in the source that best matches the identity pixel.
import { readFileSync } from "node:fs";
import { decodePng } from "../scripts/lib/png-decode.ts";

const W = 960, H = 540;
const a = decodePng(new Uint8Array(readFileSync("refs/probe/portal-cards/source.png"))).rgba;
const b = decodePng(new Uint8Array(readFileSync("refs/probe/portal-cards/identity.png"))).rgba;
const lum = (p: Uint8Array, x: number, y: number) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return -1;
  const o = (y * W + x) * 4;
  return 0.2126 * p[o] + 0.7152 * p[o + 1] + 0.0722 * p[o + 2];
};

const patchError = (x: number, y: number, dx: number, dy: number) => {
  let sum = 0, n = 0;
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const l = lum(a, x + i + dx, y + j + dy);
      if (l < 0) continue;
      sum += Math.abs(l - lum(b, x + i, y + j)); n++;
    }
  }
  return n ? sum / n : Infinity;
};

console.log("x,y            best d(source-identity)   err@best   err@0,0");
for (const [x, y] of [[480, 270], [480, 100], [480, 440], [150, 270], [810, 270], [200, 150], [760, 400], [700, 120]]) {
  let best = [0, 0], bestErr = Infinity;
  for (let dy = -40; dy <= 40; dy++) {
    for (let dx = -40; dx <= 40; dx++) {
      const e = patchError(x, y, dx, dy);
      if (e < bestErr) { bestErr = e; best = [dx, dy]; }
    }
  }
  console.log(`(${x},${y})`.padEnd(14) + `(${String(best[0]).padStart(4)},${String(best[1]).padStart(4)})`.padEnd(24) + `${bestErr.toFixed(2).padStart(8)}   ${patchError(x, y, 0, 0).toFixed(2)}`);
}

// Radial fit: does the displacement grow with distance from the centre?
console.log("\nradial: r -> |d| (expect |d| ~ r*(s-1) for a scale s about the centre)");
for (const r of [50, 100, 200, 300, 400]) {
  const x = Math.round(480 + r), y = 270;
  let best = [0, 0], bestErr = Infinity;
  for (let dy = -40; dy <= 40; dy++) {
    for (let dx = -40; dx <= 40; dx++) {
      const e = patchError(x, y, dx, dy);
      if (e < bestErr) { bestErr = e; best = [dx, dy]; }
    }
  }
  console.log(`r=${String(r).padStart(3)} -> d=(${best[0]},${best[1]})  |d|=${Math.hypot(best[0], best[1]).toFixed(1)}  implied scale=${(1 + Math.hypot(best[0], best[1]) / r).toFixed(4)}`);
}
