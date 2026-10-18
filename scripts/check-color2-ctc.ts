// Tabulates Change To Color's correction matte on a probe frame that views it: per cell, the HSL distances
// to the From colour (hue in turns, wrapped; lightness; saturation) and the matte After Effects shows.
//   node scripts/check-color2-ctc.ts <frame> [r,g,b of From, 0..1] [--sort h|l|s|m]
import { readFileSync } from "node:fs";
import { rgbToHsl } from "../src/render/effects/colorExtraMath.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff, type Image } from "./lib/tiff.ts";

const frame = Number(process.argv[2]);
const from = (process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "0.8,0.2,0.2").split(",").map(Number);
const i = process.argv.indexOf("--sort");
const sort = i > 0 ? process.argv[i + 1] : "h";
const read = (f: number): Image => readTiff(new Uint8Array(readFileSync(framePath("color2_probe", f))));
const cell = (img: Image, k: number) => {
  const o = ((Math.floor(k / 16) * 8 + 4) * img.width + (k % 16) * 8 + 4) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
};
const src = read(0);
const out = read(frame);
const [fh, fs, fl] = rgbToHsl(from);
const rows = Array.from({ length: 256 }, (_, k) => {
  const c = cell(src, k).slice(0, 3).map((v) => v / 255);
  const [h, s, l] = rgbToHsl(c);
  const dh = Math.min(Math.abs(h - fh), 1 - Math.abs(h - fh));
  const o = cell(out, k);
  return { k, c, h: dh, l: Math.abs(l - fl), s: Math.abs(s - fs), m: (o[0] / 255) * (o[3] / 255) };
});
const angle = (c: number[], kind: string) => {
  if (kind === "hex") return Math.atan2((Math.sqrt(3) / 2) * (c[1] - c[2]), c[0] - (c[1] + c[2]) / 2) / (2 * Math.PI);
  const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  if (kind === "uv") return Math.atan2(0.877 * (c[0] - y), 0.492 * (c[2] - y)) / (2 * Math.PI);
  return Math.atan2(0.211 * c[0] - 0.523 * c[1] + 0.312 * c[2], 0.596 * c[0] - 0.274 * c[1] - 0.322 * c[2]) / (2 * Math.PI);
};
for (const kind of ["hsl", "hex", "uv", "iq"]) {
  const d = (c: number[]) => {
    if (kind === "hsl") return rows.find((r) => r.c === c)!.h;
    const a = angle(c, kind) - angle(from, kind);
    const w = a - Math.round(a);
    return Math.abs(w);
  };
  const soft = rows.filter((r) => r.m > 0 && r.m < 1).map((r) => ({ d: d(r.c), m: r.m })).sort((a, b) => a.d - b.d);
  let inversions = 0;
  for (let a = 0; a < soft.length; a++) for (let b = a + 1; b < soft.length; b++) if (soft[b].m > soft[a].m + 0.02) inversions++;
  console.log(`${kind}: ${inversions} inversions over ${soft.length} soft cells: ${soft.map((s) => `${s.d.toFixed(4)}:${s.m.toFixed(2)}`).join(" ")}`);
}
const fitAt = process.argv.indexOf("--fit");
if (fitAt > 0) {
  const tol = Number(process.argv[fitAt + 1]);
  const used = rows.filter((r) => 2 * r.h <= tol * 1.05 && r.s > 0);
  let best = { err: Infinity, cl: 0, cs: 0, w: 1, x0: 1 };
  for (let cl = 0; cl <= 1.5; cl += 0.02)
    for (let cs = 0; cs <= 1.5; cs += 0.02)
      for (let w = 0.1; w <= 1; w += 0.02)
        for (let x0 = 0.8; x0 <= 1.2; x0 += 0.02) {
          let err = 0;
          for (const r of used) err = Math.max(err, Math.abs(Math.min(1, Math.max(0, (x0 - (2 * r.h) / tol - cl * r.l - cs * r.s) / w)) - r.m));
          if (err < best.err) best = { err, cl, cs, w, x0 };
        }
  console.log(`fit: x0 ${best.x0.toFixed(2)} cl ${best.cl.toFixed(2)} cs ${best.cs.toFixed(2)} w ${best.w.toFixed(2)} max err ${best.err.toFixed(3)}`);
}
const key = sort as "h" | "l" | "s" | "m";
rows.sort((a, b) => a[key] - b[key]);
for (const r of rows) {
  if (r.m === 0 && key !== "m") continue;
  console.log(`#${r.k} ${r.c.map((v) => Math.round(v * 255))} dh ${r.h.toFixed(4)} dl ${r.l.toFixed(3)} ds ${r.s.toFixed(3)} matte ${r.m.toFixed(3)}`);
}
