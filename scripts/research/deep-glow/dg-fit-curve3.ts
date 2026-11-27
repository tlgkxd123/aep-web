// Flat-area composite on deepglow_exposure (all strips and channels): Screen in a power space a,
//   out = (1 - (1 - T^a)(1 - min(1, E W D)^(a/2.2)))^(1/a),  D = s^p,  T = s^(p/2.2),
// grid over a, p and W; prints the best and its error per exposure.
import { reference, source } from "./dg-cpu.ts";

const exposures = [0, 0.25, 2, 6, 20];
const refs = exposures.map((_, f) => reference("deepglow_exposure", f));
const src = source("deepglow_exposure", 0);
const samples: { s: number; e: number; v: number }[] = [];
for (let k = 0; k < 6; k++) {
  const y = 8 + 16 * k;
  for (let x = 4; x < src.width - 4; x += 3) {
    for (let c = 0; c < 3; c++) {
      const i = (y * src.width + x) * 4 + c;
      if (src.data[i] < 8 / 255) continue;
      exposures.forEach((e, f) => samples.push({ s: src.data[i], e, v: Math.round(refs[f].data[i] * 255) }));
    }
  }
}
const model = (s: number, e: number, a: number, p: number, w: number) => {
  const t = Math.pow(s, p / 2.2);
  const g = Math.pow(Math.min(1, e * w * Math.pow(s, p)), a / 2.2);
  return Math.pow(1 - (1 - Math.pow(t, a)) * (1 - g), 1 / a);
};
let best = { err: Infinity, a: 0, p: 0, w: 0 };
for (let a = 0.6; a <= 2.21; a += 0.1) {
  for (let p = 2.0; p <= 2.25; p += 0.025) {
    for (let w = 1; w <= 4; w += 0.05) {
      let err = 0;
      for (const q of samples) err += Math.abs(Math.round(255 * model(q.s, q.e, a, p, w)) - q.v);
      if (err < best.err) best = { err, a, p, w };
    }
  }
}
console.log(`a ${best.a.toFixed(2)} p ${best.p.toFixed(3)} W ${best.w.toFixed(2)} mean ${(best.err / samples.length).toFixed(3)} (n ${samples.length})`);
for (const e of exposures) {
  const d = samples.filter((q) => q.e === e).map((q) => Math.round(255 * model(q.s, q.e, best.a, best.p, best.w)) - q.v);
  console.log(`  E ${e}: mean |err| ${(d.reduce((x, y) => x + Math.abs(y), 0) / d.length).toFixed(3)} signed ${(d.reduce((x, y) => x + y, 0) / d.length).toFixed(3)}`);
}
