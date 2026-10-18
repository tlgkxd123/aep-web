// For transitions2_radialscale_ramp (a black-to-white ramp across the 160 px layer, so a pixel's grey says which column
// it shows): per distance r from Center, the distance of the point shown, assuming it lies on the same ray, from the
// pixels far enough from Center horizontally to tell. Prints r: source distance (alpha, pixels).
//
//   node scripts/check-transitions2-radial.ts <frame> <cx> <cy> [step=1]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [frame, cxs, cys, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((s) => s.split("=")));
const [cx, cy] = [Number(cxs), Number(cys)];
const step = Number(opt.step ?? 1);
const norm = Number(opt.norm ?? 1);
const comp = opt.comp ?? "transitions2_radialscale_ramp";
const { width, height, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
// The ramp's grey per column, from frame 0's top row (far from the hole there), inverted between column centres.
const plain = readTiff(new Uint8Array(readFileSync(framePath(comp, 0)))).data;
const greys = Array.from({ length: width }, (_, x) => plain[x * 4]);
const column = (g: number) => {
  for (let x = 0; x + 1 < width; x++) {
    if (g >= greys[x] && g <= greys[x + 1]) return greys[x + 1] > greys[x] ? x + (g - greys[x]) / (greys[x + 1] - greys[x]) : x + 0.5;
  }
  return g < greys[0] ? 0 : width - 1;
};
if ("debug" in opt) console.log(greys.slice(95, 105).join(" "), column(159), column(160));
const bins = new Map<number, { src: number[]; alpha: number[] }>();
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const [dx, dy] = [x + 0.5 - cx, y + 0.5 - cy];
    const r = Math.hypot(dx, dy);
    const bin = Math.round(r / norm / step) * step;
    const entry = bins.get(bin) ?? { src: [], alpha: [] };
    entry.alpha.push(data[i + 3] / 255);
    if (data[i + 3] === 255 && Math.abs(dx) > 0.7 * r && Math.abs(dx) > 4) {
      const sx = column(data[i]);
      entry.src.push(bin + ((r * (sx + 0.5 - cx)) / dx - r) / norm);
    }
    bins.set(bin, entry);
  }
}
const out: string[] = [];
for (const bin of [...bins.keys()].sort((a, b) => a - b)) {
  const { src, alpha } = bins.get(bin)!;
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  out.push(`${bin.toFixed(3)}: ${src.length ? mean(src).toFixed(norm === 1 ? 2 : 4) : "-"} (${mean(alpha).toFixed(2)}, ${src.length})`);
}
console.log(out.join("\n"));
