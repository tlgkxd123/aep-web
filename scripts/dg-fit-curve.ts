// Grid-searches the flat-area response of Deep Glow 2 on the white ramp strip of
// deepglow_exposure (Radius 16): decode gamma, encode gamma, flat gain W and composite.
//
//   node scripts/dg-fit-curve.ts [row=8] [channel=1]
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
const composites = {
  gammaScreen: (s: number, g: number, gd: number, ge: number) => 1 - (1 - Math.pow(s, gd / ge)) * (1 - Math.pow(Math.min(1, g), 1 / ge)),
  linScreen: (s: number, g: number, gd: number, ge: number) => Math.pow(1 - (1 - Math.pow(s, gd)) * (1 - Math.min(1, g)), 1 / ge),
  linAdd: (s: number, g: number, gd: number, ge: number) => Math.pow(Math.min(1, Math.pow(s, gd) + g), 1 / ge),
};
for (const [name, fn] of Object.entries(composites)) {
  let best = { err: Infinity, gd: 0, ge: 0, w: 0 };
  for (let gd = 1.8; gd <= 2.61; gd += 0.02) {
    for (let ge = 1.8; ge <= 2.61; ge += 0.02) {
      for (let w = 1; w <= 4; w += 0.02) {
        let err = 0;
        for (const p of samples) {
          const g = p.e * w * Math.pow(p.s, gd);
          err += Math.abs(Math.round(255 * fn(p.s, g, gd, ge)) - p.v);
        }
        if (err < best.err) best = { err, gd, ge, w };
      }
    }
  }
  console.log(`${name}: mean ${(best.err / samples.length).toFixed(3)} decode ${best.gd.toFixed(2)} encode ${best.ge.toFixed(2)} W ${best.w.toFixed(2)}`);
}
