// Isotropy of Deep Glow 2's glow on the dot fixtures: decoded glow along the row through
// the dot vs along the diagonal at the same Euclidean distance from the dot's centre.
//
//   node scripts/dg-iso.ts <comp> <frame>
import { reference } from "./dg-cpu.ts";

const [comp, frameArg] = process.argv.slice(2);
const ref = reference(comp, Number(frameArg));
const lin = (x: number, y: number) => {
  // Bilinear in the decoded image around pixel centres.
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (i: number, j: number) => Math.pow(ref.data[(j * ref.width + i) * 4 + 1], 2.2);
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
};
for (const d of [4, 6, 8, 12, 16, 24, 32, 48, 64]) {
  const axis = lin(128 + d, 128);
  const diag = lin(128 + d / Math.SQRT2, 128 + d / Math.SQRT2);
  console.log(`d ${String(d).padStart(3)}  axis ${axis.toExponential(2)}  diagonal ${diag.toExponential(2)}  ratio ${(diag / axis).toFixed(2)}`);
}
