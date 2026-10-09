// Deep Glow 2's tone transfer where the glow is (nearly) flat: source -> output on a
// ramp strip's centre row, next to candidate decode/encode curve pairs.
//
//   node scripts/dg-transfer.ts [comp=deepglow_exposure] [frame=0] [row=8] [channel=1]
import { reference, source } from "./dg-cpu.ts";

const [comp = "deepglow_exposure", frameArg = "0", rowArg = "8", chArg = "1"] = process.argv.slice(2);
const src = source(comp, 0);
const ref = reference(comp, Number(frameArg));
const y = Number(rowArg);
const ch = Number(chArg);
const srgbDecode = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const srgbEncode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const pairs: Record<string, (s: number) => number> = {
  "2.2>srgb": (s) => srgbEncode(Math.pow(s, 2.2)),
  "srgb>2.2": (s) => Math.pow(srgbDecode(s), 1 / 2.2),
  "2.4>srgb": (s) => srgbEncode(Math.pow(s, 2.4)),
};
const seen = new Set<number>();
console.log(`src  ref  ${Object.keys(pairs).join("  ")}`);
for (let x = 0; x < src.width; x++) {
  const i = (y * src.width + x) * 4 + ch;
  const s = Math.round(src.data[i] * 255);
  if (seen.has(s) || s % 8 !== 0) continue;
  seen.add(s);
  const cells = Object.values(pairs).map((f) => (255 * f(s / 255)).toFixed(1).padStart(8));
  console.log(`${String(s).padStart(3)}  ${String(Math.round(ref.data[i] * 255)).padStart(3)}  ${cells.join("")}`);
}
