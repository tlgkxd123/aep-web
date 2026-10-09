// Which composite Deep Glow 2 uses, from deepglow_exposure (6 ramps black -> colour, radius 16,
// Exposure 0, 0.25, 2, 6, 20): in the strips' flat interior the glow is the source's linear
// light times a gain, so each hypothesis gets the gain that fits it best per exposure.
//
//   node scripts/dg-composite.ts [comp=deepglow_exposure] [exposures=0,0.25,2,6,20]
import { reference, source } from "./dg-cpu.ts";

const [comp = "deepglow_exposure", expArg = "0,0.25,2,6,20"] = process.argv.slice(2);
const exposures = expArg.split(",").map(Number);
const src = source(comp, 0);
const G = 2.2;
const lin = (v: number) => Math.pow(Math.max(0, v), G);
const enc = (v: number) => Math.pow(Math.min(1, Math.max(0, v)), 1 / G);
const models: Record<string, (s: number, g: number) => number> = {
  "screen gamma": (s, g) => 1 - (1 - s) * (1 - enc(g * lin(s))),
  "add linear": (s, g) => enc(lin(s) + g * lin(s)),
  "screen linear": (s, g) => enc(1 - (1 - lin(s)) * (1 - g * lin(s))),
  "add gamma": (s, g) => Math.min(1, s + enc(g * lin(s))),
};
if (process.env.DG_GRID) {
  // Screen in gamma with decode exponent p and encode exponent q, the best gain per exposure.
  const frames = exposures.map((_, fi) => reference(comp, fi));
  for (const p of [2.0, 2.1, 2.2, 2.3, 2.4]) {
    for (const q of [2.0, 2.1, 2.2, 2.3, 2.4]) {
      let total = 0;
      const gains: string[] = [];
      frames.forEach((ref) => {
        const samples: [number, number][] = [];
        for (let k = 0; k < 6; k++) {
          for (let x = 24; x < src.width - 24; x += 2) {
            for (let c = 0; c < 3; c++) {
              const i = ((16 * k + 8) * src.width + x) * 4 + c;
              if (src.data[i] > 4 / 255) samples.push([src.data[i], Math.round(ref.data[i] * 255)]);
            }
          }
        }
        let best = { g: 0, err: Infinity };
        for (let g = 0; g <= 80; g += g < 0.05 ? 0.0005 : g < 2 ? 0.005 : 0.05) {
          let err = 0;
          for (const [s, v] of samples) err += Math.abs(Math.round(255 * (1 - (1 - s) * (1 - Math.pow(Math.min(1, g * Math.pow(s, p)), 1 / q)))) - v);
          if (err < best.err) best = { g, err };
        }
        total += best.err / samples.length;
        gains.push(best.g.toFixed(4));
      });
      console.log(`p ${p} q ${q}: mean ${(total / frames.length).toFixed(3)} gains ${gains.join(" ")}`);
    }
  }
  process.exit(0);
}
for (const [fi, e] of exposures.entries()) {
  const ref = reference(comp, fi);
  const samples: [number, number][] = [];
  for (let k = 0; k < 6; k++) {
    for (const y of [16 * k + 6, 16 * k + 9]) {
      for (let x = 24; x < src.width - 24; x += 2) {
        for (let c = 0; c < 3; c++) {
          const i = (y * src.width + x) * 4 + c;
          if (src.data[i] > 4 / 255) samples.push([src.data[i], Math.round(ref.data[i] * 255)]);
        }
      }
    }
  }
  const line = Object.entries(models).map(([name, f]) => {
    let best = { g: 0, err: Infinity };
    for (let g = 0; g <= 80; g += g < 2 ? 0.005 : 0.05) {
      let err = 0;
      for (const [s, v] of samples) err += Math.abs(Math.round(255 * f(s, g)) - v);
      if (err < best.err) best = { g, err };
    }
    return `${name}: g ${best.g.toFixed(3)} (${(best.g / Math.max(e, 1e-9)).toFixed(3)}/E) err ${(best.err / samples.length).toFixed(3)}`;
  });
  console.log(`E ${e}: ${line.join(" | ")}`);
}
