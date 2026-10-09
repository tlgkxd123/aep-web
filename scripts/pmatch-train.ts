// Trains a Particle Match model on a reference video in headless Edge (real GPU):
//   node scripts/pmatch-train.ts [from] [to] [--video <path>]
// Writes dist-tools/pmatch/model.pmwm and prints the training report.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPmatch, PMATCH_OUT, REFERENCE } from "./lib/pmatch-browser.ts";

const args = process.argv.slice(2);
const videoAt = args.indexOf("--video");
const video = videoAt >= 0 ? args[videoAt + 1] : REFERENCE;
const numbers = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--video").map(Number);
const from = numbers[0] ?? 50;
const to = numbers[1] ?? 80;

const browser = await openPmatch();
try {
  const url = browser.serve(video, "reference.mp4");
  const started = Date.now();
  const result = await browser.call<{ report: Record<string, number>; stages: string[] }>("train", url, from, to, "model");
  const model = browser.uploaded("model");
  writeFileSync(join(PMATCH_OUT, "model.pmwm"), model);
  console.log(`trained on ${from}-${to} s in ${((Date.now() - started) / 1000).toFixed(1)} s; model ${(model.length / 1024).toFixed(0)} KB`);
  console.log(`stages: ${result.stages.join(" > ")}`);
  for (const [k, v] of Object.entries(result.report)) console.log(`  ${k.padEnd(16)} ${Number.isInteger(v) ? v : v.toFixed(4)}`);
} finally {
  await browser.close();
}
