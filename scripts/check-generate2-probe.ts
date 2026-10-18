// Prints After Effects' reference pixels of a generate2 frame (straight RGBA, 0-255) next to ours when
// `node scripts/pixel-report.ts --suite generate2 --dump` wrote them, for working out the effects' formulas.
//
//   node scripts/check-generate2-probe.ts <comp> <frame> row <y> [x0 x1 [step]]
//   node scripts/check-generate2-probe.ts <comp> <frame> col <x> [y0 y1 [step]]
//   node scripts/check-generate2-probe.ts <comp> <frame> px <x> <y>
//   node scripts/check-generate2-probe.ts <comp> <frame> worst [n]
//   node scripts/check-generate2-probe.ts <comp> <frame> png [zoom]     (into <tmp>/generate2-probe)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "./lib/png.ts";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, mode = "worst", ...rest] = process.argv.slice(2);
if (!comp || frameArg === undefined) throw new Error("usage: node scripts/check-generate2-probe.ts <comp> <frame> row|col|px|worst ...");
const frame = Number(frameArg);
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`))));
const { width, height } = ref;
const oursDir = join(ROOT, "ours");
const oursFile = existsSync(oursDir) ? readdirSync(oursDir).find((f) => f === `${comp}_f${frame}_${width}x${height}.rgba`) : undefined;
const ours = oursFile ? new Uint8Array(readFileSync(join(oursDir, oursFile))) : undefined;
const n = rest.map(Number);

const px = (d: Uint8Array, x: number, y: number) => Array.from(d.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
const fmt = (v: number[]) => v.map((c) => String(c).padStart(3)).join(" ");
const line = (x: number, y: number) => {
  const r = px(ref.data, x, y);
  const o = ours ? px(ours, x, y) : undefined;
  const premulDiff = o ? Math.max(...[0, 1, 2].map((c) => Math.abs((r[c] * r[3] - o[c] * o[3]) / 255)), Math.abs(r[3] - o[3])) : 0;
  console.log(`${String(x).padStart(4)},${String(y).padStart(4)}  ae ${fmt(r)}${o ? `  ours ${fmt(o)}  d ${premulDiff.toFixed(0)}` : ""}`);
};

if (mode === "row") {
  const [y, x0 = 0, x1 = width - 1, step = 1] = n;
  for (let x = x0; x <= x1; x += step) line(x, y);
} else if (mode === "col") {
  const [x, y0 = 0, y1 = height - 1, step = 1] = n;
  for (let y = y0; y <= y1; y += step) line(x, y);
} else if (mode === "px") {
  line(n[0], n[1]);
} else if (mode === "radial") {
  // Coverage between the colours at (ax, ay) (1) and (bx, by) (0) of the partly covered pixels, by the distance of
  // their centres (x + 0.5, y + 0.5) from (cx, cy).
  const [cx, cy, ax, ay, bx, by] = n;
  const A = px(ref.data, ax, ay);
  const B = px(ref.data, bx, by);
  const span = [0, 1, 2].reduce((s, c) => s + (A[c] - B[c]) ** 2, 0);
  const rows: [number, number, number, number][] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const P = px(ref.data, x, y);
      const cov = [0, 1, 2].reduce((s, c) => s + (P[c] - B[c]) * (A[c] - B[c]), 0) / span;
      if (cov > 0.01 && cov < 0.99) rows.push([Math.hypot(x + 0.5 - cx, y + 0.5 - cy), cov, x, y]);
    }
  rows.sort((a, b) => a[0] - b[0]);
  for (const [d, cov, x, y] of rows) console.log(`d ${d.toFixed(3)}  cov ${cov.toFixed(3)}  (${x},${y})`);
} else if (mode === "png") {
  // The reference (and ours below it), over a grey checker, `zoom` times larger.
  const zoom = n[0] || 3;
  const images = ours ? [ref.data, ours] : [ref.data];
  const W = width * zoom;
  const H = height * zoom * images.length;
  const out = new Uint8Array(W * H * 4);
  images.forEach((d, k) => {
    for (let y = 0; y < height * zoom; y++)
      for (let x = 0; x < W; x++) {
        const [r, g, b, a] = px(d, Math.floor(x / zoom), Math.floor(y / zoom));
        const bg = ((x >> 3) + (y >> 3)) % 2 ? 90 : 60;
        const o = ((k * height * zoom + y) * W + x) * 4;
        out[o] = (r * a + bg * (255 - a)) / 255;
        out[o + 1] = (g * a + bg * (255 - a)) / 255;
        out[o + 2] = (b * a + bg * (255 - a)) / 255;
        out[o + 3] = 255;
      }
  });
  const dir = join(tmpdir(), "generate2-probe");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${comp}_f${frame}.png`);
  writeFileSync(file, encodePng(W, H, out));
  console.log(file);
} else {
  if (!ours) throw new Error("no dump of ours: run pixel-report with --dump");
  const rows: [number, number, number][] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const r = px(ref.data, x, y);
      const o = px(ours, x, y);
      const d = Math.max(...[0, 1, 2].map((c) => Math.abs((r[c] * r[3] - o[c] * o[3]) / 255)), Math.abs(r[3] - o[3]));
      rows.push([d, x, y]);
    }
  rows.sort((a, b) => b[0] - a[0]);
  for (const [, x, y] of rows.slice(0, n[0] ?? 20)) line(x, y);
}
