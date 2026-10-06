// Fits CC Vignette "Pin Highlights" on the palette quadrants: out = s * (f + (1 - f) * S * w(s)^3)
// with w a brightness measure of the straight source colour, reporting the best S per
// quadrant and the worst 8-bit residual for each brightness measure.
//
//   node scripts/fxextra-fit-pin-palette.ts [--verbose]
import { readFileSync } from "node:fs";
import { paletteCells } from "./fxextra-cells.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const cases: [string, number, number, number, number][] = [
  ["fxextra_vignette_palette", 1, 1, 45, 1],
  ["fxextra_vignette_pin2", 0, 1, 90, 0.5],
  ["fxextra_vignette_pin2", 1, 1.66, 45, 1],
  ["fxextra_vignette_pin2", 2, 1, 90, 0.25],
  ["fxextra_vignette_pin2", 3, 0.8, 45, 1],
];
const measures: Record<string, (s: number[]) => number> = {
  mean: (s) => (s[0] + s[1] + s[2]) / 3,
  rec709: (s) => 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2],
  rec601: (s) => 0.299 * s[0] + 0.587 * s[1] + 0.114 * s[2],
  min: (s) => Math.min(...s),
};
const power = Number(process.env.PIN_POW ?? 3);
for (const [comp, q, amount, angle, pin] of cases) {
  const tiff = readTiff(new Uint8Array(readFileSync(framePath(comp, 0))));
  const tanHalf = Math.tan(((angle / 2) * Math.PI) / 180);
  const samples = paletteCells()
    .filter((c) => c.src[3] === 255)
    .map((cell) => {
      const lx = cell.col * 8 + 4;
      const ly = cell.row * 8 + 4;
      const i = ((Math.floor(q / 2) * 120 + ly) * tiff.width + (q % 2) * 160 + lx) * 4;
      const t = (Math.hypot(lx + 0.5 - 80, ly + 0.5 - 60) / 80) * tanHalf;
      const c2 = 1 / (1 + t * t);
      const f = 1 - amount * (1 - c2 * c2);
      return { s: cell.src.slice(0, 3).map((v) => v / 255), out: [...tiff.data.subarray(i, i + 3)].map((v) => v / 255), f };
    });
  const parts: string[] = [];
  for (const [name, w] of Object.entries(measures)) {
    // Least squares for S over every channel: out - s*f = S * s*(1-f)*w^p.
    let num = 0;
    let den = 0;
    for (const { s, out, f } of samples) {
      const base = Math.pow(Math.max(0, w(s)), power);
      for (let c = 0; c < 3; c++) {
        const x = s[c] * (1 - f) * base;
        num += x * (out[c] - Math.max(0, s[c] * f));
        den += x * x;
      }
    }
    const S = den ? num / den : 0;
    let worst = 0;
    let bad = 0;
    for (const { s, out, f } of samples) {
      const base = Math.pow(Math.max(0, w(s)), power);
      const d = Math.max(...[0, 1, 2].map((c) => Math.abs(Math.min(1, Math.max(0, s[c] * (f + (1 - f) * S * base))) - out[c]) * 255));
      worst = Math.max(worst, d);
      if (d > 3) bad++;
    }
    parts.push(`${name} S=${S.toFixed(3)} worst ${worst.toFixed(1)} bad ${bad}`);
  }
  console.log(`${comp} q${q} pin ${pin}: ${parts.join(" | ")}`);
}
