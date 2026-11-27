// Checks the C++ project core (native/core) against the TypeScript planner: every fixture frame is planned by both,
// and the plans are compared field by field, with what each side cannot render compared as a set. It also prints the
// time each side takes to parse the projects and plan the frames.
//
//   cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
//   node scripts/reports/native-parity.ts [--suite name] [--scale s] [--sweep n] [--expressions] [--tool path]
//                                         [--verbose] [--require]
//
// By default it plans the frames the suites' manifests list. --sweep plans every comp of every fixture project at n
// times spread over its duration instead, which covers far more layers than the manifests do.
// Expressions are left out on both sides unless --expressions is given; that needs a native build configured with
// -DAEP_EXPRESSIONS=ON (docs/native-port.md, M3), and checks first that its expression bundle is current.
// --require fails when any frame differs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CompItem, Project } from "../../src/aep/model.ts";
import { parseProject } from "../../src/aep/parse.ts";
import { buildFramePlan } from "../../src/native/plan.ts";
import { decodePlan, encodePlan } from "../../src/native/wire.ts";
import { loadSuites, ROOT } from "../lib/suites.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const verbose = args.includes("--verbose");
const scale = Number(option("--scale") ?? 1);
const sweep = Number(option("--sweep") ?? 0);
const expressions = args.includes("--expressions");
const tool = resolve(option("--tool") ?? "native/build/aep-plan");
if (!existsSync(tool)) {
  console.error(`${tool} is missing: build native/ first (cmake -S native -B native/build && cmake --build native/build)`);
  process.exit(2);
}

if (expressions) {
  execFileSync(process.execPath, ["scripts/native/build-expressions.ts", "--check"], { stdio: "inherit" });
  await import("../../src/expressions/install.ts");
}

interface Job {
  label: string;
  project: string;
  compId: number;
  time: number;
  unsupported: string[];
  plan?: Uint8Array;
}

const jobs: Job[] = [];
let tsParseMs = 0;
let tsPlanMs = 0;
let projects = 0;
const swept = new Set<string>();
for (const suite of loadSuites(option("--suite"))) {
  const path = resolve(ROOT, "fixtures", suite.project);
  let project: Project;
  const parseStart = performance.now();
  try {
    project = parseProject(new Uint8Array(readFileSync(path)));
  } catch (e) {
    console.log(`skipped ${suite.project}: ${String(e).slice(0, 100)}`);
    continue;
  }
  tsParseMs += performance.now() - parseStart;
  projects++;
  const plan = (comp: CompItem, time: number, label: string) => {
    const planStart = performance.now();
    const framePlan = buildFramePlan(project, comp, time, { scale });
    tsPlanMs += performance.now() - planStart;
    jobs.push({
      label: `${suite.project} ${label}`,
      project: path,
      compId: comp.id,
      time,
      unsupported: framePlan.unsupported,
      plan: framePlan.unsupported.length ? undefined : encodePlan(framePlan),
    });
  };
  if (sweep > 0) {
    if (swept.has(path)) continue;
    swept.add(path);
    for (const item of project.items.values()) {
      if (item.kind !== "comp") continue;
      for (let i = 0; i < sweep; i++) plan(item, (item.duration * i) / sweep, `${item.name}@${((item.duration * i) / sweep).toFixed(3)}s`);
    }
    continue;
  }
  for (const { comp: name, frames, fps = 24 } of suite.comps) {
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name);
    if (!comp) continue;
    for (const frame of frames) plan(comp, frame / fps, `${name}@${frame}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "aep-parity-"));
writeFileSync(join(dir, "jobs.tsv"), jobs.map((j) => `${j.project}\t${j.compId}\t${j.time}\t${scale}\n`).join(""));
let native: { parseMs: number; planMs: number; projects: number } = { parseMs: 0, planMs: 0, projects: 0 };
try {
  const out = execFileSync(tool, [...(expressions ? ["--expressions"] : []), join(dir, "jobs.tsv"), dir], { encoding: "utf8", maxBuffer: 1 << 26 });
  native = JSON.parse(out.trim().split("\n").at(-1)!);
} catch (e: any) {
  const lines = String(e.stdout ?? "").trim().split("\n");
  console.log(lines.slice(0, -1).join("\n"));
  native = JSON.parse(lines.at(-1) || "{}");
}

/** The first place `a` and `b` differ, as a path, or "" when they match within float tolerance. */
function difference(a: unknown, b: unknown, path: string): string {
  if (typeof a === "number" && typeof b === "number") {
    if (Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b))) return "";
    return Math.abs(a - b) <= 1e-3 + 1e-4 * Math.max(Math.abs(a), Math.abs(b)) ? "" : `${path}: ${a} vs ${b}`;
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) return difference(Array.from(a as any), Array.from(b as any), path);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: ${a.length} items vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = difference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return "";
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = difference((a as any)[key], (b as any)[key], `${path}.${key}`);
      if (d) return d;
    }
    return "";
  }
  return a === b ? "" : `${path}: ${String(a)} vs ${String(b)}`;
}

let same = 0;
let compared = 0;
let plansMatched = 0;
const failures: string[] = [];
jobs.forEach((job, i) => {
  const unsupported = readFileSync(join(dir, `${i}.txt`), "utf8").split("\n").filter(Boolean);
  const want = [...new Set(job.unsupported)].sort().join(" | ");
  const got = [...new Set(unsupported)].sort().join(" | ");
  if (want !== got) {
    failures.push(`${job.label}: unsupported\n    ts:  ${want || "(none)"}\n    c++: ${got || "(none)"}`);
    return;
  }
  if (!job.plan) {
    same++;
    return;
  }
  compared++;
  const bytes = new Uint8Array(readFileSync(join(dir, `${i}.aevp`)));
  const d = difference(decodePlan(job.plan), decodePlan(bytes), "plan");
  if (d) failures.push(`${job.label}: ${d}`);
  else {
    same++;
    plansMatched++;
  }
});
rmSync(dir, { recursive: true, force: true });

for (const f of failures.slice(0, verbose ? failures.length : 20)) console.log(f);
if (!verbose && failures.length > 20) console.log(`... ${failures.length - 20} more (--verbose lists them all)`);
const frames = jobs.length || 1;
console.log(
  `${same}/${jobs.length} frames match: ${plansMatched}/${compared} complete plans field by field, ` +
    `${same - plansMatched}/${jobs.length - compared} others on what neither side can render`,
);
console.log(
  `parse: TypeScript ${(tsParseMs / Math.max(projects, 1)).toFixed(2)} ms a project, C++ ${(native.parseMs / Math.max(native.projects, 1)).toFixed(2)} ms` +
    ` | plan: TypeScript ${(tsPlanMs / frames).toFixed(3)} ms a frame, C++ ${(native.planMs / frames).toFixed(3)} ms`,
);
if (args.includes("--require") && failures.length) process.exit(1);
