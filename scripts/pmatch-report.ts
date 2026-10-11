// Particle Match against its reference video (gates/pmatch-torch.md T4):
//   node scripts/pmatch-report.ts [--check torch,match,mirror,detail,time] [--model <file>] [--raw <file>] [--rounds n] [--train a,b] [--eval a,b] [--video <path>]
// Trains on the training window (the browser's analysis in headless Edge, the PyTorch trainer, the browser's
// calibration) unless --model names a finished model or --raw a model PyTorch trained that only needs
// calibrating, then compares the model with the held-out window and prints the statistics; each --check
// prints its verdict and the script exits non-zero when one fails.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Evaluation } from "../src/extra/pmatch/evaluate.ts";
import { decodeModel } from "../src/extra/pmatch/model.ts";
import { openPmatch, PMATCH_OUT, REFERENCE } from "./lib/pmatch-browser.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const pair = (value: string | undefined, fallback: [number, number]): [number, number] => {
  if (!value) return fallback;
  const [a, b] = value.split(",").map(Number);
  return [a, b];
};
const video = option("--video") ?? REFERENCE;
const checks = new Set((option("--check") ?? "").split(",").filter(Boolean));
const train = pair(option("--train"), [50, 80]);
const held = pair(option("--eval"), [136, 166]);
const modelPath = option("--model");
const rawPath = option("--raw");
const rounds = option("--rounds") === undefined ? undefined : Number(option("--rounds"));
if (checks.has("time") && (modelPath || rawPath)) throw new Error("--check time needs a training run (leave out --model and --raw)");

const fixed = (v: number, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : String(v));
const failures: string[] = [];
const require = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};

