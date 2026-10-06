// Tabulates CC Vignette "Pin Highlights" on the grey ramp of fxextra_vignette_pin:
// for each cell, the grey level g, the vignette factor f and the share h of the lost
// light that comes back, from out = g * (f + (1 - f) * h).
//
//   node scripts/fxextra-fit-pin.ts [quadrant] [--all]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const q = Number(process.argv[2] ?? 0);
const amounts = [1, 1, 0.5, 1];
const tiff = readTiff(new Uint8Array(readFileSync(framePath("fxextra_vignette_pin", 0))));
const tanHalf = Math.tan((45 * Math.PI) / 180);
const rows: { g: number; f: number; out: number; h: number }[] = [];
for (let i = 0; i < 300; i++) {
  const col = i % 20;
  const row = Math.floor(i / 20);
  const lx = col * 8 + 4;
  const ly = row * 8 + 4;
  const x = (q % 2) * 160 + lx;
  const y = Math.floor(q / 2) * 120 + ly;
  const out = tiff.data[(y * tiff.width + x) * 4] / 255;
  const g = Math.round((i / 299) * 255) / 255;
  const t = (Math.hypot(lx + 0.5 - 80, ly + 0.5 - 60) / 80) * tanHalf;
  const c2 = 1 / (1 + t * t);
  const f = 1 - amounts[q] * (1 - c2 * c2);
  const h = g > 0 && f < 0.97 ? (out / g - f) / (1 - f) : NaN;
  rows.push({ g, f, out, h });
}
if (process.argv.includes("--all")) {
  for (const r of rows) console.log(`g=${r.g.toFixed(3)} f=${r.f.toFixed(3)} out=${(r.out * 255).toFixed(0).padStart(3)} h=${r.h.toFixed(3)}`);
} else {
  // Mean h per grey band and per vignette band, to see what h depends on.
  for (let b = 0; b < 10; b++) {
    const sel = rows.filter((r) => !Number.isNaN(r.h) && r.g >= b / 10 && r.g < (b + 1) / 10 + (b === 9 ? 0.01 : 0));
    const fs = [0, 1, 2, 3].map((k) => sel.filter((r) => r.f >= 0.2 * k && r.f < 0.2 * (k + 1)));
    const cell = (s: typeof sel) => (s.length ? (s.reduce((a, r) => a + r.h, 0) / s.length).toFixed(3) : "  -  ");
    console.log(`g ${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}: h ${cell(sel)}  by f<.2 .2-.4 .4-.6 .6-.8: ${fs.map(cell).join(" ")}`);
  }
}
