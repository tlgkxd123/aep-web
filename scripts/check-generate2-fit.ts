// Fits candidate feather profiles to coverage samples measured on After Effects' renders (scratch tool for
// generateExtra.ts): prints each model's worst error in 1/255 for its best width parameters.
//
//   node scripts/check-generate2-fit.ts
type Sample = { f: number; x: number; cdf: number };
const samples: Sample[] = [];
const f8 = [0.009, 0.036, 0.076, 0.129, 0.196, 0.272, 0.348, 0.438, 0.522, 0.603, 0.688, 0.763, 0.835, 0.893, 0.942, 0.978, 0.996, 1];
f8.forEach((cdf, i) => samples.push({ f: 8, x: 22.25 + i - 30, cdf }));
const f4 = [0.004, 0.031, 0.116, 0.241, 0.384, 0.54, 0.692, 0.83, 0.933, 0.991];
f4.forEach((cdf, i) => samples.push({ f: 4, x: -4.75 + i, cdf }));

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const ss = (t: number) => {
  const u = clamp(t);
  return u * u * (3 - 2 * u);
};
/** CDF of a kernel given as samples on a fine grid, convolved numerically. */
function boxConv(widths: number[]): (x: number) => number {
  const step = 0.01;
  const span = widths.reduce((s, w) => s + w, 0) / 2 + 1;
  const n = Math.ceil((2 * span) / step);
  let k = new Float64Array(n);
  k[Math.floor(n / 2)] = 1;
  for (const w of widths) {
    const r = Math.max(1, Math.round(w / step / 2));
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = -r; j < r; j++) if (i + j >= 0 && i + j < n) s += k[i + j];
      next[i] = s / (2 * r);
    }
    k = next;
  }
  const cdf = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) cdf[i] = acc += k[i];
  return (x: number) => {
    const i = Math.round((x + span) / step);
    return i < 0 ? 0 : i >= n ? 1 : cdf[i];
  };
}
const models: Record<string, (a: number, b: number, f: number) => (x: number) => number> = {
  smoothstep: (a, _b, f) => (x) => ss((x + a * f + _b) / (2 * (a * f + _b))),
  gaussTrunc: (a, b, f) => {
    const sigma = a * f + b;
    const R = 1.2 * f + 1;
    const conv = (x: number) => {
      let s = 0;
      let t = 0;
      for (let u = -R; u <= R; u += 0.01) {
        const w = Math.exp((-0.5 * u * u) / (sigma * sigma));
        t += w;
        if (u < x) s += w;
      }
      return s / t;
    };
    return conv;
  },
  boxes: (a, b, f) => boxConv([a * f, b * f, 1]),
  boxes3: (a, b, f) => boxConv([a * f + b, a * f + b, a * f + b, 1]),
};
for (const [name, model] of Object.entries(models)) {
  let best = { err: Infinity, a: 0, b: 0 };
  for (let a = 0.2; a <= 2; a += 0.05)
    for (let b = name === "boxes" ? 0.2 : -1; b <= (name === "boxes" ? 2 : 2); b += name === "boxes" ? 0.05 : 0.25) {
      const fns = new Map<number, (x: number) => number>();
      let err = 0;
      for (const s of samples) {
        if (!fns.has(s.f)) fns.set(s.f, model(a, b, s.f));
        err = Math.max(err, Math.abs(fns.get(s.f)!(s.x) - s.cdf));
      }
      if (err < best.err) best = { err, a, b };
    }
  console.log(`${name.padEnd(12)} worst ${(best.err * 255).toFixed(1)}/255  a ${best.a.toFixed(2)}  b ${best.b.toFixed(2)}`);
}