const browser = await openPmatch();
try {
  const url = browser.serve(video, "reference.mp4");
  let trainSeconds = NaN;
  let model: Uint8Array;
  if (modelPath) model = readFileSync(modelPath);
  else {
    const started = Date.now();
    await browser.call("train", url, train[0], train[1], "model", rawPath ? browser.serve(rawPath, "model-raw.pmwm") : undefined, rounds);
    trainSeconds = (Date.now() - started) / 1000;
    model = browser.uploaded("model");
    writeFileSync(join(PMATCH_OUT, "model.pmwm"), model);
  }
  const decoded = decodeModel(new Uint8Array(model));
  const r = decoded.report;
  const t = decoded.trainer;
  console.log(`trained by ${t.framework} ${t.version} on ${t.device} (${t.deviceName})${Number.isFinite(trainSeconds) ? ` in ${fixed(trainSeconds, 1)} s` : ""}`);
  console.log(`  in the page ${fixed(r.seconds, 1)} s: detection ${fixed(r.detectSeconds, 1)}, PyTorch ${fixed(r.torchSeconds, 1)} (${fixed(r.trainSeconds, 1)} training), calibration ${fixed(r.calibrateSeconds, 1)}`);
  console.log(`  ${r.tracks} tracks (${r.links} joined), ${r.used} used (${r.emerged} emerged, ${r.censored} censored), ${r.prototypes} particles in the bank, ${r.sprites} sprites`);
  console.log(`  audio network: clock R2 ${fixed(r.clockR2, 3)} held back (${fixed(r.clockR2Train, 3)} on the window) after ${r.clockSteps} steps; shake R2 ${fixed(r.shakeR2, 2)}`);
  console.log(`  particle flow: NLL ${fixed(r.flowNll, 3)} train, ${fixed(r.flowNllValid, 3)} held back, after ${r.flowSteps} steps; sprite classes ${fixed(r.spriteAccuracy, 3)} right`);
  console.log(`  appearance: depth exponents size ${fixed(r.sizeDepth)} light ${fixed(r.lightDepth)}; mirror axis ${fixed(r.mirrorAxis, 2)} (score ${fixed(r.mirrorScore)})`);
  console.log(`  calibration (round ${r.calibrationRound} kept): rate x${fixed(r.rateGain)}, light x${fixed(r.lightGain)}, size x${fixed(r.sizeGain)}, speed x${fixed(r.speedGain)}, approach x${fixed(r.approachGain)}; distance/speed histogram distance ${fixed(r.stepDistanceFirst)} -> ${fixed(r.stepDistance)}; sprite share distance ${fixed(r.spriteShareDistanceFirst)} -> ${fixed(r.spriteShareDistance)}; inner/outer speed ${fixed(r.innerSpeedRatio)}/${fixed(r.outerSpeedRatio)} of the reference's`);
  console.log(`  on the training stretches: particles/frame ${fixed(r.countModel, 1)} (reference ${fixed(r.countReference, 1)}), median peak ${fixed(r.peakModel)} (${fixed(r.peakReference)}), spread ${fixed(r.spreadModel)} (${fixed(r.spreadReference)})`);
  if (checks.has("torch")) {
    const before = failures.length;
    require(t.framework === "pytorch", `the model was trained by "${t.framework}", not PyTorch`);
    require(t.device === "cuda", `PyTorch trained on "${t.device}", not CUDA`);
    if (failures.length === before) console.log(`PMATCH-TORCH-CUDA (${t.deviceName})`);
  }
  const e = await browser.call<Evaluation>("evaluate", url, browser.serveBytes(model, "model.pmwm"), held[0], held[1]);
  const c = e.comparison;
  console.log(`held out ${held[0]}-${held[1]} s: ${e.frames} frames, evaluated in ${fixed(e.seconds, 1)} s; model clock ${fixed(e.clockSpeed)} clock s per s`);
  console.log(`                    reference    model`);
  console.log(`  particles/frame   ${fixed(e.count[0], 1).padStart(9)} ${fixed(e.count[1], 1).padStart(8)}   ratio ${fixed(c.countRatio)}`);
  console.log(`  median peak       ${fixed(e.peak[0]).padStart(9)} ${fixed(e.peak[1]).padStart(8)}   KS ${fixed(c.ksPeak)}`);
  console.log(`  median spread     ${fixed(e.spread[0]).padStart(9)} ${fixed(e.spread[1]).padStart(8)}   KS ${fixed(c.ksSpread)}`);
  console.log(`  median radius     ${fixed(e.radius[0], 1).padStart(9)} ${fixed(e.radius[1], 1).padStart(8)}   KS ${fixed(c.ksRadius)}`);
  console.log(`  2-frame steps     ${String(e.steps[0]).padStart(9)} ${String(e.steps[1]).padStart(8)}`);
  console.log(`  outward speed by radius quarter, model / reference: ${c.quartileSpeed.map((v) => fixed(v)).join(", ")}`);
  console.log(`  outward speed (px/frame) by radius tenth: ${c.profile.map((p) => `r<=${p.r.toFixed(0)} ${fixed(p.reference, 2)}/${fixed(p.model, 2)}`).join("  ")}`);
  console.log(`  quarter-second speed series correlation ${fixed(c.speedSeries)} over ${c.bins} bins`);
  console.log(`  sprites (template vs held-out crops most like it): ${e.sprites.map((s) => `${fixed(s.correlation)} (${s.crops} crops)`).join(", ")}; mean crop ${fixed(e.meanSprite)} (${e.crops[0]} / ${e.crops[1]} crops)`);
  console.log(`  mirror correlation about x = ${fixed(e.mirror.axis, 2)}: reference ${fixed(e.mirror.reference)}, model ${fixed(e.mirror.model)}`);
  const p = e.profiles;
  p.reference.forEach((profile, k) =>
    console.log(`  light / peak at r = 0..16 px, brightness third ${k + 1}: reference ${profile.map((v) => v.toFixed(2)).join(" ")} | model ${p.model[k].map((v) => v.toFixed(2)).join(" ")} | distance ${fixed(p.distance[k])}`),
  );
  console.log(`  median size by brightness third, reference / model: ${e.spreadByThird.reference.map((r, k) => `${fixed(r, 2)}/${fixed(e.spreadByThird.model[k], 2)}`).join("  ")}`);
  console.log(`  sprite shares, reference / model: ${e.shares.reference.map((r, k) => `${fixed(r, 2)}/${fixed(e.shares.model[k], 2)}`).join("  ")}; total variation ${fixed(e.shares.distance)}`);

  if (checks.has("match")) {
    const before = failures.length;
    require(Math.abs(c.countRatio - 1) <= 0.15, `particles per frame ratio ${fixed(c.countRatio)} (needs 0.85-1.15)`);
    require(c.ksPeak <= 0.15, `brightness KS ${fixed(c.ksPeak)} (needs <= 0.15)`);
    require(c.ksSpread <= 0.15, `size KS ${fixed(c.ksSpread)} (needs <= 0.15)`);
    require(c.ksRadius <= 0.15, `radius KS ${fixed(c.ksRadius)} (needs <= 0.15)`);
    c.quartileSpeed.forEach((v, k) => require(Math.abs(v - 1) <= 0.25, `radius quarter ${k + 1} speed ratio ${fixed(v)} (needs 0.75-1.25)`));
    require(c.speedSeries >= 0.5, `speed series correlation ${fixed(c.speedSeries)} (needs >= 0.5)`);
    e.sprites.forEach((s, k) => require(s.correlation >= 0.85, `sprite ${k + 1} correlation ${fixed(s.correlation)} over ${s.crops} crops (needs >= 0.85)`));
    if (failures.length === before) console.log("PMATCH-REFERENCE-PASSED");
  }
  if (checks.has("mirror")) {
    const before = failures.length;
    require(e.mirror.model <= 0.2, `model mirror correlation ${fixed(e.mirror.model)} (needs <= 0.2)`);
    require(e.mirror.reference >= 0.9, `reference mirror correlation ${fixed(e.mirror.reference)} (needs >= 0.9)`);
    if (failures.length === before) console.log("PMATCH-UNMIRRORED");
  }
  if (checks.has("detail")) {
    const before = failures.length;
    p.distance.forEach((v, k) => require(v <= 0.25, `brightness third ${k + 1} light profile distance ${fixed(v)} (needs <= 0.25)`));
    require(e.shares.distance <= 0.15, `sprite share total variation ${fixed(e.shares.distance)} (needs <= 0.15)`);
    if (failures.length === before) console.log("PMATCH-DETAIL-PASSED");
  }
  if (checks.has("time")) {
    const before = failures.length;
    require(trainSeconds <= 180, `training took ${fixed(trainSeconds, 1)} s (needs <= 180)`);
    if (failures.length === before) console.log("PMATCH-TIME-OK");
  }
} finally {
  await browser.close();
}
if (failures.length) {
  for (const f of failures) console.log(`FAILED: ${f}`);
  process.exit(1);
}
