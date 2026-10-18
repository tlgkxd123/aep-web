// Radial profile of where After Effects sampled the distort2 card (see check-distort2-probe.ts): for each whole
// distance from a centre (card pixels, centres at +0.5), the mean displacement of the sampled point from the output
// point, along x and y and radially and tangentially, over the opaque pixels at that distance.
//
//   node scripts/check-distort2-radial.ts <comp> <frame> <cx> <cy> [maxDistance]
//
// With DISTORT2_OURS=1 it reads our render instead (`pixel-report.ts --dump` writes it to refs/ours).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CARD = { x: 20, y: 15, width: 120, height: 90 };
const [comp, frameArg, cxArg, cyArg, maxArg] = process.argv.slice(2);
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const oursFile = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frameArg}_`));
const frame = process.env.DISTORT2_OURS && oursFile ? { ...ref, data: new Uint8Array(readFileSync(join(ROOT, "ours", oursFile))) } : ref;
const [cx, cy] = [Number(cxArg), Number(cyArg)];
const max = Number(maxArg ?? 80);

const px = (img: typeof frame, x: number, y: number) => img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
// DISTORT2_LINEAR=1 decodes with ramps of 255 (i + 0.5) / n instead of the card's reference.
const linear = (n: number) => Array.from({ length: n }, (_, i) => (255 * (i + 0.5)) / n);
const card = process.env.DISTORT2_LINEAR ? null : readTiff(new Uint8Array(readFileSync(framePath("distort2_card", 0))));
const redAlong = card ? Array.from({ length: CARD.width }, (_, x) => px(card, CARD.x + x, CARD.y + 45)[0]) : linear(CARD.width);
const greenAlong = card ? Array.from({ length: CARD.height }, (_, y) => px(card, CARD.x + 1, CARD.y + y)[1]) : linear(CARD.height);
function invert(ramp: number[], v: number): number {
  if (v <= ramp[0]) return 0.5 - (ramp[0] - v) / Math.max(1, ramp[1] - ramp[0]);
  for (let i = 1; i < ramp.length; i++) if (v <= ramp[i]) return i - 0.5 + (v - ramp[i - 1]) / Math.max(1e-9, ramp[i] - ramp[i - 1]);
  const n = ramp.length;
  return n - 0.5 + (v - ramp[n - 1]) / Math.max(1, ramp[n - 1] - ramp[n - 2]);
}

const bins = Array.from({ length: max + 1 }, () => ({ n: 0, dx: 0, dy: 0, radial: 0, tangential: 0 }));
for (let y = -CARD.y; y < frame.height - CARD.y; y++) {
  for (let x = -CARD.x; x < frame.width - CARD.x; x++) {
    const [r, g, , a] = px(frame, CARD.x + x, CARD.y + y);
    // Only fully opaque pixels whose source is well inside the card decode reliably.
    if (a < 255) continue;
    const sx = invert(redAlong, r);
    const sy = invert(greenAlong, g);
    if (sx < 1.5 || sy < 1.5 || sx > CARD.width - 1.5 || sy > CARD.height - 1.5) continue;
    const ox = x + 0.5 - cx;
    const oy = y + 0.5 - cy;
    const d = Math.hypot(ox, oy);
    const k = Math.round(d);
    if (k > max || d < 1e-6) continue;
    const [ux, uy] = [ox / d, oy / d];
    const [dx, dy] = [sx - (x + 0.5), sy - (y + 0.5)];
    const b = bins[k];
    b.n++;
    b.dx += dx;
    b.dy += dy;
    b.radial += dx * ux + dy * uy;
    b.tangential += -dx * uy + dy * ux;
  }
}
console.log("d     n      dx      dy  radial  tangential");
bins.forEach((b, d) => {
  if (!b.n) return;
  const f = (v: number) => (v / b.n).toFixed(2).padStart(7);
  console.log(`${String(d).padStart(3)} ${String(b.n).padStart(5)} ${f(b.dx)} ${f(b.dy)} ${f(b.radial)} ${f(b.tangential)}`);
});
