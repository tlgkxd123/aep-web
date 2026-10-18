// Compares a channel suite reference frame with our render dumped by pixel-report.ts --dump: a histogram of the
// largest premultiplied channel difference per pixel, the first differing pixels, and optionally one row's values.
//
//   node scripts/check-channel-diff.ts <comp> <frame> [--row y --from x --to x] [--min d]
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { oursPixel, refPixel } from "./check-channel-probe.ts";
import { ROOT } from "./lib/suites.ts";

const [comp, frameArg] = process.argv.slice(2);
const frame = Number(frameArg);
const arg = (name: string, fallback: number) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : fallback);
const ref = refPixel(comp, frame);
const ours = oursPixel(comp, frame);
if (!ours) throw new Error(`no dump of ${comp}@${frame} in refs/ours`);
const name = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`))!;
const [, width, height] = /_(\d+)x(\d+)\.rgba$/.exec(name)!.map(Number);
const premul = (p: number[]) => [0, 1, 2].map((c) => Math.round((p[c] * p[3]) / 255)).concat(p[3]);
const min = arg("--min", 1);
const histogram = new Map<number, number>();
const first: string[] = [];
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const a = premul(ref(x, y));
    const b = premul(ours(x, y));
    const d = Math.max(...a.map((v, c) => Math.abs(v - b[c])));
    histogram.set(d, (histogram.get(d) ?? 0) + 1);
    if (d >= min && first.length < 30) first.push(`${x},${y} ref ${ref(x, y).join(" ")} ours ${ours(x, y).join(" ")}`);
  }
console.log([...histogram].sort((p, q) => p[0] - q[0]).map(([d, n]) => `${d}:${n}`).join(" "));
for (const line of first) console.log(line);
if (process.argv.includes("--rows")) {
  // The number of pixels differing by at least --min in each row.
  const counts: string[] = [];
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < width; x++) {
      const a = premul(ref(x, y));
      const b = premul(ours(x, y));
      if (Math.max(...a.map((v, c) => Math.abs(v - b[c]))) >= min) n++;
    }
    counts.push(`${y}:${n}`);
  }
  console.log(counts.join(" "));
}
if (process.argv.includes("--row")) {
  const y = arg("--row", 0);
  for (let x = arg("--from", 0); x <= arg("--to", width - 1); x++) console.log(`${x},${y}\tref ${ref(x, y).join(" ")}\tours ${ours(x, y).join(" ")}`);
}
