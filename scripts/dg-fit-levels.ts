// Fits a global model of Deep Glow 2's kernel to every dot fixture (4x4 white square,
// radii 0..1000, Exposure 1 and 20): N Gaussian levels with
//   sigma_i = combine(R * 2^-i / div, floor),  weight w_i (shared by every radius),
// scored in 8-bit gamma-2.2 units outside the dot. Nelder-Mead over the parameters.
//
//   node scripts/dg-fit-levels.ts [levels=8] [quadrature|linear]
import { reference } from "./dg-cpu.ts";
import { boxBlur } from "./dg-fit-kernel.ts";

const LEVELS = Number(process.argv[2] ?? 8);
const COMBINE = process.argv[3] ?? "linear";

const sets: [string, number, number[]][] = [
  ["deepglow_dot", 1, [8, 16, 32, 64, 128, 256, 512]],
  ["deepglow_dot_hot", 20, [8, 16, 32, 64, 128, 256, 512]],
  ["deepglow_radius_mid", 20, [40, 48, 56, 150, 1000]],
  ["deepglow_radius_mid_lo", 1, [40, 48, 56, 150, 1000]],
  ["deepglow_radius_small", 20, [0, 1, 2, 4, 6]],
];

interface Sample {
  x: number;
  y: number;
  v: number;
  e: number;
  r: number;
}
const samples: Sample[] = [];
for (const [comp, e, radii] of sets) {
  radii.forEach((r, f) => {
    const ref = reference(comp, f);
    const take = (x: number, y: number) => {
      const v = Math.round(ref.data[(y * ref.width + x) * 4 + 1] * 255);
      if (v < 255) samples.push({ x: x + 0.5, y: y + 0.5, v, e, r });
    };
    for (let x = 130; x < 256; x++) take(x, 128);
    for (let d = 2; d < 128; d++) take(128 + d, 128 + d);
  });
}

/**
 * Octaves sigma_k = R / div * 2^-k while sigma_k >= minSigma (the last one weighted by how far past it the
 * octave count reaches), at most LEVELS of them, each blurred further by `floor` in quadrature, each of
 * weight w * (sigma_k / 64)^slope.
 */
function levels(p: number[], r: number): [number, number][] {
  const [div, floor, minSigma, w, slope] = p;
  const count = Math.min(LEVELS, Math.log2(r / div / Math.abs(minSigma)) + 1);
  const out: [number, number][] = [];
  for (let k = 0; k < Math.ceil(count); k++) {
    const s = (r * 2 ** -k) / div;
    const weight = Math.abs(w) * Math.pow(s / 64, slope) * Math.min(1, count - k);
    out.push([COMBINE === "quadrature" ? Math.hypot(s, floor) : s + floor, weight]);
  }
  return out;
}

function predict(p: number[], q: Sample): number {
  let g = 0;
  for (const [s, w] of levels(p, q.r)) g += w * boxBlur(q.x, 126, 130, s) * boxBlur(q.y, 126, 130, s);
  return 255 * Math.pow(Math.min(1, q.e * g), 1 / 2.2);
}

function cost(p: number[]): number {
  let sum = 0;
  for (const q of samples) sum += Math.abs(predict(p, q) - q.v);
  return sum / samples.length;
}

function nelderMead(f: (p: number[]) => number, start: number[], steps: number[], iterations: number): number[] {
  let simplex = [start, ...start.map((_, i) => start.map((v, j) => (i === j ? v + steps[i] : v)))].map((p) => ({ p, c: f(p) }));
  for (let it = 0; it < iterations; it++) {
    simplex.sort((a, b) => a.c - b.c);
    const n = start.length;
    const centroid = start.map((_, j) => simplex.slice(0, n).reduce((s, v) => s + v.p[j], 0) / n);
    const worst = simplex[n];
    const at = (t: number) => centroid.map((c, j) => c + t * (worst.p[j] - c));
    const reflected = { p: at(-1), c: 0 };
    reflected.c = f(reflected.p);
    if (reflected.c < simplex[0].c) {
      const expanded = { p: at(-2), c: 0 };
      expanded.c = f(expanded.p);
      simplex[n] = expanded.c < reflected.c ? expanded : reflected;
    } else if (reflected.c < simplex[n - 1].c) simplex[n] = reflected;
    else {
      const contracted = { p: at(0.5), c: 0 };
      contracted.c = f(contracted.p);
      if (contracted.c < worst.c) simplex[n] = contracted;
      else simplex = simplex.map((v, i) => (i === 0 ? v : { p: v.p.map((x, j) => simplex[0].p[j] + 0.5 * (x - simplex[0].p[j])), c: 0 })).map((v) => ({ p: v.p, c: v.c || f(v.p) }));
    }
  }
  simplex.sort((a, b) => a.c - b.c);
  return simplex[0].p;
}

let best = [8, 0.9, 0.5, 1, 0];
for (let round = 0; round < 4; round++) {
  best = nelderMead(cost, best, best.map((v) => Math.max(0.1, Math.abs(v) * 0.2)), 600);
  const [div, floor, minSigma, w, slope] = best;
  console.log(`round ${round}: mean ${cost(best).toFixed(3)}  div ${div.toFixed(3)} floor ${floor.toFixed(3)} minSigma ${Math.abs(minSigma).toFixed(3)} w ${Math.abs(w).toFixed(3)} slope ${slope.toFixed(3)}`);
}
for (const [comp, e, radii] of sets) {
  radii.forEach((r) => {
    const s = samples.filter((q) => q.r === r && q.e === e);
    let sum = 0;
    let max = 0;
    for (const q of s) {
      const d = Math.abs(Math.round(predict(best, q)) - q.v);
      sum += d;
      max = Math.max(max, d);
    }
    console.log(`  ${comp} R=${r}: mean ${(sum / Math.max(1, s.length)).toFixed(2)} max ${max}`);
  });
}
