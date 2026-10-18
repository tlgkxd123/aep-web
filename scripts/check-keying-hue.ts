// Black-box probing of Linear Color Key's Match Colors = Using Hue / Using Chroma: for candidate distance definitions,
// the spread of the ramp constant K = (d^2 - t^2) / matte over the palette cells AE drew partly keyed.
//
//   node scripts/check-keying-hue.ts <comp> <frame> <quadrant> <key r,g,b 0-255> <tolerance 0-1>
import { rgbToHsl } from "../src/render/effects/keyingMath.ts";
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";

const [comp, n, quadrant, keyArg, tolArg] = process.argv.slice(2);
const key = keyArg.split(",").map((v) => Number(v) / 255);
const t = Number(tolArg) * (255.5 / 255);
const image = frame(comp, Number(n));
const circ = (a: number, b: number) => {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d) * 2;
};
const hsv = ([r, g, b]: number[]) => rgbToHsl([r, g, b])[0];
const atanHue = (m: number[][]) => ([r, g, b]: number[]) => {
  const u = m[0][0] * r + m[0][1] * g + m[0][2] * b;
  const v = m[1][0] * r + m[1][1] * g + m[1][2] * b;
  return Math.atan2(v, u) / (2 * Math.PI) + 0.5;
};
const candidates: Record<string, (s: number[]) => number> = {
  hex: (s) => circ(hsv(s), hsv(key)),
  deg: (s) => circ(Math.round(hsv(s) * 360) / 360, Math.round(hsv(key) * 360) / 360),
  b256: (s) => circ(Math.round(hsv(s) * 256) / 256, Math.round(hsv(key) * 256) / 256),
  floor256: (s) => circ(Math.floor(hsv(s) * 256) / 256, Math.floor(hsv(key) * 256) / 256),
  yuv: (s) => circ(atanHue([[-0.14713, -0.28886, 0.436], [0.615, -0.51499, -0.10001]])(s), atanHue([[-0.14713, -0.28886, 0.436], [0.615, -0.51499, -0.10001]])(key)),
  opp: (s) => circ(atanHue([[1, -0.5, -0.5], [0, Math.sqrt(3) / 2, -Math.sqrt(3) / 2]])(s), atanHue([[1, -0.5, -0.5], [0, Math.sqrt(3) / 2, -Math.sqrt(3) / 2]])(key)),
};
/** Ramp shapes: each gives the constant K that the matte m at distance d implies. */
const forms: Record<string, (d: number, m: number) => number> = {
  "(d2-t2)/m": (d, m) => (d * d - t * t) / m,
  "(d-t)2/m": (d, m) => ((d - t) * (d - t)) / m,
  "(d-t)/m": (d, m) => (d - t) / m,
  "(d-t)/sqrt(m)": (d, m) => (d - t) / Math.sqrt(m),
};
const cells = keyingCells().filter((c) => c.src[3] === 255);
const only = process.argv[7];
for (const [name, dist] of Object.entries(candidates)) {
  if (only && name !== only) continue;
  for (const [formName, form] of Object.entries(forms)) {
    const ks: number[] = [];
    const rows: [number, string][] = [];
    for (const cell of cells) {
      const [x, y] = cellPoint(cell, Number(quadrant));
      const m = pixel(image, x, y)[3] < 255 ? 0 : pixel(image, x, y)[0] / 255;
      if (m < 0.1 || m > 0.9) continue;
      const d = dist(cell.src.slice(0, 3).map((v) => v / 255));
      ks.push(form(d, m));
      rows.push([form(d, m), `${cell.src.slice(0, 3).join(",")} d=${d.toFixed(4)} m=${m.toFixed(3)}`]);
    }
    ks.sort((a, b) => a - b);
    if (process.argv.includes("--rows")) for (const [k, r] of rows.sort((a, b) => a[0] - b[0])) console.log(`  K=${k.toFixed(4)} ${r}`);
    const q = (f: number) => ks[Math.floor(f * (ks.length - 1))];
    console.log(`${name.padEnd(9)} ${formName.padEnd(14)} n=${ks.length} K p5 ${q(0.05).toFixed(4)} p50 ${q(0.5).toFixed(4)} p95 ${q(0.95).toFixed(4)} spread ${((q(0.95) - q(0.05)) / q(0.5)).toFixed(3)}`);
  }
}
