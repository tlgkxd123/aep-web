// Per-quadrant comparison of a dumped render (pixel-report --dump) with its reference.
//
//   node scripts/fxextra-quad-diff.ts <comp> <frame> [worst count]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, count = "6"] = process.argv.slice(2);
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const dumpName = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`));
if (!dumpName) throw new Error("no dump; run pixel-report --dump");
const ours = new Uint8Array(readFileSync(join(ROOT, "ours", dumpName)));
const { width, height } = ref;
const premul = (d: Uint8Array, i: number, c: number) => (c === 3 ? d[i + 3] : (d[i + c] * d[i + 3]) / 255);
const quads = [0, 1, 2, 3].map(() => ({ bad: 0, sum: 0, n: 0, worst: [] as { d: number; x: number; y: number }[] }));
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(premul(ours, p, c) - premul(ref.data, p, c)));
    const q = quads[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)];
    q.n++;
    q.sum += d;
    if (d > 3) {
      q.bad++;
      q.worst.push({ d, x, y });
    }
  }
}
quads.forEach((q, i) => {
  console.log(`q${i}: bad ${q.bad} (${((100 * q.bad) / q.n).toFixed(2)}%) mean ${(q.sum / q.n).toFixed(2)}`);
  q.worst.sort((a, b) => b.d - a.d);
  for (const w of q.worst.slice(0, Number(count))) {
    const p = (w.y * width + w.x) * 4;
    console.log(`   (${w.x},${w.y}) d ${w.d.toFixed(0)} ref ${[...ref.data.subarray(p, p + 4)]} ours ${[...ours.subarray(p, p + 4)]}`);
  }
});
