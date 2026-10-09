// Exposure-0 transfer of Deep Glow 2 (deepglow_exposure@0): per source code value, the output
// code value for every strip and channel, and the exponent q with out = s^q.
import { reference, source } from "./dg-cpu.ts";

const ref = reference("deepglow_exposure", 0);
const src = source("deepglow_exposure", 0);
const map = new Map<number, number[]>();
for (let k = 0; k < 6; k++) {
  const y = 8 + 16 * k;
  for (let x = 0; x < src.width; x++) {
    for (let c = 0; c < 3; c++) {
      const i = (y * src.width + x) * 4 + c;
      const s = Math.round(src.data[i] * 255);
      if (s < 4) continue;
      if (!map.has(s)) map.set(s, []);
      map.get(s)!.push(Math.round(ref.data[i] * 255));
    }
  }
}
for (const s of [...map.keys()].sort((a, b) => a - b)) {
  if (s % 6) continue;
  const outs = map.get(s)!;
  const uniq = [...new Set(outs)].sort((a, b) => a - b);
  const mean = outs.reduce((a, b) => a + b, 0) / outs.length;
  console.log(`s ${String(s).padStart(3)} -> ${uniq.join("/").padEnd(12)} mean ${mean.toFixed(2)}  q ${(Math.log(mean / 255) / Math.log(s / 255)).toFixed(4)}`);
}
