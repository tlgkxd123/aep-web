// Fits CC Radial ScaleWipe's band to transitions2_radialscale_ramp (see check-transitions2-radial.ts): a pixel r from
// Center shows the point r m(s) on its ray, s = (r - r0) / (w - r0) clamped to [0, 1], for the profiles below.
// Prints the best r0, w (and exponent p) per profile, and the rms error in source pixels.
//
//   node scripts/check-transitions2-radialfit.ts <frame> <cx> <cy> [comp]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [frame, cxs, cys, compArg] = process.argv.slice(2);
const [cx, cy] = [Number(cxs), Number(cys)];
const comp = compArg ?? "transitions2_radialscale_ramp";
const { width, height, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const plain = readTiff(new Uint8Array(readFileSync(framePath(comp, 0)))).data;
const greys = Array.from({ length: width }, (_, x) => plain[x * 4]);
const column = (g: number) => {
  for (let x = 0; x + 1 < width; x++) {
    if (g >= greys[x] && g <= greys[x + 1]) return greys[x + 1] > greys[x] ? x + (g - greys[x]) / (greys[x + 1] - greys[x]) : x + 0.5;
  }
  return g < greys[0] ? 0 : width - 1;
};
const samples: [number, number][] = [];
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const [dx, dy] = [x + 0.5 - cx, y + 0.5 - cy];
    const r = Math.hypot(dx, dy);
    if (data[i + 3] === 255 && Math.abs(dx) > 0.7 * r && Math.abs(dx) > 4) samples.push([r, (r * (column(data[i]) + 0.5 - cx)) / dx]);
  }
}
const profiles: Record<string, (s: number, p: number) => number> = {
  power: (s, p) => 1 - (1 - s) ** p,
  sine: (s) => Math.sin((Math.PI * s) / 2),
  powsine: (s, p) => Math.sin((Math.PI * s) / 2) ** p,
};
for (const [name, m] of Object.entries(profiles)) {
  let best = { err: Infinity, r0: 0, w: 0, p: 0 };
  const fit = (r0: number, w: number, p: number) => {
    let sq = 0;
    for (const [r, src] of samples) {
      const s = Math.min(1, Math.max(0, (r - r0) / (w - r0)));
      if (r < r0 + 0.5) continue;
      const e = r * m(s, p) - src;
      sq += e * e;
    }
    return Math.sqrt(sq / samples.length);
  };
  let [r0, w, p] = [samples.length ? 0 : 0, 0, 2];
  const rs = samples.map(([r]) => r);
  const rmin = Math.min(...rs.filter((r, i) => samples[i][1] < r - 0.5));
  const rmax = Math.max(...rs.filter((r, i) => samples[i][1] < r - 0.5));
  [r0, w] = [rmin - 2, rmax + 1];
  for (let pass = 0, step = 1; pass < 60; pass++) {
    let improved = false;
    for (const [dr, dw, dp] of [[step, 0, 0], [-step, 0, 0], [0, step, 0], [0, -step, 0], [0, 0, step / 10], [0, 0, -step / 10]]) {
      const err = fit(r0 + dr, w + dw, p + dp);
      if (err < best.err) {
        best = { err, r0: r0 + dr, w: w + dw, p: p + dp };
        improved = true;
      }
    }
    [r0, w, p] = [best.r0, best.w, best.p];
    if (!improved) step /= 2;
  }
  console.log(`${name}: r0 ${best.r0.toFixed(3)} w ${best.w.toFixed(3)} p ${best.p.toFixed(3)} rms ${best.err.toFixed(3)}`);
}
