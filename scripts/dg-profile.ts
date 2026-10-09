// Deep Glow 2's kernel as measured on the dot fixtures: a 4x4 white square at the centre
// of 256x256 on black, so outside it the output is the glow alone. Prints the decoded
// glow (gamma 2.2) per unit of source energy (16 px x exposure) along the row through the
// dot's centre, per radius.
//
//   node scripts/dg-profile.ts [comp=deepglow_dot_hot] [exposure=20] [frames 0,1,..]
import { reference } from "./dg-cpu.ts";

const [comp = "deepglow_dot_hot", expArg = "20", framesArg] = process.argv.slice(2);
const exposure = Number(expArg);
const frames = framesArg ? framesArg.split(",").map(Number) : [0, 1, 2, 3, 4, 5, 6];
const distances = [3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 120];
console.log(`r:      ${distances.map((d) => String(d).padStart(9)).join("")}`);
for (const f of frames) {
  const ref = reference(comp, f);
  const y = 128;
  const cells = distances.map((d) => {
    // Distance from the dot's centre (128,128) to pixel centres x + 0.5 along the row y = 127.5 + 0.5.
    const x = 128 + d - 1;
    const v = (ref.data[(y * ref.width + x) * 4 + 1] + ref.data[((y - 1) * ref.width + x) * 4 + 1]) / 2;
    const lin = Math.pow(v, 2.2) / (16 * exposure);
    return (v >= 1 ? "sat" : lin.toExponential(2)).padStart(9);
  });
  console.log(`f${f}:     ${cells.join("")}`);
}
