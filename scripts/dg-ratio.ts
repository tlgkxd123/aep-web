// Median per-pixel ratio of decoded (2.2) glow between two reference frames, over pixels
// where the dumped source is black and both values lie in [lo, 250].
//
//   node scripts/dg-ratio.ts <compA@f> <compB@f> [lo=12] [channel=1]
import { reference, source } from "./dg-cpu.ts";

const [a, b, loArg = "12", chArg = "1"] = process.argv.slice(2);
const [ca, fa] = a.split("@");
const [cb, fb] = b.split("@");
const ra = reference(ca, Number(fa));
const rb = reference(cb, Number(fb));
const src = source(ca, Number(fa));
const lo = Number(loArg) / 255;
const ch = Number(chArg);
const ratios: number[] = [];
for (let i = 0; i < src.width * src.height; i++) {
  if (src.data[i * 4] || src.data[i * 4 + 1] || src.data[i * 4 + 2]) continue;
  const va = ra.data[i * 4 + ch];
  const vb = rb.data[i * 4 + ch];
  if (va < lo || vb < lo || va > 250 / 255 || vb > 250 / 255) continue;
  ratios.push(Math.pow(va / vb, 2.2));
}
ratios.sort((p, q) => p - q);
console.log(`${a} / ${b}: median ${ratios[ratios.length >> 1]?.toFixed(4)} (n ${ratios.length}, quartiles ${ratios[ratios.length >> 2]?.toFixed(4)} .. ${ratios[(3 * ratios.length) >> 2]?.toFixed(4)})`);
