// Fits Cineon Converter curves against a channel suite frame's greys: prints the greys (10-bit code, output), then
// searches y = (10^((code - white) * k) - o) / (1 - o), raised to 1 / p, for the k, o and p that fit the greys
// below `--below` (8-bit output) best.
//
//   node scripts/check-channel-cineon.ts <comp> <frame> <white> [--below 230] [--invert]
import { cardCells, refPixel } from "./check-channel-probe.ts";

const [comp, frameArg, whiteArg] = process.argv.slice(2);
const white = Number(whiteArg);
const below = process.argv.includes("--below") ? Number(process.argv[process.argv.indexOf("--below") + 1]) : 230;
const invert = process.argv.includes("--invert");
const px = refPixel(comp, Number(frameArg));
const greys = cardCells("a")
  .filter((c) => c.j === 0)
  .map((c) => [c.rgba[0] / 255, px(c.i * 10 + 5, 5)[0] / 255]);
console.log(greys.map(([x, y]) => `${(x * 1023).toFixed(0)}:${(y * 255).toFixed(0)}`).join(" "));
if (process.argv.includes("--lin2log")) {
  // Linear to Log: fits code = white + log10(x (1 - o) + o) / k, x = (input - lo) / (hi - lo), over every opaque cell
  // channel whose output is below `--below`, with k and o free; prints the fit and the k and o the black point implies.
  const [black, gamma, lo, hi] = process.argv.slice(process.argv.indexOf("--lin2log") + 1).map(Number);
  const samples: [number, number][] = [];
  for (const cell of cardCells("a")) {
    if (cell.rgba[3] !== 255) continue;
    const out = px(cell.i * 10 + 5, cell.j * 10 + 5);
    for (let c = 0; c < 3; c++) if (out[c] < below) samples.push([(cell.rgba[c] / 255 - lo) / (hi - lo), out[c]]);
  }
  const fit = (k: number, o: number) => {
    let worst = 0;
    for (const [x, y] of samples) {
      const code = white + Math.log10(Math.max(1e-9, x * (1 - o) + o)) / k;
      worst = Math.max(worst, Math.abs(Math.min(255, Math.max(0, (code / 1023) * 255)) - y));
    }
    return worst;
  };
  const k0 = 0.0034 / gamma;
  const o0 = Math.pow(10, (black - white) * k0);
  console.log(`implied k ${k0.toFixed(6)} o ${o0.toFixed(5)}: worst ${fit(k0, o0).toFixed(2)} over ${samples.length}`);
  const curve = new Map<number, Set<number>>();
  for (const [x, y] of samples) curve.set(Math.round(x * 1e4), (curve.get(Math.round(x * 1e4)) ?? new Set()).add(y));
  console.log([...curve].sort((a, b) => a[0] - b[0]).map(([x, ys]) => `${(x / 1e4).toFixed(3)}:${[...ys].join("/")}`).join(" "));
  let best = { e: Infinity, k: 0, o: 0 };
  for (let k = k0 * 0.7; k <= k0 * 1.3; k += k0 * 0.002)
    for (let o = 0; o <= 0.05; o += 0.00005) {
      const e = fit(k, o);
      if (e < best.e) best = { e, k, o };
    }
  console.log(`best k ${best.k.toFixed(6)} (x${(best.k / k0).toFixed(3)}) o ${best.o.toFixed(5)}: worst ${best.e.toFixed(2)}`);
  process.exit(0);
}
if (process.argv.includes("--samples")) {
  // Every opaque cell channel as (10-bit code, 8-bit output), sorted, from `--from` (8-bit input).
  const from = Number(process.argv[process.argv.indexOf("--samples") + 1]);
  const samples = new Map<number, number>();
  for (const cell of cardCells("a")) {
    if (cell.rgba[3] !== 255) continue;
    const out = px(cell.i * 10 + 5, cell.j * 10 + 5);
    for (let c = 0; c < 3; c++) if (cell.rgba[c] >= from) samples.set(cell.rgba[c], out[c]);
  }
  console.log([...samples].sort((a, b) => a[0] - b[0]).map(([x, y]) => `${x}:${y}`).join(" "));
  process.exit(0);
}
// With --invert the frame is a linear to log conversion: fit the inverse curve on (output, input) pairs.
const pairs = (invert ? greys.map(([x, y]) => [y, x]) : greys).filter(([, y]) => y > 1 / 255 && y * 255 < below);
let best = { e: Infinity, k: 0, o: 0, p: 1 };
for (let k = 0.0005; k <= 0.005; k += 0.00001)
  for (let o = 0; o <= 0.3; o += 0.002)
    for (const p of [1, 1.7, 2.2, 0.6, 1 / 1.7]) {
      let e = 0;
      for (const [x, y] of pairs) {
        const lin = (Math.pow(10, (x * 1023 - white) * k) - o) / (1 - o);
        const v = Math.pow(Math.max(0, lin), 1 / p);
        e = Math.max(e, Math.abs(v - y));
      }
      if (e < best.e) best = { e, k, o, p };
    }
console.log(`k ${best.k.toFixed(6)} o ${best.o.toFixed(4)} p ${best.p.toFixed(3)} worst ${(best.e * 255).toFixed(2)} over ${pairs.length}`);
