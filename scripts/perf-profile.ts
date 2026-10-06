// CPU-profiles the viewer path on one comp in headless Edge (hardware GPU) and
// prints the functions with the most self time. Run scripts/perf-report.ts
// first: it builds dist-tools/perf-current/perf.js.
//   node scripts/perf-profile.ts <file.aep> <comp> [--frames 12] [--swiftshader]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { parseProject } from "../src/aep/parse.ts";

const [file, compName] = process.argv.slice(2);
if (!file || !compName) throw new Error("usage: node scripts/perf-profile.ts <file.aep> <comp> [--frames N]");
const args = process.argv.slice(2);
const frames = Number(args.includes("--frames") ? args[args.indexOf("--frames") + 1] : 12);
const bytes = readFileSync(file);
const project = parseProject(new Uint8Array(bytes));
const comp = [...project.items.values()].find((i) => i.kind === "comp" && i.name === compName);
if (!comp || comp.kind !== "comp") throw new Error(`no comp ${compName}`);
const times = Array.from({ length: frames }, (_, i) => comp.workAreaStart + i * comp.frameDuration);

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: args.includes("--swiftshader") ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : [],
});
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: resolve("dist-tools/perf-current/perf.js") });
await page.evaluate((b) => (globalThis as any).aepPerf.load(b), bytes.toString("base64"));
await page.evaluate(([c, t]) => (globalThis as any).aepPerf.time(c, t), [compName, [times[0]]] as const);
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
const r = await page.evaluate(([c, t]) => (globalThis as any).aepPerf.time(c, t), [compName, times] as const);
const { profile } = (await cdp.send("Profiler.stop")) as { profile: any };
await browser.close();

const self = new Map<string, number>();
const dt: number[] = profile.timeDeltas;
const byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
const counts = new Map<number, number>();
profile.samples.forEach((id: number, i: number) => counts.set(id, (counts.get(id) ?? 0) + (dt[i] ?? 0)));
for (const [id, us] of counts) {
  const n = byId.get(id);
  const f = n.callFrame;
  const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + us);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`${compName}: ${frames} frames, mean ${(r.ms.reduce((a: number, b: number) => a + b, 0) / frames).toFixed(1)} ms; profile ${(total / 1000).toFixed(0)} ms`);
for (const [k, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`${((us / total) * 100).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(6)} ms  ${k}`);
}
