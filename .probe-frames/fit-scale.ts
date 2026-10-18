// Scratch: fit the affine transform (scale about a centre, plus translation) that maps the
// source render onto the identity render. A pure scale s about centre c gives, for each sample
// at radius r from c, an optimal source offset d with |d| = r*(s-1).
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
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
    const l = lum(a, x + i + dx, y + j + dy);
    if (l < 0) continue;
    sum += Math.abs(l - lum(b, x + i, y + j)); n++;
  }
  return n ? sum / n : Infinity;
};
const bestOffset = (x: number, y: number) => {
  let best = [0, 0], bestErr = Infinity;
  for (let dy = -400; dy <= 400; dy += 1) for (let dx = -400; dx <= 400; dx += 1) {
    const e = patchError(x, y, dx, dy);
    if (e < bestErr) { bestErr = e; best = [dx, dy]; }
  }
  return { d: best, err: bestErr };
};

// Horizontal scan through the centre row: d(x) should be linear in x for a pure scale.
console.log("x      d(x)            err     (linear in x => scale about a centre)");
const pts: [number, number][] = [];
for (const x of [80, 200, 320, 440, 520, 640, 760, 880]) {
  const { d, err } = bestOffset(x, 270);
  pts.push([x, d[0]]);
  console.log(`${String(x).padStart(4)}   dx=${String(d[0]).padStart(5)} dy=${String(d[1]).padStart(4)}   ${err.toFixed(2)}`);
}
// Least-squares fit d(x) = m*x + c  =>  scale s = 1 + m, centre x0 = -c/m.
let sx = 0, sy = 0, sxx = 0, sxy = 0;
for (const [x, d] of pts) { sx += x; sy += d; sxx += x * x; sxy += x * d; }
const n = pts.length;
const m = (n * sxy - sx * sy) / (n * sxx - sx * sx);
const c = (sy - m * sx) / n;
console.log(`\nfit: dx = ${m.toFixed(5)} * x + ${c.toFixed(2)}`);
console.log(`implied scale s = 1 + m = ${(1 + m).toFixed(5)}`);
console.log(`implied centre x0 = -c/m = ${(-c / m).toFixed(1)}  (comp centre is 480)`);
console.log(`if Zoom=100 is 1:1 then the renderer's zoom factor is ${(1 + m).toFixed(5)}`);
console.log(`\n100/(1.5*0.62) = ${(100 / (1.5 * 0.62)).toFixed(4)}  -> 1/that = ${(1.5 * 0.62).toFixed(4)}; 1/(that) * 1.5 = ${(1.5 / (100 / (1.5 * 0.62))).toFixed(4)}`);
