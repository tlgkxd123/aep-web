// Encode curve from the white dot: for pixels unclipped at Exposure 20, the Exposure 1
// value v1 against v20, binned by v1; prints the gamma that maps v1 -> v20 for a 20x gain.
//
//   node scripts/dg-enc.ts [frames a,b,..]
import { reference } from "./dg-cpu.ts";

const frames = (process.argv[2] ?? "3,4,5,6").split(",").map(Number);
const bins = new Map<number, number[]>();
for (const f of frames) {
  const a = reference("deepglow_dot", f);
  const b = reference("deepglow_dot_hot", f);
  for (let y = 128; y < 256; y++) {
    for (let x = 131; x < 256; x++) {
      const i = (y * a.width + x) * 4 + 1;
      const v1 = Math.round(a.data[i] * 255);
      const v20 = Math.round(b.data[i] * 255);
      if (v20 >= 255 || v1 < 2) continue;
      if (!bins.has(v1)) bins.set(v1, []);
      bins.get(v1)!.push(v20);
    }
  }
}
for (const v1 of [...bins.keys()].sort((p, q) => p - q)) {
  const list = bins.get(v1)!.sort((p, q) => p - q);
  const v20 = list[list.length >> 1];
  const gamma = Math.log(20) / Math.log(v20 / v1);
  console.log(`v1 ${String(v1).padStart(3)} -> v20 median ${String(v20).padStart(3)} (n ${String(list.length).padStart(5)})  power-law gamma ${gamma.toFixed(3)}  srgb-check ${srgbRatio(v1, v20).toFixed(2)}`);
}

function srgbRatio(v1: number, v20: number): number {
  const dec = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return dec(v20) / dec(v1);
}
