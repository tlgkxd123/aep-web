// Finds bright spots (local alpha maxima) in reference frames: count, centroid,
// spread and the largest spots, for comparing particle renders.
//
//   node scripts/ref-spots.ts <comp> <frame,frame,...> [threshold 0..255] [--ours]
//
// --ours reads our renders saved by pixel-report (refs/ours/<comp>_f<frame>_<w>x<h>.rgba).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2).filter((a) => a !== "--ours");
const ours = process.argv.includes("--ours");
const [comp, frames, thresholdArg] = args;
const threshold = Number(thresholdArg ?? 60);
const load = (frame: number) => {
  if (!ours) return readTiff(readFileSync(framePath(comp, frame)));
  const name = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`) && f.endsWith(".rgba"))!;
  const [width, height] = name.slice(0, -5).split("_").pop()!.split("x").map(Number);
  return { width, height, data: new Uint8Array(readFileSync(join(ROOT, "ours", name))) };
};
for (const frame of frames.split(",").map(Number)) {
  const img = load(frame);
  const { width, height, data } = img;
  const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3];
  const spots: { x: number; y: number; a: number; area: number }[] = [];
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const a = alpha(x, y);
      if (a < threshold) continue;
      let peak = true;
      for (let dy = -2; dy <= 2 && peak; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && alpha(x + dx, y + dy) > a - (dy < 0 || (dy === 0 && dx < 0) ? 0 : 1)) { peak = false; break; }
      if (!peak) continue;
      let area = 0;
      for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < width && yy < height && alpha(xx, yy) > a / 2) area++;
      }
      spots.push({ x, y, a, area });
    }
  }
  const n = spots.length || 1;
  const cx = spots.reduce((s, p) => s + p.x, 0) / n;
  const cy = spots.reduce((s, p) => s + p.y, 0) / n;
  const sx = Math.sqrt(spots.reduce((s, p) => s + (p.x - cx) ** 2, 0) / n);
  const sy = Math.sqrt(spots.reduce((s, p) => s + (p.y - cy) ** 2, 0) / n);
  const big = [...spots].sort((a, b) => b.area - a.area).slice(0, 6).map((p) => `(${p.x},${p.y}) a${p.a} area${p.area}`);
  const xs = spots.map((p) => p.x).sort((a, b) => a - b);
  console.log(`${comp} f${frame}: ${spots.length} spots, centroid (${cx.toFixed(0)},${cy.toFixed(0)}) spread (${sx.toFixed(0)},${sy.toFixed(0)}) x range ${xs[0]}..${xs[xs.length - 1]}; largest ${big.join(" ")}`);
}
