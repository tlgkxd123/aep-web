// Tabulates Solid Composite's reference output against the layer's channel values, per channel of the solid colour,
// for fitting its blending modes: one line per opaque cell channel, `layer solid out` in 0..1 (out straight).
//
//   node scripts/check-channel-solid.ts <comp> <frame> <solid r,g,b in 0..255>
import { cardCells, refPixel } from "./check-channel-probe.ts";

const [comp, frameArg, solidArg] = process.argv.slice(2);
const solid = solidArg.split(",").map(Number);
const px = refPixel(comp, Number(frameArg));
if (process.argv.includes("--regress")) {
  // Per channel, the least-squares fit out_premul = k1 * layer + k0 over the opaque cells (8-bit units).
  for (let c = 0; c < 3; c++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const cell of cardCells("a")) {
      if (cell.rgba[3] !== 255) continue;
      const out = px(cell.i * 10 + 5, cell.j * 10 + 5);
      xs.push(cell.rgba[c]);
      ys.push((out[c] * out[3]) / 255);
    }
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const k1 = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const k0 = my - k1 * mx;
    const worst = Math.max(...xs.map((x, i) => Math.abs(k1 * x + k0 - ys[i])));
    console.log(`channel ${c}: k1 ${k1.toFixed(4)}  k0 ${k0.toFixed(3)}  (solid ${solid[c]}: k0/solid ${(k0 / solid[c]).toFixed(4)})  worst ${worst.toFixed(2)}`);
  }
  process.exit(0);
}
const rows: string[] = [];
for (const cell of cardCells("a")) {
  if (cell.rgba[3] !== 255) continue;
  const out = px(cell.i * 10 + 5, cell.j * 10 + 5);
  for (let c = 0; c < 3; c++) rows.push(`${c}\t${(cell.rgba[c] / 255).toFixed(4)}\t${(solid[c] / 255).toFixed(4)}\t${(out[c] / 255).toFixed(4)}\t${out[3]}`);
}
console.log(rows.join("\n"));
