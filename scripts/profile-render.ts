// Profiles the renderer on a project in headless Edge using the machine's GPU:
// ms per frame and per stage (content by layer kind, masks, each effect,
// placement, compositing). Footage is located on disk like the dev server does.
//
//   node scripts/profile-render.ts <project.aep> [--comps name,name] [--top 5] [--times 1,5] [--swiftshader] [--sapphire]
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { parseProject } from "../src/aep/parse.ts";
import { resolveFootage } from "../server/local-footage.ts";

const args = process.argv.slice(2);
const path = args[0];
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const times = (opt("--times") ?? "1,5").split(",").map(Number);
const top = Number(opt("--top") ?? 5);

if (!args.includes("--no-build")) execSync("npx vite build -c vite.harness.config.ts --logLevel error", { stdio: "inherit" });
const gpuArgs = args.includes("--swiftshader")
  ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  : ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"];
const browser = await chromium.launch({ channel: "msedge", headless: true, args: gpuArgs });
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: resolve("dist-harness/harness.js") });

const bytes = readFileSync(path);
await page.evaluate((b64) => (globalThis as any).aepHarness.load(b64), bytes.toString("base64"));
if (args.includes("--sapphire")) await page.evaluate(() => (globalThis as any).aepHarness.setOptions({ sapphireLookalikes: true }));

const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
let footageBytes = 0;
for (const item of project.items.values()) {
  if (item.kind !== "footage" || item.mainSource.sourceType !== "FileSource") continue;
  const file = await resolveFootage(item.mainSource.file);
  if (!file || footageBytes + statSync(file).size > 600e6) continue;
  footageBytes += statSync(file).size;
  await page.evaluate(([p, b64]) => (globalThis as any).aepHarness.addFile(p, b64), [item.mainSource.file, readFileSync(file).toString("base64")] as const);
}
console.log(`footage injected: ${(footageBytes / 1e6).toFixed(1)} MB`);

const comps = (await page.evaluate(() => (globalThis as any).aepHarness.comps())) as [string, number, number, number][];
const wanted = opt("--comps")?.split(",") ?? [...comps].sort((a, b) => b[1] - a[1]).slice(0, top).map((c) => c[0]);
const cdp = args.includes("--cpu") ? await page.context().newCDPSession(page) : undefined;
if (cdp) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
}

interface CpuNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
}

for (const name of wanted) {
  const [, layers, w, h] = comps.find((c) => c[0] === name) ?? [name, 0, 0, 0];
  if (cdp) {
    // Warm the footage first so the CPU profile covers rendering only.
    await page.evaluate(([c, t]) => (globalThis as any).aepHarness.profile(c, t), [name, times] as const);
    await cdp.send("Profiler.start");
  }
  const result = (await page.evaluate(([c, t]) => (globalThis as any).aepHarness.profile(c, t), [name, times] as const)) as {
    frameMs: number[];
    warmMs: number[];
    coldMs: number[];
    stages: [string, number, number][];
    gpu: string;
  };
  console.log(`\n${name}: waiting for footage at t=${times.join(",")}: ${result.warmMs.map((m) => m.toFixed(0)).join(", ")} ms`);
  if (cdp) {
    const { profile } = (await cdp.send("Profiler.stop")) as unknown as { profile: { nodes: CpuNode[]; samples: number[]; timeDeltas: number[] } };
    const selfMs = new Map<string, number>();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => {
      const frame = byId.get(id)!.callFrame;
      const key = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").pop()}:${frame.lineNumber + 1}`;
      selfMs.set(key, (selfMs.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
    });
    const total = [...selfMs.values()].reduce((a, b) => a + b, 0);
    console.log(`\n-- CPU self time for ${name} (${total.toFixed(0)} ms sampled over ${times.length * 2} renders)`);
    for (const [fn, ms] of [...selfMs].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`  ${ms.toFixed(1).padStart(8)} ms  ${fn}`);
  }
  console.log(`\n== ${name} (${w}x${h}, ${layers} layers) on ${result.gpu}`);
  console.log(`frame ms at t=${times.join(",")}: ${result.frameMs.map((m) => m.toFixed(1)).join(", ")}`);
  console.log(`first complete render ms (footage uploads included): ${result.coldMs.map((m) => m.toFixed(1)).join(", ")}`);
  for (const [stage, ms, count] of result.stages.slice(0, 14)) console.log(`  ${ms.toFixed(1).padStart(8)} ms  ${count.toFixed(0).padStart(4)}x  ${stage}`);
}
await browser.close();
