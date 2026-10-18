// Fits the radial alpha profiles of the particular suite's isolated particles (see particular-measure.ts) with
// alpha(d) = peak · (1 − smoothstep(a, b, d)), by least squares over a and b, and prints them per row with the
// residual, so the dependence of a and b on Size and Particle Feather can be read off.
//
//   node scripts/particular-fit.ts <comp> [frame=156] [R=70] [x,x,x=719,869,1019] [--beyond=px]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg = "156", rArg = "70", atArg = "719,869,1019", minArg = "0"] = process.argv.slice(2);
/** Only samples this far out are fitted (beyond the core, a glow is alone). */
const MIN_D = Number(minArg);
const R = Number(rArg);
const ROWS = [80, 240, 400, 560];
const tiff = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const { width, height, data } = tiff;
const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3];

function centroid(x: number, y: number): [number, number] {
  for (let pass = 0; pass < 3; pass++) {
    let [sx, sy, sw] = [0, 0, 0];
    for (let py = Math.max(0, y - 30); py <= Math.min(height - 1, y + 30); py++) {
      for (let px = Math.max(0, x - 30); px <= Math.min(width - 1, x + 30); px++) {
        const a = alpha(px, py) ** 2;
        sx += px * a;
        sy += py * a;
        sw += a;
      }
    }
    if (!sw) break;
    [x, y] = [Math.round(sx / sw), Math.round(sy / sw)];
  }
  return [x, y];
}

/** (distance from the pixel centre to the particle's subpixel centre, alpha) samples around (x, y). */
function samples(x0: number, y0: number): [number, number][] {
  const [x, y] = centroid(x0, y0);
  // Subpixel centre: alpha-weighted mean over the nearest ring of pixels.
  let [sx, sy, sw] = [0, 0, 0];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const a = alpha(x + dx, y + dy) ?? 0;
      sx += (x + dx) * a;
      sy += (y + dy) * a;
      sw += a;
    }
  }
  const [cx, cy] = sw ? [sx / sw, sy / sw] : [x, y];
  const out: [number, number][] = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const d = Math.hypot(px + 0.5 - (cx + 0.5), py + 0.5 - (cy + 0.5));
      if (d <= R && d >= MIN_D) out.push([d, alpha(px, py)]);
    }
  }
  return out;
}

const smooth = (a: number, b: number, d: number) => {
  if (b <= a) return d < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (d - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** With `b` given (--b=), only a and the peak are fitted. */
const fixedB = process.argv.find((a) => a.startsWith("--b="));

function fit(points: [number, number][]) {
  const top = Math.max(...points.map(([, v]) => v));
  const reach = Math.max(...points.filter(([, v]) => v > 1).map(([d]) => d)) + 2;
  // Beyond the core the glow's peak is hidden: fit it too, from the brightest sample up.
  const peaks = MIN_D > 0 ? Array.from({ length: 86 }, (_, k) => top + k * 3).filter((p) => p <= 255) : [top];
  const bs = fixedB ? [Number(fixedB.slice(4))] : Array.from({ length: Math.ceil((reach + 10) / 0.25) }, (_, k) => 0.5 + k * 0.25);
  let best = { a: 0, b: 0, peak: top, err: Infinity };
  for (const peak of peaks) {
    for (const b of bs) {
      for (let a = 0; a <= b; a += 0.25) {
        let err = 0;
        for (const [d, v] of points) err += (peak * (1 - smooth(a, b, d)) - v) ** 2;
        if (err < best.err) best = { a, b, peak, err };
      }
    }
  }
  return { ...best, rms: Math.sqrt(best.err / points.length) };
}

const xs = atArg.split(",").map(Number);
const beyondArg = process.argv.find((a) => a.startsWith("--beyond="));
// The glow alone, outside the core it is laid under.
const beyond = beyondArg ? Number(beyondArg.slice("--beyond=".length)) : 0;
for (const y of ROWS) {
  const points = xs.flatMap((x) => samples(x, y)).filter(([d]) => d >= beyond);
  if (!points.some(([, v]) => v > 8)) {
    console.log(`${comp} row y=${y}: nothing`);
    continue;
  }
  const f = fit(points);
  console.log(`${comp} row y=${y}: peak ${f.peak} a ${f.a.toFixed(1)} b ${f.b.toFixed(1)} rms ${f.rms.toFixed(2)}`);
}
