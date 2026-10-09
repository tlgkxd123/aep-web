// Diagnostics for Particle Match's detector on a reference video:
//   node scripts/pmatch-explore.ts [from] [to] [--full]
// Writes dist-tools/pmatch/explore/{detections.f32, frame.png, residual.png, mask.png}.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DETECTION_FLOATS } from "../src/extra/pmatch/detect.ts";
import { floats, openPmatch, PMATCH_OUT, REFERENCE } from "./lib/pmatch-browser.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const from = Number(args[0] ?? 60);
const to = Number(args[1] ?? from + 2);
const full = process.argv.includes("--full");
const out = join(PMATCH_OUT, "explore");
mkdirSync(out, { recursive: true });

const browser = await openPmatch();
try {
  const url = browser.serve(REFERENCE, "reference.mp4");
  const info = await browser.call<{ width: number; height: number; frameRate: number; duration: number; frames: number }>("info", url);
  console.log(`reference: ${info.width}x${info.height} ${info.frameRate.toFixed(3)} fps ${info.duration.toFixed(1)} s`);
  const region = full ? [0, 0, info.width, info.height] : [0, 0, Math.floor(info.width / 2) - 20, info.height];
  const openEdges = [true, true, full, true];
  const result = await browser.call<{ frames: number; ms: number; gpuMs: number }>("detect", url, from, to, "det", { region, openEdges }, { dumpAt: from + (to - from) / 2 });
  const data = floats(browser.uploaded("det"));
  writeFileSync(join(out, "detections.f32"), data);
  for (const name of ["frame", "residual", "mask"]) writeFileSync(join(out, `${name}.png`), browser.uploaded(`det-${name}.png`));
  let at = 0;
  const counts: number[] = [];
  while (at < data.length) {
    const n = data[at + 1];
    counts.push(n);
    at += 2 + n * DETECTION_FLOATS;
  }
  counts.sort((a, b) => a - b);
  console.log(`${result.frames} frames in ${(result.ms / 1000).toFixed(1)} s (GPU+readback ${(result.gpuMs / result.frames).toFixed(2)} ms/frame); detections per frame median ${counts[counts.length >> 1]}, min ${counts[0]}, max ${counts[counts.length - 1]}`);
} finally {
  await browser.close();
}
