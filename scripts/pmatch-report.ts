// Particle Match against its reference video (gates/pmatch.md P5, P6, P12):
//   node scripts/pmatch-report.ts [--check match,mirror,time] [--model <file>] [--train a,b] [--eval a,b] [--video <path>] [--population key=value,...]
// Trains on the training window in headless Edge (real GPU) unless --model names a trained model, then
// compares the model with the held-out window and prints the statistics; each --check prints its
// verdict and the script exits non-zero when one fails.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Evaluation } from "../src/extra/pmatch/evaluate.ts";
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
// Population options for training, e.g. --population maxBack=0,maxAhead=0.
const population = Object.fromEntries(
  (option("--population") ?? "")
    .split(",")
    .filter(Boolean)
    .map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v === "true" ? true : v === "false" ? false : Number(v)];
    }),
);
if (checks.has("time") && modelPath) throw new Error("--check time needs a training run (leave out --model)");

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
    const trained = await browser.call<{ report: Record<string, number> }>("train", url, train[0], train[1], "model", population);
    trainSeconds = (Date.now() - started) / 1000;
    model = browser.uploaded("model");
    writeFileSync(join(PMATCH_OUT, "model.pmwm"), model);
    const r = trained.report;
    console.log(`trained on ${train[0]}-${train[1]} s in ${fixed(trainSeconds, 1)} s (in the page ${fixed(r.seconds, 1)} s: detection ${fixed(r.detectSeconds, 1)}, fitting ${fixed(r.fitSeconds, 1)}, calibration ${fixed(r.calibrateSeconds, 1)})`);
    console.log(`  ${r.tracks} tracks (${r.links} joined), ${r.used} used (${r.emerged} emerged, ${r.censored} censored), ${r.prototypes} prototypes, ${r.sprites} sprites`);
    console.log(`  clock R2 ${fixed(r.clockR2, 2)} at lag ${fixed(r.clockLag)} s, mirror axis ${fixed(r.mirrorAxis, 2)} (score ${fixed(r.mirrorScore)}), depth exponents size ${fixed(r.sizeDepth)} light ${fixed(r.lightDepth)} over ${r.depthTracks} tracks`);
    console.log(`  calibration: rate x${fixed(r.rateGain)}, light x${fixed(r.lightGain)}, size x${fixed(r.sizeGain)}; distance/speed histogram distance ${fixed(r.stepDistanceFirst)} -> ${fixed(r.stepDistance)}`);
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
