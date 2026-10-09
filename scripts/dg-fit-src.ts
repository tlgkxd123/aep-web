// Fits non-negative Gaussian-basis level weights per frame to a Deep Glow 2 reference over
// its dumped (opaque) source, with the composite
//   out = 1 - (1 - T(s)) (1 - (E K * D(s))^(1/2.2)),  D(s) = s^p,  T(s) = s^(p/2.2).
//
//   node scripts/dg-fit-src.ts <comp> <frames a,b,..> <exposures a,b,..>
// env: DG_BASIS="s0,ratio,count" (default 1,2,11), DG_RADII (basis sigma = R/8 * ratio^-j plus s0),
//      DG_P (decode exponent, default 2.2), DG_OUTSIDE (fit only where the source is black),
//      DG_PNG=<prefix> (signed green residual x8), DG_ROW=<y> (print a row with DG_PNG).
import { writeFileSync } from "node:fs";
import { blurPlane, plane, reference, source } from "./dg-cpu.ts";
import { nnls } from "./dg-fit-kernel.ts";
import { encodePng } from "./lib/png.ts";

const [comp, framesArg, expArg] = process.argv.slice(2);
const frames = framesArg.split(",").map(Number);
const exposures = expArg.split(",").map(Number);
const [s0, ratio, count] = (process.env.DG_BASIS ?? "1,2,11").split(",").map(Number);
const radii = process.env.DG_RADII?.split(",").map(Number);
const outsideOnly = !!process.env.DG_OUTSIDE;
const P = Number(process.env.DG_P ?? 2.2);
const GAMMA = 2.2;
const T = (s: number) => Math.pow(s, P / GAMMA);
const compose = (s: number, glow: number) => 255 * (1 - (1 - T(s)) * (1 - Math.pow(Math.min(1, Math.max(0, glow)), 1 / GAMMA)));

frames.forEach((f, fi) => {
  const sigmas = radii
    ? [...Array.from({ length: count }, (_, j) => radii[fi] / 8 / Math.pow(ratio, j)).filter((s) => s >= s0), s0]
    : Array.from({ length: count }, (_, j) => s0 * Math.pow(ratio, j));
  const exposure = exposures[Math.min(fi, exposures.length - 1)];
  const src = source(comp, f);
  const ref = reference(comp, f);
  const { width: w, height: h } = src;
  const rows: Float64Array[] = [];
  const rhs: number[] = [];
  const keep: { basis: Float64Array; s: number; v: number; inside: boolean }[] = [];
  const blurredG: Float64Array[] = [];
  const channels = (process.env.DG_CH ?? "0,1,2").split(",").map(Number);
  for (let c = 0; c < 3; c++) {
    if (!channels.includes(c) && c !== 1) continue;
    const lin = plane(src, c, (v) => Math.pow(v, P));
    const blurred = sigmas.map((s) => blurPlane(lin, w, h, s));
    if (c === 1) blurredG.push(...blurred);
    if (!channels.includes(c)) continue;
    for (let i = 0; i < w * h; i++) {
      const s = src.data[i * 4 + c];
      const out = ref.data[i * 4 + c];
      const inside = !!(src.data[i * 4] || src.data[i * 4 + 1] || src.data[i * 4 + 2]);
      if (s > 0.9 || out >= 1 || (outsideOnly && inside)) continue;
      const g = 1 - (1 - out) / (1 - T(s));
      const gl = Math.pow(Math.max(0, g), GAMMA);
      const basis = new Float64Array(sigmas.length);
      sigmas.forEach((_, j) => (basis[j] = exposure * blurred[j][i]));
      // Residuals in 8-bit units of the output.
      const scale = ((255 * (1 - T(s))) / GAMMA) * Math.pow(Math.max(gl, Math.pow(0.5 / 255, GAMMA)), 1 / GAMMA - 1);
      rows.push(basis.map((b) => b * scale));
      rhs.push(gl * scale);
      keep.push({ basis, s, v: Math.round(out * 255), inside });
    }
  }
  const wts = nnls(rows, rhs, sigmas.length);
  const stats = { out: [0, 0, 0, 0], in: [0, 0, 0, 0] };
  for (const k of keep) {
    const v = Math.round(compose(k.s, k.basis.reduce((a, b, j) => a + b * wts[j], 0)));
    const st = k.inside ? stats.in : stats.out;
    st[0] += Math.abs(v - k.v);
    st[1] = Math.max(st[1], Math.abs(v - k.v));
    st[2]++;
    st[3] += v - k.v;
  }
  const fmt = (s: number[]) => `mean ${(s[0] / Math.max(1, s[2])).toFixed(3)} signed ${(s[3] / Math.max(1, s[2])).toFixed(3)} max ${s[1]} n ${s[2]}`;
  console.log(`${comp}@${f} E=${exposure} p=${P} outside ${fmt(stats.out)} | inside ${fmt(stats.in)} | total ${wts.reduce((a, b) => a + b, 0).toFixed(3)}`);
  console.log("  " + sigmas.map((s, j) => (wts[j] > 1e-4 ? `${s.toFixed(1)}:${wts[j].toFixed(3)}` : "")).filter(Boolean).join("  "));
  if (process.env.DG_PNG) {
    const model = new Float64Array(w * h);
    sigmas.forEach((_, j) => {
      for (let i = 0; i < w * h; i++) model[i] += wts[j] * exposure * blurredG[j][i];
    });
    const png = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const d = (compose(src.data[i * 4 + 1], model[i]) - ref.data[i * 4 + 1] * 255) * 8;
      png.set([Math.max(0, Math.min(255, d)), 0, Math.max(0, Math.min(255, -d)), 255], i * 4);
    }
    writeFileSync(`${process.env.DG_PNG}_${comp}_f${f}.png`, encodePng(w, h, png));
    if (process.env.DG_ROW) {
      const y = Number(process.env.DG_ROW);
      for (let x = 0; x < w; x += 2) {
        const i = y * w + x;
        console.log(`x ${x} src ${Math.round(src.data[i * 4 + 1] * 255)} ref ${Math.round(ref.data[i * 4 + 1] * 255)} model ${compose(src.data[i * 4 + 1], model[i]).toFixed(1)}`);
      }
    }
  }
});
