// Prints a row of a deepglow reference (8-bit green) next to our dumped source.
//
//   node scripts/dg-row.ts <comp> <frame> <y> <x0> <x1> [channel=1]
import { reference, source } from "./dg-cpu.ts";

const [comp, frameArg, yArg, x0, x1, chArg = "1"] = process.argv.slice(2);
const frame = Number(frameArg);
const y = Number(yArg);
const ch = Number(chArg);
const ref = reference(comp, frame);
let src: ReturnType<typeof source> | undefined;
try {
  src = source(comp, frame);
} catch {
  src = undefined;
}
const cells: string[] = [];
for (let x = Number(x0); x <= Number(x1); x++) {
  const i = (y * ref.width + x) * 4 + ch;
  const s = src ? Math.round(src.data[i] * 255) : "-";
  cells.push(`${x}:${Math.round(ref.data[i] * 255)}${src ? `/${s}` : ""}`);
}
console.log(cells.join(" "));
