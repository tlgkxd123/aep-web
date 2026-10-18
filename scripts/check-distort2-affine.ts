// Fits the affine map from comp pixels to card pixels that After Effects' reference frame of a distort2 comp shows,
// reading the card's source point from its red (column) and green (row) ramps at opaque pixels.
//
//   node scripts/check-distort2-affine.ts <comp> <frame> [x0 y0 x1 y1]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, ...box] = process.argv.slice(2);
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const [x0, y0, x1, y1] = box.length === 4 ? box.map(Number) : [0, 0, ref.width - 1, ref.height - 1];

const rows: number[][] = [];
const sx: number[] = [];
const sy: number[] = [];
for (let y = y0; y <= y1; y++) {
  for (let x = x0; x <= x1; x++) {
    const i = (y * ref.width + x) * 4;
    if (ref.data[i + 3] < 255) continue;
    const near = [-1, 1].every((d) => ref.data[i + 3 + d * 4] === 255 && ref.data[i + 3 + d * ref.width * 4] === 255);
    if (!near) continue;
    rows.push([x + 0.5, y + 0.5, 1]);
    sx.push((ref.data[i] * 120) / 255);
    sy.push((ref.data[i + 1] * 90) / 255);
  }
}

function solve(target: number[]): number[] {
  const a = [0, 1, 2].map((r) => [0, 1, 2].map((c) => rows.reduce((s, v) => s + v[r] * v[c], 0)));
  const b = [0, 1, 2].map((r) => rows.reduce((s, v, k) => s + v[r] * target[k], 0));
  for (let c = 0; c < 3; c++) {
    for (let r = c + 1; r < 3; r++) {
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 3; k++) a[r][k] -= f * a[c][k];
      b[r] -= f * b[c];
    }
  }
  const out = [0, 0, 0];
  for (let r = 2; r >= 0; r--) out[r] = (b[r] - [0, 1, 2].slice(r + 1).reduce((s, k) => s + a[r][k] * out[k], 0)) / a[r][r];
  return out;
}

const fx = solve(sx);
const fy = solve(sy);
const residual = (f: number[], t: number[]) => Math.sqrt(rows.reduce((s, v, k) => s + (f[0] * v[0] + f[1] * v[1] + f[2] - t[k]) ** 2, 0) / rows.length);
console.log(`pixels ${rows.length}`);
console.log(`source x = ${fx[0].toFixed(5)} x + ${fx[1].toFixed(5)} y + ${fx[2].toFixed(4)}   rms ${residual(fx, sx).toFixed(3)}`);
console.log(`source y = ${fy[0].toFixed(5)} x + ${fy[1].toFixed(5)} y + ${fy[2].toFixed(4)}   rms ${residual(fy, sy).toFixed(3)}`);
