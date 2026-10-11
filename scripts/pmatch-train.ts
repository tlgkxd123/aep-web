// Trains a Particle Match model on a reference video: the browser's analysis in headless Edge (on the
// high-performance GPU), the PyTorch trainer (ml/pmatch, CUDA when available), then the browser's
// calibration by synthesis:
//   node scripts/pmatch-train.ts [from] [to] [--video <path>] [--raw <model-raw.pmwm>] [--dataset] [--max-seconds <s>]
// Writes dist-tools/pmatch/model.pmwm and prints the training report; the trainer keeps the analysis,
// its raw model and the PyTorch checkpoint in dist-tools/pmatch/trained/. --raw calibrates a model PyTorch
// already trained instead of training one; --dataset only writes the analysis (dist-tools/pmatch/dataset.safetensors)
// for training it with `uv run --project ml/pmatch python -m pmatch train`. --max-seconds fails unless analysing,
// training and calibrating took at most that long.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPmatch, PMATCH_OUT, REFERENCE } from "./lib/pmatch-browser.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const valued = new Set(["--video", "--raw", "--max-seconds"]);
const video = option("--video") ?? REFERENCE;
const raw = option("--raw");
const maxSeconds = option("--max-seconds") === undefined ? undefined : Number(option("--max-seconds"));
const numbers = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1])).map(Number);
const from = numbers[0] ?? 50;
const to = numbers[1] ?? 80;

const browser = await openPmatch();
let failed = false;
try {
  const url = browser.serve(video, "reference.mp4");
  if (args.includes("--dataset")) {
    const result = await browser.call<{ bytes: number; seconds: number }>("dataset", url, from, to, "dataset");
    writeFileSync(join(PMATCH_OUT, "dataset.safetensors"), browser.uploaded("dataset"));
    console.log(`analysed ${from}-${to} s in ${result.seconds.toFixed(1)} s; dataset ${(result.bytes / 2 ** 20).toFixed(1)} MB in ${join(PMATCH_OUT, "dataset.safetensors")}`);
  } else {
    const started = Date.now();
    const result = await browser.call<{ report: Record<string, number>; trainer: Record<string, string | number>; stages: string[] }>(
      "train",
      url,
      from,
      to,
      "model",
      raw ? browser.serve(raw, "model-raw.pmwm") : undefined,
    );
    const seconds = (Date.now() - started) / 1000;
    const model = browser.uploaded("model");
    writeFileSync(join(PMATCH_OUT, "model.pmwm"), model);
    const t = result.trainer;
    console.log(`trained on ${from}-${to} s in ${seconds.toFixed(1)} s; model ${(model.length / 1024).toFixed(0)} KB`);
    console.log(`trainer: ${t.framework} ${t.version} on ${t.device} (${t.deviceName}), ${Number(t.seconds).toFixed(1)} s in Python`);
    console.log(`stages: ${result.stages.join(" > ")}`);
    for (const [k, v] of Object.entries(result.report)) console.log(`  ${k.padEnd(20)} ${Number.isInteger(v) ? v : v.toFixed(4)}`);
    if (maxSeconds !== undefined) {
      if (raw) {
        console.log("FAILED: --max-seconds times a training run (leave out --raw)");
        failed = true;
      } else if (t.framework !== "pytorch") {
        console.log(`FAILED: the model was trained by ${t.framework}, not PyTorch`);
        failed = true;
      } else if (seconds > maxSeconds) {
        console.log(`FAILED: training took ${seconds.toFixed(1)} s (needs <= ${maxSeconds})`);
        failed = true;
      } else console.log("PMATCH-TIME-OK");
    }
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
