// Ratio of decoded glow between two frames of one comp along a row (outside the source),
// to see where a bright source glows less than a dim one scaled by D(s) = s^p.
//
//   node scripts/dg-spill.ts <comp> <frameA> <frameB> <row> <x0> <x1> [channel=1]
import { reference } from "./dg-cpu.ts";

const [comp, fa, fb, rowArg, x0, x1, chArg = "1"] = process.argv.slice(2);
const a = reference(comp, Number(fa));
const b = reference(comp, Number(fb));
const y = Number(rowArg);
const ch = Number(chArg);
for (let x = Number(x0); x <= Number(x1); x++) {
  const i = (y * a.width + x) * 4 + ch;
  const va = Math.round(a.data[i] * 255);
  const vb = Math.round(b.data[i] * 255);
  console.log(`x ${x} ${String(va).padStart(3)} ${String(vb).padStart(3)} ratio ${(Math.pow(va / Math.max(vb, 0.5), 2.2)).toFixed(2)}`);
}
