// Times the composition viewer path (render + present) on the heaviest corpus
// comps in headless Edge, for the working tree and for a base revision built
// from `git archive`, and prints milliseconds per frame before and after.
//
//   node scripts/perf-report.ts [--base 13ddece] [--frames 48] [--gpu] [--only name,name] [--require]
//
// --gpu uses the hardware GPU instead of swiftshader. Every comp is also
// rendered with warm and with cleared content caches, which must give the same
// pixels. --require exits non-zero unless the summed frame time of all comps at
// least halves, no comp gets more than 10 % slower and no cached frame differs.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { build } from "vite";
import { parseProject } from "../src/aep/parse.ts";
import { ROOT } from "./lib/suites.ts";
import { SAMPLES } from "./lib/paths.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const baseRev = opt("--base") ?? "13ddece";
const frameCount = Number(opt("--frames") ?? 48);
const only = opt("--only")?.split(",");

interface Job {
  label: string;
  file: string;
  comp: string;
}
const samples = resolve(SAMPLES);
const JOBS: Job[] = [
  { label: "complete Main_Comp", file: join(samples, "versions/ae2025/complete.aep"), comp: "Main_Comp" },
  { label: "replace_font PROBE_MAIN", file: join(samples, "models/text/replace_font.aep"), comp: "PROBE_MAIN" },
  { label: "geometry_probe PROBE_MAIN", file: join(samples, "models/layer/geometry_probe.aep"), comp: "PROBE_MAIN" },
  { label: "shape_many_points", file: join(samples, "models/property/shape_misc.aep"), comp: "shape_many_points" },
  { label: "indexed_group_controllers", file: join(samples, "models/essential_graphics/indexed_group_controllers.aep"), comp: "Comp 1" },
  { label: "mask_feather_falloff_smooth", file: join(samples, "models/property/mask_feather_falloff_smooth.aep"), comp: "Comp 1" },
  { label: "fixture shape_repeater", file: join(ROOT, "fixtures/fixtures.aep"), comp: "shape_repeater" },
  { label: "fixture shape_animated_trim", file: join(ROOT, "fixtures/fixtures.aep"), comp: "shape_animated_trim" },
  { label: "fixture mask_feather", file: join(ROOT, "fixtures/fixtures.aep"), comp: "mask_feather" },
].filter((j) => !only || only.some((o) => j.label.includes(o)));

const outRoot = resolve("dist-tools");

async function bundle(root: string, outDir: string): Promise<string> {
  await build({
    root,
    configFile: false,
    logLevel: "error",
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      lib: { entry: join(root, "scripts/perf/perf-entry.ts"), name: "AepPerf", formats: ["iife"], fileName: () => "perf.js" },
    },
  });
  return join(outDir, "perf.js");
}

const currentJs = await bundle(resolve("."), join(outRoot, "perf-current"));
const baseDir = join(tmpdir(), `aep-perf-base-${baseRev}`);
rmSync(baseDir, { recursive: true, force: true });
mkdirSync(baseDir, { recursive: true });
execSync(`git archive --format=tar -o "${join(baseDir, "src.tar")}" ${baseRev} src`);
execSync(`tar -xf src.tar`, { cwd: baseDir });
mkdirSync(join(baseDir, "scripts/perf"), { recursive: true });
cpSync(resolve("scripts/perf/perf-entry.ts"), join(baseDir, "scripts/perf/perf-entry.ts"));
const baseJs = await bundle(baseDir, join(outRoot, "perf-base"));

const gpu = args.includes("--gpu");
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: gpu ? [] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

async function pageFor(script: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ path: script });
  return page;
}
const pages = { base: await pageFor(baseJs), current: await pageFor(currentJs) };

const stats = (ms: number[]) => {
  const sorted = [...ms].sort((a, b) => a - b);
  return { mean: ms.reduce((a, b) => a + b, 0) / ms.length, median: sorted[Math.floor(sorted.length / 2)] };
};

console.log(`viewer path (render + present), ${frameCount} consecutive frames from the work area start, ${gpu ? "hardware GPU" : "swiftshader"}`);
console.log(`base ${baseRev} vs working tree; ms per frame (mean / median), first frame excluded`);
let baseTotal = 0;
let currentTotal = 0;
let regressed = false;
let cacheChecks = 0;
const cacheMismatches: string[] = [];
for (const job of JOBS) {
  if (!existsSync(job.file)) {
    console.log(`skip ${job.label}: ${job.file} missing`);
    continue;
  }
  const bytes = readFileSync(job.file);
  for (const page of Object.values(pages)) await page.evaluate((b) => (globalThis as any).aepPerf.load(b), bytes.toString("base64"));
  const project = parseProject(new Uint8Array(bytes));
  const item = [...project.items.values()].find((i) => i.kind === "comp" && i.name === job.comp);
  if (!item || item.kind !== "comp") throw new Error(`${job.label}: no comp ${job.comp}`);
  const frame = item.frameDuration || 1 / (item.frameRate || 24);
  const times = Array.from({ length: frameCount + 1 }, (_, i) => item.workAreaStart + i * frame).filter((t) => t < item.duration);
  const result: Record<string, { mean: number; median: number }> = {};
  for (const [name, page] of Object.entries(pages)) {
    const r = await page.evaluate(([c, t]) => (globalThis as any).aepPerf.time(c, t), [job.comp, times] as const);
    result[name] = stats(r.ms.slice(1));
  }
  baseTotal += result.base.mean;
  currentTotal += result.current.mean;
  if (result.current.mean > result.base.mean * 1.1 && result.current.mean - result.base.mean > 1) regressed = true;
  const verifyTimes = times.filter((_, i) => i % 6 === 0);
  const check = await pages.current.evaluate(([c, t]) => (globalThis as any).aepPerf.verifyCaches(c, t), [job.comp, verifyTimes] as const);
  cacheChecks += check.checked;
  cacheMismatches.push(...check.mismatches.map((t: number) => `${job.label}@${t.toFixed(3)}s`));
  console.log(
    `${job.label.padEnd(30)} ${`${item.width}x${item.height}`.padEnd(10)} before ${result.base.mean.toFixed(2).padStart(8)} / ${result.base.median.toFixed(2).padStart(8)}  after ${result.current.mean.toFixed(2).padStart(8)} / ${result.current.median.toFixed(2).padStart(8)}  x${(result.base.mean / result.current.mean).toFixed(2)}${check.mismatches.length ? "  CACHED FRAMES DIFFER" : ""}`,
  );
}
await browser.close();
console.log(`total mean ms/frame: before ${baseTotal.toFixed(1)}, after ${currentTotal.toFixed(1)} (x${(baseTotal / currentTotal).toFixed(2)})`);
console.log(`content caches: ${cacheChecks} frames rendered warm and cold, ${cacheMismatches.length} differ${cacheMismatches.length ? `: ${cacheMismatches.join(", ")}` : ""}`);
if (args.includes("--require")) {
  if (currentTotal * 2 <= baseTotal && !regressed && cacheChecks > 0 && cacheMismatches.length === 0) console.log("PERF-PASSED");
  else {
    console.log("performance requirement not met");
    process.exit(1);
  }
}
