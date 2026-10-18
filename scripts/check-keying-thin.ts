// Edge Thin hypotheses: erodes our dumped alpha of a quadrant where nothing is keyed (so ours is the source's alpha)
// in several ways and counts the pixels that differ from After Effects' alpha by more than 3.
//
//   node scripts/check-keying-thin.ts <comp> <frame> <x0> <y0> <width> <height> <radius>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, n, ...rest] = process.argv.slice(2);
const [x0, y0, w, h, r] = rest.map(Number);
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", comp, `frame_${n.padStart(5, "0")}.tif`))));
const name = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${n}_`));
if (!name) throw new Error(`no dump of ${comp}@${n}: run pixel-report with --dump`);
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", name)));
const at = (data: Uint8Array, x: number, y: number) => data[((y0 + y) * ref.width + x0 + x) * 4 + 3];

type Shape = (dx: number, dy: number) => boolean;
const shapes: Record<string, Shape> = {
  disc: (dx, dy) => dx * dx + dy * dy <= r * r,
  discStrict: (dx, dy) => dx * dx + dy * dy < r * r,
  discHalf: (dx, dy) => dx * dx + dy * dy <= (r + 0.5) * (r + 0.5),
  square: (dx, dy) => Math.abs(dx) <= r && Math.abs(dy) <= r,
  diamond: (dx, dy) => Math.abs(dx) + Math.abs(dy) <= r,
  cross: (dx, dy) => dx === 0 || dy === 0,
  oct5: (dx, dy) => Math.abs(dx) <= r && Math.abs(dy) <= r && Math.abs(dx) + Math.abs(dy) <= r + 1,
  oct6: (dx, dy) => Math.abs(dx) <= r && Math.abs(dy) <= r && Math.abs(dx) + Math.abs(dy) <= r + 2,
  oct7: (dx, dy) => Math.abs(dx) <= r && Math.abs(dy) <= r && Math.abs(dx) + Math.abs(dy) <= r + 3,
};
const outsides: Record<string, (x: number, y: number) => number | null> = {
  repeat: (x, y) => at(ours, Math.min(w - 1, Math.max(0, x)), Math.min(h - 1, Math.max(0, y))),
  ignore: () => null,
  clear: () => 0,
};
const results: [string, number][] = [];
for (const [sName, shape] of Object.entries(shapes))
  for (const [oName, outside] of Object.entries(outsides))
    for (const mode of ["min", "binary50"]) {
      let bad = 0;
      const show = process.env.KEYING_SHOW === `${sName} ${oName} ${mode}`;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let v = 255;
          for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++) {
              if (!shape(dx, dy) || (sName === "cross" && Math.abs(dx) + Math.abs(dy) > r)) continue;
              const [xx, yy] = [x + dx, y + dy];
              const s = xx >= 0 && yy >= 0 && xx < w && yy < h ? at(ours, xx, yy) : outside(xx, yy);
              if (s === null) continue;
              v = Math.min(v, mode === "min" ? s : s >= 128 ? 255 : 0);
            }
          const result = mode === "min" ? v : Math.min(v, at(ours, x, y));
          if (Math.abs(result - at(ref.data, x, y)) > 3) {
            bad++;
            if (show) console.log(`  (${x0 + x}, ${y0 + y}) source ${at(ours, x, y)} ours ${result} ref ${at(ref.data, x, y)}`);
          }
        }
      results.push([`${sName} ${oName} ${mode}`, bad]);
    }
const clampAt = (x: number, y: number) => at(ours, Math.min(w - 1, Math.max(0, x)), Math.min(h - 1, Math.max(0, y)));
for (let sigma = 0.75; sigma <= 6; sigma += 0.25) {
  const radius = Math.ceil(3 * sigma);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const total = kernel.reduce((a, b) => a + b);
  const horizontal = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -radius; i <= radius; i++) s += kernel[i + radius] * clampAt(x + i, y);
      horizontal[y * w + x] = s / total;
    }
  const blurred = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -radius; i <= radius; i++) s += kernel[i + radius] * horizontal[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      blurred[y * w + x] = s / total;
    }
  let best: [number, number] = [Infinity, 0];
  for (let t = 128; t <= 255; t += 0.5) {
    let bad = 0;
    for (let i = 0; i < w * h; i++) {
      const y = Math.floor(i / w);
      const x = i % w;
      if (Math.abs((blurred[i] >= t ? 255 : 0) - at(ref.data, x, y)) > 3) bad++;
    }
    if (bad < best[0]) best = [bad, t];
  }
  results.push([`gaussian ${sigma} threshold ${best[1]}`, best[0]]);
}
results.sort((a, b) => a[1] - b[1]);
for (const [label, bad] of results) console.log(`${String(bad).padStart(6)}  ${label}`);
