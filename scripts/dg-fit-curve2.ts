// Flat-area composite check on deepglow_exposure's white strip: out = 1 - (1 - s^(p/2.2)) (1 - (E W s^p)^(1/2.2)),
// grid over p and W; prints the mean |error| per exposure for the best pair.
//
//   node scripts/dg-fit-curve2.ts [row=8] [channel=1]
import { reference, source } from "./dg-cpu.ts";

const row = Number(process.argv[2] ?? 8);
const ch = Number(process.argv[3] ?? 1);
const exposures = [0, 0.25, 2, 6, 20];
const refs = exposures.map((_, f) => reference("deepglow_exposure", f));
const src = source("deepglow_exposure", 0);
const samples: { s: number; e: number; v: number }[] = [];
for (let x = 2; x < src.width - 2; x++) {
  const i = (row * src.width + x) * 4 + ch;
  exposures.forEach((e, f) => samples.push({ s: src.data[i], e, v: Math.round(refs[f].data[i] * 255) }));
}
const model = (s: number, e: number, p: number, w: number) => 1 - (1 - Math.pow(s, p / 2.2)) * (1 - Math.pow(Math.min(1, e * w * Math.pow(s, p)), 1 / 2.2));
let best = { err: Infinity, p: 0, w: 0 };
for (let p = 1.9; p <= 2.3; p += 0.005) {
  for (let w = 1; w <= 4; w += 0.01) {
    let err = 0;
    for (const q of samples) err += Math.abs(Math.round(255 * model(q.s, q.e, p, w)) - q.v);
    if (err < best.err) best = { err, p, w };
  }
}
console.log(`p ${best.p.toFixed(3)} W ${best.w.toFixed(2)} mean ${(best.err / samples.length).toFixed(3)}`);
for (const e of exposures) {
  const list = samples.filter((q) => q.e === e);
  const d = list.map((q) => Math.round(255 * model(q.s, q.e, best.p, best.w)) - q.v);
  console.log(`  E ${e}: mean |err| ${(d.reduce((a, b) => a + Math.abs(b), 0) / d.length).toFixed(3)}  signed ${(d.reduce((a, b) => a + b, 0) / d.length).toFixed(3)}`);
}
