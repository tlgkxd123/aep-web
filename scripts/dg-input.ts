// Deep Glow 2's glow input (View: Glow Input) on the ramp fixtures: per strip (black -> colour),
// source and output RGB at every `step` pixels, for reading the threshold function.
//
//   node scripts/dg-input.ts <comp> <frame> [strips 0,1,..] [step=16]
import { reference, source } from "./dg-cpu.ts";

const [comp, frameArg, stripsArg = "0,1,2,3,4,5", stepArg = "16"] = process.argv.slice(2);
const src = source(comp, Number(frameArg));
const ref = reference(comp, Number(frameArg));
const step = Number(stepArg);
for (const k of stripsArg.split(",").map(Number)) {
  const y = 16 * k + 8;
  const cells: string[] = [];
  for (let x = step / 2; x < src.width; x += step) {
    const i = (y * src.width + x) * 4;
    const s = [0, 1, 2].map((c) => Math.round(src.data[i + c] * 255));
    const o = [0, 1, 2].map((c) => Math.round(ref.data[i + c] * 255));
    cells.push(`${s.join(",")}>${o.join(",")}`);
  }
  console.log(`strip ${k}: ${cells.join("  ")}`);
}
