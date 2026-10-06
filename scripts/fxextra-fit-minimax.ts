// Fits the Minimax neighbourhood shape: filters the fxextra palette in JS with
// candidate kernels and counts mismatches against one quadrant of fxextra_minimax_c.
//
//   node scripts/fxextra-fit-minimax.ts <quadrant> <max 0|1> <radius> <channel mask e.g. 1110>
import { readFileSync } from "node:fs";
import { paletteCells } from "./fxextra-cells.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [quadrant, isMax, radiusArg, maskArg = "1110"] = process.argv.slice(2);
const q = Number(quadrant);
const radius = Number(radiusArg);
const mask = [...maskArg].map(Number);
const W = 160;
const H = 120;
const src = new Float64Array(W * H * 4);
for (const cell of paletteCells()) {
  for (let y = cell.row * 8; y < cell.row * 8 + 8; y++) {
    for (let x = cell.col * 8; x < cell.col * 8 + 8; x++) src.set(cell.src, (y * W + x) * 4);
  }
}
const ref = readTiff(new Uint8Array(readFileSync(framePath("fxextra_minimax_c", 0))));
const ox = (q % 2) * W;
const oy = Math.floor(q / 2) * H;

const kernels: Record<string, (dx: number, dy: number) => boolean> = {
  square: (dx, dy) => Math.abs(dx) <= radius && Math.abs(dy) <= radius,
  "disc r^2": (dx, dy) => dx * dx + dy * dy <= radius * radius,
  "disc (r+.5)^2": (dx, dy) => dx * dx + dy * dy <= (radius + 0.5) * (radius + 0.5),
  "disc r^2+r": (dx, dy) => dx * dx + dy * dy <= radius * radius + radius,
  "disc (r+1)^2-1": (dx, dy) => dx * dx + dy * dy < (radius + 1) * (radius + 1),
  "disc ceil": (dx, dy) => dx * dx + dy * dy <= Math.ceil(radius) ** 2,
  "disc round": (dx, dy) => dx * dx + dy * dy <= Math.round(radius) ** 2,
  diamond: (dx, dy) => Math.abs(dx) + Math.abs(dy) <= radius,
};
if (process.env.MM_SWEEP) {
  for (const k of Object.keys(kernels)) delete kernels[k];
  for (let t = radius * radius; t <= (radius + 2) ** 2; t += 1) kernels[`d^2 <= ${t}`] = (dx, dy) => dx * dx + dy * dy <= t;
}
if (process.env.MM_OCT) {
  for (const k of Object.keys(kernels)) delete kernels[k];
  for (let a = Math.floor(radius); a <= Math.ceil(radius) + 1; a++) {
    for (let b = a; b <= 2 * a; b++) kernels[`oct ${a}/${b}`] = (dx, dy) => Math.abs(dx) <= a && Math.abs(dy) <= a && Math.abs(dx) + Math.abs(dy) <= b;
  }
}
const R = Math.ceil(radius) + 1;
for (const [name, inside] of Object.entries(kernels)) {
  let bad = 0;
  let total = 0;
  let example = "";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = src[i + 3];
      if (!a) continue;
      const acc = [src[i], src[i + 1], src[i + 2]];
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (!inside(dx, dy)) continue;
          const nx = x + dx;
          const ny = y + dy;
          const j = (ny * W + nx) * 4;
          const v = nx < 0 || ny < 0 || nx >= W || ny >= H || !src[j + 3] ? [0, 0, 0] : [src[j], src[j + 1], src[j + 2]];
          for (let c = 0; c < 3; c++) if (mask[c]) acc[c] = isMax === "1" ? Math.max(acc[c], v[c]) : Math.min(acc[c], v[c]);
        }
      }
      const out = acc.map((v) => (v * a) / 255);
      const k = ((oy + y) * ref.width + ox + x) * 4;
      const got = [ref.data[k], ref.data[k + 1], ref.data[k + 2]];
      total++;
      if (out.some((v, c) => Math.abs(v - got[c]) > 3)) {
        bad++;
        if (!example) example = `(${x},${y}) ours ${out.map(Math.round)} ref ${got}`;
      }
    }
  }
  console.log(`${name.padEnd(16)} bad ${bad}/${total} ${example}`);
}
