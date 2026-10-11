// Milliseconds per frame of the Particle Match analysis' parts in headless Edge on the high-performance GPU:
// decoding, uploading, the shake meter, the detector's passes, its read (stalling, and queued), and the whole
// analysis. --require fails unless the whole analysis takes at most that many milliseconds per frame.
// --synthesis instead times calibration's parts for a model (sampling, rendering, detecting, tracking).
//   node scripts/pmatch-profile.ts [--from 50] [--to 62] [--video <path>] [--require <ms>] [--synthesis [--model <file>]]
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
  if (args.includes("--synthesis")) {
    const model = browser.serve(option("model", join(PMATCH_OUT, "model.pmwm")), "model.pmwm");
    const parts = await browser.call<Record<string, number>>("profileSynthesis", url, model, Number(option("from", "50")), Number(option("to", "62")));
    for (const [part, value] of Object.entries(parts)) console.log(`${part.padEnd(10)} ${value.toFixed(2).padStart(8)}${part === "particles" ? " per frame" : " ms/frame"}`);
    process.exit(0);
  }
  const result = await browser.call<Record<string, { frames: number; ms: number }>>("profile", url, Number(option("from", "50")), Number(option("to", "62")));
  for (const [part, { frames, ms }] of Object.entries(result)) console.log(`${part.padEnd(9)} ${ms.toFixed(2).padStart(7)} ms/frame over ${frames} frames`);
  if (required !== undefined) {
    if (result.analysis.ms <= required) console.log("PMATCH-ANALYSIS-FAST");
    else {
      console.log(`FAILED: the analysis took ${result.analysis.ms.toFixed(2)} ms per frame (needs <= ${required})`);
      failed = true;
    }
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
