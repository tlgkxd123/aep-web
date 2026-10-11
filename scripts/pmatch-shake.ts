// How Particle Match measures a reference video's shake (src/extra/pmatch/shake.ts):
//   node scripts/pmatch-shake.ts [from] [to] [video]
// Prints the measured S_Shake settings and, per half second, the shake's RMS and the frames whose
// motion was not measured; writes dist-tools/pmatch/shake.f32 (8 floats per frame, see harness.ts).
// How the Amplitude follows the music is learned with the rest of the world model (ml/pmatch).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { floats, openPmatch, PMATCH_OUT, REFERENCE } from "./lib/pmatch-browser.ts";

const args = process.argv.slice(2);
const from = Number(args[0] ?? 60);
const to = Number(args[1] ?? from + 20);
const video = args[2] ?? REFERENCE;

interface Result {
  frames: number;
  first: number;
  frameRate: number;
  msPerFrame: number;
  shake: { frequency: number; x: number; y: number; tilt: number; level: number } | null;
  report: { rms: number; tiltRms: number };
}

const browser = await openPmatch();
try {
  const result = await browser.call<Result>("shake", browser.serve(video, "reference.mp4"), from, to, "shake");
  const data = floats(browser.uploaded("shake"));
  writeFileSync(join(PMATCH_OUT, "shake.f32"), data);
  const { shake, report, frameRate } = result;
  console.log(`${result.frames} frames from ${(result.first / frameRate).toFixed(2)} s, ${result.msPerFrame.toFixed(1)} ms per frame`);
  console.log(`shake RMS ${report.rms.toFixed(2)} px, tilt RMS ${report.tiltRms.toFixed(3)} deg`);
  if (shake) {
    console.log(`S_Shake: Frequency ${shake.frequency.toFixed(2)}, X Rand Amp ${shake.x.toFixed(1)}, Y Rand Amp ${shake.y.toFixed(1)}, Tilt Rand Amp ${shake.tilt.toFixed(2)}, mean Amplitude ${shake.level.toFixed(2)}`);
  } else console.log("no shake");
  const per = Math.max(1, Math.round(frameRate / 2));
  const lines: string[] = [];
  for (let a = 0; a < result.frames; a += per) {
    let sum = 0;
    let n = 0;
    let missed = 0;
    let agreement = 0;
    for (let k = a; k < Math.min(result.frames, a + per); k++) {
      const x = data[k * 8 + 5];
      const y = data[k * 8 + 6];
      if (Number.isNaN(data[k * 8])) missed++;
      else agreement += data[k * 8 + 4];
      sum += x * x + y * y;
      n++;
    }
    const value = Math.sqrt(sum / Math.max(1, n));
    lines.push(`${((result.first + a) / frameRate).toFixed(1).padStart(6)} s ${value.toFixed(1).padStart(6)} px ${"#".repeat(Math.min(60, Math.round(value * 2)))}${missed ? ` (${missed} unmeasured)` : ""} agree ${(agreement / Math.max(1, n - missed)).toFixed(2)}`);
  }
  console.log(lines.join("\n"));
} finally {
  await browser.close();
}
