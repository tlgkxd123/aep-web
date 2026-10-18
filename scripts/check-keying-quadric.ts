// Black-box probing of a key's distance metric: least squares of AE's partial matte m (0 < m < 1) on the quadratic
// form of the colour's difference to the key, m = D^T M D + b, over the opaque palette cells of one quadrant.
// Prints M (in 0-1 units), b and the residuals.
//
//   node scripts/check-keying-quadric.ts <comp> <frame> <quadrant> <key r,g,b 0-255>
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";

//   --polar hex|circle: m = a dC^2 + b dH^2 + c, H in turns, C = max - min (hex) or the length of (alpha, beta)
const [comp, n, quadrant, keyArg] = process.argv.slice(2);
const polarArg = process.argv.indexOf("--polar");
const polar = polarArg > 0 ? process.argv[polarArg + 1] : "";
const key = keyArg.split(",").map((v) => Number(v) / 255);
const image = frame(comp, Number(n));

function hueChroma([r, g, b]: number[]): [number, number] {
  if (polar === "circle") {
    const a = r - (g + b) / 2;
    const be = (Math.sqrt(3) / 2) * (g - b);
    return [Math.atan2(be, a) / (2 * Math.PI), Math.hypot(a, be)];
  }
  const max = Math.max(r, g, b);
  const c = max - Math.min(r, g, b);
  if (c === 0) return [0, 0];
  const h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return [h / 6, c];
}
const [kh, kc] = hueChroma(key);
const X: number[][] = [];
const y: number[] = [];
for (const cell of keyingCells().filter((c) => c.src[3] === 255)) {
  const [px, py] = cellPoint(cell, Number(quadrant));
  const out = pixel(image, px, py);
  const m = out[0] / 255;
  if (m <= 0.02 || m >= 0.98) continue;
  const s = cell.src.slice(0, 3).map((v) => v / 255);
  if (polar) {
    const [h, c] = hueChroma(s);
    let dh = Math.abs(h - kh) % 1;
    dh = Math.min(dh, 1 - dh);
    X.push([(c - kc) ** 2, dh * dh, 1]);
  } else {
    const [r, g, b] = s.map((v, i) => v - key[i]);
    X.push([r * r, g * g, b * b, 2 * r * g, 2 * r * b, 2 * g * b, 1]);
  }
  y.push(m);
}
const k = X[0].length;
const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, row) => s + row[i] * row[j], 0)));
const v = Array.from({ length: k }, (_, i) => X.reduce((s, row, r) => s + row[i] * y[r], 0));
for (let i = 0; i < k; i++) {
  let p = i;
  for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
  [A[i], A[p]] = [A[p], A[i]];
  [v[i], v[p]] = [v[p], v[i]];
  for (let r = 0; r < k; r++) {
    if (r === i) continue;
    const f = A[r][i] / A[i][i];
    for (let c = i; c < k; c++) A[r][c] -= f * A[i][c];
    v[r] -= f * v[i];
  }
}
const w = v.map((val, i) => val / A[i][i]);
const res = X.map((row, r) => Math.abs(row.reduce((s, x, i) => s + x * w[i], 0) - y[r]) * 255).sort((a, b) => a - b);
console.log(`n=${X.length}`);
if (polar) console.log(`a=${w[0].toFixed(4)} b=${w[1].toFixed(4)} c=${w[2].toFixed(4)}`);
else console.log(`M = [[${w[0].toFixed(4)}, ${w[3].toFixed(4)}, ${w[4].toFixed(4)}], [${w[3].toFixed(4)}, ${w[1].toFixed(4)}, ${w[5].toFixed(4)}], [${w[4].toFixed(4)}, ${w[5].toFixed(4)}, ${w[2].toFixed(4)}]] b=${w[6].toFixed(4)}`);
console.log(`residual (/255): p50 ${res[Math.floor(res.length / 2)].toFixed(2)} p95 ${res[Math.floor(res.length * 0.95)].toFixed(2)} max ${res[res.length - 1].toFixed(2)}`);
