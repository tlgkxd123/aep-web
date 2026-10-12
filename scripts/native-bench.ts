// Times a native frame stage by stage at full HD: on the page (building the plan, encoding it, the base64 the plugin
// bridge carries) and in the engine (reading the plan, recording, the GPU's work, reading the frame back). The core
// fixture comps are planned at about 1920 pixels wide, so their shapes, masks and feathers rasterize at that size, and
// a 1920x1080 comp nests the first STACKED of them.
//
//   cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build --config Release
//   node scripts/native-bench.ts [--runs n] [--only comp,comp] [--engine path] [--json file]
//
// Any Vulkan device does; AEVK_DEVICE=<part of its name> picks one (Intel, llvmpipe...). Prints median milliseconds.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompItem, Project } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import "../src/expressions/install.ts";
import { toBase64 } from "../src/native/engine.ts";
import { buildFramePlan, type FramePlan, type PlanLayer } from "../src/native/plan.ts";
import { encodePlan } from "../src/native/wire.ts";
import { PAD } from "../src/render/composition.ts";
import { findRenderTool } from "./lib/native.ts";
import { loadSuites, ROOT } from "./lib/suites.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUNS = Number(option("--runs") ?? 9);
const WIDTH = 1920;
const STACKED = 16;
const only = option("--only") ? new Set(option("--only")!.split(",")) : undefined;
const tool = findRenderTool(option("--engine"));
if (!tool) {
  console.log("the native renderer is not built: cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build --config Release");
  process.exit(1);
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;
function time(run: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i <= RUNS; i++) {
    const start = performance.now();
    run();
    if (i > 0) samples.push(performance.now() - start);
  }
  return median(samples);
}

type Page = { planMs: number; encodeMs: number; base64Ms: number };
type Bench = { name: string; plan: string; page: Page };
const work = mkdtempSync(join(tmpdir(), "aevk-bench-"));
const benches: Bench[] = [];
const nested: { comp: CompItem; plan: FramePlan; scale: number }[] = [];

const [core] = loadSuites("fixtures");
const project: Project = parseProject(new Uint8Array(readFileSync(join(ROOT, "fixtures", core.project))));
for (const { comp: name, frames, fps = 24 } of core.comps) {
  if (only && !only.has(name)) continue;
  const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name);
  if (!comp) continue;
  const time0 = frames[frames.length - 1] / fps;
  const scale = WIDTH / comp.width;
  let plan = buildFramePlan(project, comp, time0, { scale });
  if (plan.unsupported.length) continue;
  const planMs = time(() => (plan = buildFramePlan(project, comp, time0, { scale })));
  let bytes = encodePlan(plan);
  const encodeMs = time(() => (bytes = encodePlan(plan)));
  const base64Ms = time(() => toBase64(bytes));
  const file = join(work, `${benches.length}.aevp`);
  writeFileSync(file, bytes);
  benches.push({ name, plan: file, page: { planMs, encodeMs, base64Ms } });
  if (nested.length < STACKED) nested.push({ comp, plan, scale });
}

// The stack: each comp nested full height in a 1920x1080 comp, a little transparent, over a solid.
if (!only && nested.length) {
  const layers: PlanLayer[] = [
    {
      name: "background",
      adjustment: false,
      blendMode: 5212,
      opacity: 1,
      content: { kind: "solid", width: WIDTH, height: 1080, origin: [0, 0], scale: 1, color: [0.1, 0.12, 0.15] },
      masks: [],
      matrix: [1, 0, 0, PAD, 0, 1, 0, PAD, 0, 0, 1, 0, 0, 0, 0, 1],
      zoom: 0,
    },
  ];
  for (const { comp, plan, scale } of nested) {
    const fit = 1080 / comp.height;
    layers.push({
      name: comp.name,
      adjustment: false,
      blendMode: 5212,
      opacity: 0.85,
      content: { kind: "comp", width: plan.root.width, height: plan.root.height, origin: [0, 0], scale, comp: plan.root },
      masks: [],
      matrix: [fit, 0, 0, PAD + (WIDTH - comp.width * fit) / 2, 0, fit, 0, PAD, 0, 0, 1, 0, 0, 0, 0, 1],
      zoom: 0,
    });
  }
  const stack = { root: { width: WIDTH, height: 1080, layers }, images: [] };
  const bytes = encodePlan(stack);
  const file = join(work, "stack.aevp");
  writeFileSync(file, bytes);
  const page = benches.filter((b) => nested.some((n) => n.comp.name === b.name)).map((b) => b.page);
  const sum = (key: keyof Page) => page.reduce((s, p) => s + p[key], 0);
  benches.push({ name: `stack of ${nested.length}`, plan: file, page: { planMs: sum("planMs"), encodeMs: time(() => encodePlan(stack)), base64Ms: time(() => toBase64(bytes)) } });
}

type Engine = { width: number; height: number; bytes: number; decodeMs: number; recordMs: number; gpuMs: number; renderMs: number; readMs: number; error?: string };
let stdout = "";
try {
  stdout = execFileSync(tool, ["--info", "--bench", String(RUNS), ...benches.map((b) => b.plan)], { encoding: "utf8", maxBuffer: 1 << 26 });
} catch (error) {
  stdout = String((error as { stdout?: string }).stdout ?? "");
}
rmSync(work, { recursive: true, force: true });
let device = "";
const engine = new Map<string, Engine>();
for (const line of stdout.split("\n").filter(Boolean)) {
  const entry = JSON.parse(line);
  if (entry.device) device = `${entry.device} (Vulkan ${entry.apiVersion})`;
  else if (entry.plan) engine.set(entry.plan, entry);
  else if (entry.error) throw new Error(`the engine could not start: ${entry.error}`);
}

const f = (ms: number) => ms.toFixed(2).padStart(7);
console.log(`device: ${device}, median of ${RUNS} runs, ms`);
console.log(`${"comp".padEnd(36)} ${"size".padEnd(9)} ${"plan".padStart(7)} ${"encode".padStart(7)} ${"base64".padStart(7)} ${"decode".padStart(7)} ${"record".padStart(7)} ${"gpu".padStart(7)} ${"read".padStart(7)} ${"total".padStart(7)}`);
const rows: Record<string, unknown>[] = [];
for (const b of benches) {
  const e = engine.get(b.plan);
  if (!e || e.error) {
    console.log(`${b.name.padEnd(36)} ERROR ${e?.error ?? "no result"}`);
    continue;
  }
  const total = b.page.planMs + b.page.encodeMs + b.page.base64Ms + e.decodeMs + e.renderMs + e.readMs;
  console.log(
    `${b.name.padEnd(36)} ${`${e.width}x${e.height}`.padEnd(9)} ${f(b.page.planMs)} ${f(b.page.encodeMs)} ${f(b.page.base64Ms)} ${f(e.decodeMs)} ${f(e.recordMs)} ${f(e.gpuMs)} ${f(e.readMs)} ${f(total)}`,
  );
  rows.push({ name: b.name, ...b.page, ...e, plan: undefined, totalMs: total });
}
const jsonOut = option("--json");
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ device, runs: RUNS, rows }, null, 2));
