// Fits CC Jaws' tooth profile f (a Fourier series over its period, the column sums being box averages of the edge)
// and the parting m to a transitions2 reference frame at Direction 0: the upper jaw's edge is at cy - m + f(x - cx),
// the lower one's at cy + m - f(x - cx + P/2).
//
//   node scripts/check-transitions2-wave.ts <comp> <frame> <cx> <cy> <period> [terms=4]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, cxs, cys, ps, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((s) => s.split("=")));
const [cx, cy, period] = [Number(cxs), Number(cys), Number(ps)];
const terms = Number(opt.terms ?? 4);
const { width, height, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3] / 255;

const rows: { basis: number[]; value: number }[] = [];
const basisAt = (a: number, sign: number) => {
  const out = [sign];
  for (let k = 1; k <= terms; k++) {
    const q = (2 * Math.PI * k) / period;
    const box = Math.sin(q / 2) / (q / 2);
    out.push(Math.cos(q * a) * box * -sign, Math.sin(q * a) * box * -sign);
  }
  return out;
};
for (let x = 0; x < width; x++) {
  let head = 0;
  for (let y = 0; y < height && alpha(x, y) > 0; y++) head += alpha(x, y);
  let tail = 0;
  for (let y = height - 1; y >= 0 && alpha(x, y) > 0; y--) tail += alpha(x, y);
  const a = x + 0.5 - cx;
  if (head > 0.5 && head < height - 0.5) rows.push({ basis: basisAt(a, -1), value: head - cy });
  if (tail > 0.5 && tail < height - 0.5) rows.push({ basis: basisAt(a + period / 2, 1), value: height - tail - cy });
}
const n = 1 + 2 * terms;
const ata = Array.from({ length: n }, () => new Array(n + 1).fill(0));
for (const { basis, value } of rows) {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) ata[i][j] += basis[i] * basis[j];
    ata[i][n] += basis[i] * value;
  }
}
for (let i = 0; i < n; i++) {
  let pivot = i;
  for (let r = i + 1; r < n; r++) if (Math.abs(ata[r][i]) > Math.abs(ata[pivot][i])) pivot = r;
  [ata[i], ata[pivot]] = [ata[pivot], ata[i]];
  for (let r = 0; r < n; r++) {
    if (r === i) continue;
    const f = ata[r][i] / ata[i][i];
    for (let c = i; c <= n; c++) ata[r][c] -= f * ata[i][c];
  }
}
const sol = ata.map((row, i) => row[n] / row[i]);
let sq = 0;
let worst = 0;
for (const { basis, value } of rows) {
  const r = basis.reduce((s, b, i) => s + b * sol[i], 0) - value;
  sq += r * r;
  worst = Math.max(worst, Math.abs(r));
}
console.log(`m ${sol[0].toFixed(3)}  rms ${Math.sqrt(sq / rows.length).toFixed(3)}  worst ${worst.toFixed(3)}  (${rows.length} edges)`);
for (let k = 1; k <= terms; k++) console.log(`k${k}: cos ${sol[2 * k - 1].toFixed(4)}  sin ${sol[2 * k].toFixed(4)}`);
