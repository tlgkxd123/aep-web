// Milliseconds per frame of the Particle Match preview (the learned particles the dialog plays, preview.ts) at
// the reference video's full resolution in headless Edge on the high-performance GPU, each frame waited for on
// the GPU. --require fails unless the median frame takes at most that many milliseconds.
//   node scripts/pmatch-inference.ts [--model <file>] [--from 136] [--frames 120] [--video <path>] [--require <ms>]
import { join } from "node:path";
import { openPmatch, PMATCH_OUT, REFERENCE } from "./lib/pmatch-browser.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const required = args.includes("--require") ? Number(option("require", "NaN")) : undefined;
const browser = await openPmatch();
let failed = false;
try {
  const url = browser.serve(option("video", REFERENCE), "reference.mp4");
  const model = browser.serve(option("model", join(PMATCH_OUT, "model.pmwm")), "model.pmwm");
  const r = await browser.call<{ width: number; height: number; frames: number; median: number; p95: number; mean: number }>(
    "inference",
    url,
    model,
    Number(option("from", "136")),
    Number(option("frames", "120")),
  );
  console.log(`preview ${r.width}x${r.height}: median ${r.median.toFixed(2)} ms, 95th percentile ${r.p95.toFixed(2)} ms, mean ${r.mean.toFixed(2)} ms over ${r.frames} frames`);
  if (required !== undefined) {
    if (r.median <= required) console.log("PMATCH-INFERENCE-FAST");
    else {
      console.log(`FAILED: the preview took ${r.median.toFixed(2)} ms per frame (needs <= ${required})`);
      failed = true;
    }
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
