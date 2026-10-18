// Times a whole Render Queue item (render, encode and mux, the file kept in memory) of a project's comp in headless
// Edge, as the app renders it: ms per frame and the queue's account of where the time went.
//
//   node scripts/bench-render-queue.ts <project.aep> <comp> [start seconds=0] [seconds=2] [--quality fast|good|high]
//     [--format h264|vp9|png] [--software-h264] [--swiftshader] [--discrete] [--cpu-throttle n] [--mobile] [--minify]
//     [--require-ms n]
//
// --minify builds the page minified, as the production bundle is.
// --software-h264 reports no WebCodecs H.264 encoder, as Android's WebView on phones without one, so the export takes
// the WebAssembly encoder. --cpu-throttle slows the page's main thread n times (a phone runs JavaScript 4 to 6 times
// slower than a desktop; workers keep their speed). --mobile gives the page an Android phone's user agent, so the app
// keeps to a phone's memory budgets. --require-ms prints BENCH-PASSED when the item is Done at n ms a frame or less.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build } from "vite";
import { parseProject } from "../src/aep/parse.ts";
import { resolveFootage } from "../server/local-footage.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const valued = new Set(["--quality", "--format", "--cpu-throttle", "--require-ms"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const [path, compName, start = "0", seconds = "2"] = positional;
if (!path || !compName) throw new Error("usage: bench-render-queue.ts <project.aep> <comp> [start] [seconds] [options]");

const outDir = resolve("dist-tools/export-harness");
await build({
  root: resolve("."),
  configFile: false,
  logLevel: "error",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { outDir, emptyOutDir: true, minify: args.includes("--minify") ? "esbuild" : false, lib: { entry: resolve("scripts/export/export-entry.ts"), name: "AepExport", formats: ["iife"], fileName: () => "export.js" } },
});
const harnessJs = readFileSync(join(outDir, "export.js"));
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url?.startsWith("/upload/")) {
    req.resume();
    req.on("end", () => res.writeHead(204).end());
    return;
  }
  if (req.url === "/export.js") res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(harnessJs);
  else res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><html><body><script src="/export.js"></script></body></html>');
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

const gpuArgs = args.includes("--swiftshader")
  ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  : ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", ...(args.includes("--discrete") ? ["--force-high-performance-gpu"] : [])];
const browser = await chromium.launch({ channel: "msedge", headless: true, args: gpuArgs });
const context = await browser.newContext(
  args.includes("--mobile")
    ? { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36", hasTouch: true }
    : {},
);
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
if (args.includes("--software-h264")) {
  await page.addInitScript(() => {
    const supported = VideoEncoder.isConfigSupported.bind(VideoEncoder);
    VideoEncoder.isConfigSupported = async (config) => (config.codec.startsWith("avc1") ? { supported: false, config } : supported(config));
  });
}
await page.goto(`http://127.0.0.1:${port}/`);
const throttle = Number(opt("--cpu-throttle") ?? 1);
if (throttle > 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: throttle });
const call = <T>(fn: string, ...params: unknown[]): Promise<T> =>
  page.evaluate(([f, p]) => (globalThis as any).aepExport[f as string](...(p as unknown[])), [fn, params] as const) as Promise<T>;

const bytes = readFileSync(path);
await call("load", bytes.toString("base64"));
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
for (const item of project.items.values()) {
  if (item.kind !== "footage" || item.mainSource.sourceType !== "FileSource") continue;
  const file = await resolveFootage(item.mainSource.file);
  if (file) await call("addFile", item.mainSource.file, readFileSync(file).toString("base64"));
}

const settings = { resolution: 1, timeSpan: "custom", customStart: Number(start), customDuration: Number(seconds), frameRate: null };
const output = { format: opt("--format") ?? "h264", channels: "rgb", bitrate: null, audio: "auto", quality: opt("--quality") ?? "good" };
const result = await call<{ status: string; error?: string; frames: number; ms: number; bytes: number; perf: string | null; log: string[] }>(
  "exportItem",
  "bench",
  compName,
  settings,
  output,
);
const options = [output.format, output.quality, args.includes("--software-h264") && "WebAssembly H.264", throttle > 1 && `CPU ${throttle}x slower`, args.includes("--mobile") && "phone budgets"].filter(Boolean).join(", ");
const perFrame = result.ms / Math.max(1, result.frames);
console.log(`${compName} (${options}): ${result.status}${result.error ? ` (${result.error})` : ""}, ${result.frames} frames in ${(result.ms / 1000).toFixed(1)} s = ${perFrame.toFixed(1)} ms per frame, ${(result.bytes / 1e6).toFixed(2)} MB`);
if (result.perf) console.log(`  ${result.perf}`);
for (const line of result.log) console.log(`  warning: ${line}`);
await browser.close();
server.close();
const required = opt("--require-ms");
if (required !== undefined) {
  const passed = result.status === "Done" && perFrame <= Number(required);
  console.log(passed ? "BENCH-PASSED" : `BENCH-FAILED: ${perFrame.toFixed(1)} ms per frame, at most ${required} required`);
  process.exitCode = passed ? 0 : 1;
}
