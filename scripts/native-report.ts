// Renders the fixture frames of every suite (refs/fixtures/*manifest.json) with the native Vulkan engine and compares
// them with After Effects' reference TIFFs (refs/frames) by the pixel criterion pixel-report.ts holds the WebGL
// renderer to. Frames whose plan the engine cannot render yet (text layers, footage, effects, dashed strokes) are
// listed as left to the WebGL renderer, not failed. Diff sheets go to refs/diff/native.
//
//   cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
//   node scripts/native-report.ts [--suite name] [--only comp,comp] [--engine path] [--require [--min n]]
//
// --require fails unless every frame the engine renders passes and, with --min, at least n frames were rendered.
// Any Vulkan device does, Mesa's lavapipe included (AEVK_DEVICE=llvmpipe picks it).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompItem, Project } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import "../src/expressions/install.ts";
import { buildFramePlan } from "../src/native/plan.ts";
import { encodePlan } from "../src/native/wire.ts";
import { findRenderTool } from "./lib/native.ts";
import { compareFrames, diffSheet, KNOWN_MEAN_LIMIT, passes, worthASheet } from "./lib/pixel-criterion.ts";
import { encodePng } from "./lib/png.ts";
import { framePath, loadSuites, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = option("--only") ? new Set(option("--only")!.split(",")) : undefined;
const suites = loadSuites(option("--suite"));
const tool = findRenderTool(option("--engine"));
if (!tool) {
  console.log("the native renderer is not built: cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build");
  process.exit(1);
}
const DEFAULT_FPS = 24;
const KNOWN: Record<string, string> = {
  "mask_feather@0": "AE's feather falls off ~0.01 faster inside the edge than a Gaussian; outside it matches exactly",
};
for (const suite of suites) Object.assign(KNOWN, suite.known);

const work = mkdtempSync(join(tmpdir(), "aevk-report-"));
const diffDir = join(ROOT, "diff", "native");
rmSync(diffDir, { recursive: true, force: true });
mkdirSync(diffDir, { recursive: true });

type Job = { name: string; comp: string; frame: number; plan?: string; unsupported?: string[]; warnings: string[] };
const jobs: Job[] = [];
const projects = new Map<string, Project>();
for (const suite of suites) {
  let project = projects.get(suite.project);
  if (!project) {
    const file = join(ROOT, "fixtures", suite.project);
    if (!existsSync(file)) continue;
    projects.set(suite.project, (project = parseProject(new Uint8Array(readFileSync(file)))));
  }
  for (const { comp: name, frames, fps = DEFAULT_FPS } of suite.comps) {
    if (only && !only.has(name)) continue;
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name);
    for (const frame of frames) {
      const job: Job = { name: `${name}@${frame}`, comp: name, frame, warnings: [] };
      jobs.push(job);
      if (!comp) {
        job.unsupported = ["the comp is not in the project"];
        continue;
      }
      const plan = buildFramePlan(project, comp, frame / fps);
      job.warnings = plan.warnings;
      if (plan.unsupported.length) {
        job.unsupported = plan.unsupported;
        continue;
      }
      job.plan = join(work, `${jobs.length - 1}.aevp`);
      writeFileSync(job.plan, encodePlan(plan));
    }
  }
}

const planned = jobs.filter((j) => j.plan);
const results = new Map<string, { output?: string; width?: number; height?: number; ms?: number; error?: string }>();
let device = "";
if (planned.length) {
  let stdout = "";
  try {
    stdout = execFileSync(tool, ["--info", ...planned.map((j) => j.plan!)], { encoding: "utf8", maxBuffer: 1 << 26 });
  } catch (error) {
    stdout = String((error as { stdout?: string }).stdout ?? "");
  }
  for (const line of stdout.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.device) device = `${entry.device} (Vulkan ${entry.apiVersion})`;
    else if (entry.plan) results.set(entry.plan, entry);
    else if (entry.error) throw new Error(`the engine could not start: ${entry.error}`);
  }
}

type Row = { name: string; status: "ok" | "known" | "DIFF" | "NO REF" | "ERROR" | "webgl"; note: string; ms?: number };
const rows: Row[] = [];
for (const job of jobs) {
  if (!job.plan) {
    rows.push({ name: job.name, status: "webgl", note: job.unsupported!.join("; ") });
    continue;
  }
  const result = results.get(job.plan);
  if (!result?.output) {
    rows.push({ name: job.name, status: "ERROR", note: result?.error ?? "no output" });
    continue;
  }
  const refPath = framePath(job.comp, job.frame);
  if (!existsSync(refPath)) {
    rows.push({ name: job.name, status: "NO REF", note: "" });
    continue;
  }
  const ref = readTiff(new Uint8Array(readFileSync(refPath)));
  const ours = new Uint8Array(readFileSync(result.output));
  if (result.width !== ref.width || result.height !== ref.height) {
    rows.push({ name: job.name, status: "DIFF", note: `size ${result.width}x${result.height} vs ${ref.width}x${ref.height}` });
    continue;
  }
  const c = compareFrames(ref.data, ours, ref.width, ref.height);
  const status = passes(c) ? "ok" : job.name in KNOWN && c.meanDiff <= KNOWN_MEAN_LIMIT ? "known" : "DIFF";
  if (worthASheet(c)) writeFileSync(join(diffDir, `${job.comp}_f${job.frame}.png`), encodePng(ref.width * 3, ref.height, diffSheet(ref.data, ours, c.diff, ref.width, ref.height)));
  const note = `interior ${(c.interiorShare * 100).toFixed(2).padStart(5)}%  all ${(c.badShare * 100).toFixed(2).padStart(5)}%  max ${String(Math.round(c.maxDiff)).padStart(3)}  mean ${c.meanDiff.toFixed(2)}`;
  rows.push({ name: job.name, status, note: note + (job.warnings.length ? `  [${job.warnings.join("; ")}]` : ""), ms: result.ms });
}
rmSync(work, { recursive: true, force: true });

const rendered = rows.filter((r) => r.status !== "webgl");
const passing = rendered.filter((r) => r.status === "ok" || r.status === "known");
console.log(`device: ${device || "none"}`);
console.log(
  `frames: ${rows.length}, rendered natively: ${rendered.length}, passing: ${passing.length} (${rendered.filter((r) => r.status === "known").length} known approximations), left to WebGL: ${rows.length - rendered.length}`,
);
for (const r of rows) console.log(`${r.status.padEnd(6)} ${r.name.padEnd(36)} ${r.note}${r.ms !== undefined ? `  ${r.ms.toFixed(1)} ms` : ""}`);
if (args.includes("--require")) {
  const min = Number(option("--min") ?? 1);
  if (rendered.length >= min && passing.length === rendered.length) console.log("NATIVE-PIXELS-PASSED");
  else {
    console.log("native pixel requirement not met");
    process.exit(1);
  }
}
