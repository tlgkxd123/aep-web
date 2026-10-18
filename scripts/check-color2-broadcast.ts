// Tests candidate signal amplitudes for Broadcast Colors against a probe frame that keys out unsafe pixels:
// for each candidate, the largest amplitude among the kept cells and the smallest among the keyed ones
// (separable when the first is below the second), then the scale "reduce luminance" applied per cell.
//   node scripts/check-color2-broadcast.ts [--keyed 76] [--reduced 74]
import { readFileSync } from "node:fs";
import { srgbToLinear } from "../src/render/effects/colorExtraMath.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff, type Image } from "./lib/tiff.ts";

const opt = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const read = (f: number): Image => readTiff(new Uint8Array(readFileSync(framePath("color2_probe", f))));
const cell = (img: Image, k: number) => {
  const o = ((Math.floor(k / 16) * 8 + 4) * img.width + (k % 16) * 8 + 4) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
};
const src = read(0);
const keyed = read(Number(opt("--keyed", "76")));
const reduced = read(Number(opt("--reduced", "74")));

type Amp = (c: number[]) => number;
const yiq = (c: number[], w = [0.299, 0.587, 0.114]) => {
  const y = w[0] * c[0] + w[1] * c[1] + w[2] * c[2];
  const u = 0.492 * (c[2] - y), v = 0.877 * (c[0] - y);
  return [y, Math.hypot(u, v)];
};
const lin = (c: number[]) => c.map(srgbToLinear);
const candidates: Record<string, Amp> = {
  "Y+C": (c) => yiq(c).reduce((a, b) => a + b),
  "C-Y": (c) => { const [y, ch] = yiq(c); return ch - y; },
  "max(Y+C, k(C-Y))": (c) => { const [y, ch] = yiq(c); return Math.max(y + ch, 1.5 * (ch - y)); },
  C: (c) => yiq(c)[1],
  "lin Y+C": (c) => yiq(lin(c)).reduce((a, b) => a + b),
  "709 Y+C": (c) => yiq(c, [0.2126, 0.7152, 0.0722]).reduce((a, b) => a + b),
  "Y+C(IQ)": (c) => {
    const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    return y + Math.hypot(0.596 * c[0] - 0.274 * c[1] - 0.322 * c[2], 0.211 * c[0] - 0.523 * c[1] + 0.312 * c[2]);
  },
};

const cells = Array.from({ length: 256 }, (_, k) => ({ k, rgb: cell(src, k).slice(0, 3).map((v) => v / 255), out: cell(keyed, k), red: cell(reduced, k) }));
for (const [name, amp] of Object.entries(candidates)) {
  let kept = -Infinity, cut = Infinity, keptK = -1, cutK = -1;
  for (const c of cells) {
    const a = amp(c.rgb);
    if (c.out[3] === 0) { if (a < cut) { cut = a; cutK = c.k; } }
    else if (a > kept) { kept = a; keptK = c.k; }
  }
  console.log(`${name.padEnd(18)} kept max ${kept.toFixed(4)} (#${keptK})  keyed min ${cut.toFixed(4)} (#${cutK})  ${kept < cut ? "separable" : ""}`);
}
console.log("\ntwo-sided: unsafe when Y + kC > high or Y - kC < low (601 Y, composite U/V)");
for (const linear of [false, true])
for (const weights of [[0.299, 0.587, 0.114], [0.2126, 0.7152, 0.0722]])
  for (let k = 0.3; k <= 3.001; k += 0.05)
    for (let low = -1.5; low <= 0.2; low += 0.005) {
      let safeHigh = -Infinity, unsafeHigh = Infinity, ok = true;
      for (const c of cells) {
        const [y, ch] = yiq(linear ? lin(c.rgb) : c.rgb, weights);
        const lo = y - k * ch < low;
        if (c.out[3] !== 0) { if (lo) { ok = false; break; } safeHigh = Math.max(safeHigh, y + k * ch); }
        else if (!lo) unsafeHigh = Math.min(unsafeHigh, y + k * ch);
      }
      if (ok && safeHigh < unsafeHigh)
        console.log(`  ${linear ? "linear " : ""}Y ${weights[0]} k ${k.toFixed(2)} low ${low.toFixed(3)} high in (${safeHigh.toFixed(4)}, ${unsafeHigh.toFixed(4)})`);
    }
console.log("\nreduced cells: in -> out, scale, Y+C(IQ)·scale");
for (const c of cells) {
  if (c.out[3] !== 0) continue;
  const scale = Math.max(...c.red.slice(0, 3)) / 255 / Math.max(...c.rgb);
  console.log(`#${c.k} ${c.rgb.map((v) => Math.round(v * 255))} -> ${c.red.slice(0, 3)} scale ${scale.toFixed(3)} amp ${(candidates["Y+C(IQ)"](c.rgb) * scale).toFixed(4)}`);
}
