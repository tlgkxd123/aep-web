// Along one row of ramp fixtures: source value, reference value and the flat-area gain W
// implied by a gamma-space Screen of encode(E * W * decode(s)) over s.
//
//   node scripts/dg-curve.ts <comp> <frames a,b,..> <exposures a,b,..> [row=8] [channel=1] [step=16]
import { reference, source, toGamma, toLin } from "./dg-cpu.ts";

const [comp, framesArg, expArg, rowArg = "8", chArg = "1", stepArg = "16"] = process.argv.slice(2);
const frames = framesArg.split(",").map(Number);
const exposures = expArg.split(",").map(Number);
const row = Number(rowArg);
const ch = Number(chArg);
const refs = frames.map((f) => reference(comp, f));
const src = source(comp, frames[0]);
console.log(`x    src  ${frames.map((f, i) => `f${f}(E${exposures[i]})`.padStart(20)).join("")}`);
for (let x = 0; x < src.width; x += Number(stepArg)) {
  const i = (row * src.width + x) * 4 + ch;
  const s = src.data[i];
  const cells = refs.map((r, k) => {
    const out = r.data[i];
    const g = (1 - out) / Math.max(1e-6, 1 - s);
    const w = s > 0 && exposures[k] > 0 ? toLin(1 - g) / (exposures[k] * toLin(s)) : NaN;
    return `${Math.round(out * 255).toString().padStart(4)} W=${w.toFixed(3).padStart(7)}`.padStart(20);
  });
  console.log(`${String(x).padStart(4)} ${Math.round(s * 255).toString().padStart(4)} ${cells.join("")}`);
}
void toGamma;
