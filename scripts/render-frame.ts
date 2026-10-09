// Renders frames of a project's composition with the pixel harness (headless Edge, the machine's GPU)
// and writes them as PNGs, for looking at effects without After Effects references. Footage is
// located on disk like the dev server does.
//
//   node scripts/render-frame.ts <project.aep> <comp> <seconds,seconds> <out prefix> [--sapphire] [--no-build]
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { parseProject } from "../src/aep/parse.ts";
import { resolveFootage } from "../server/local-footage.ts";
import { encodePng } from "./lib/png.ts";

const args = process.argv.slice(2);
const [path, compName, timesArg, prefix] = args;
if (!args.includes("--no-build")) execSync("npx vite build -c vite.harness.config.ts --logLevel error", { stdio: "inherit" });
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
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
mkdirSync(dirname(prefix), { recursive: true });
for (const time of timesArg.split(",").map(Number)) {
  const started = Date.now();
  const result = (await page.evaluate(([c, t]) => (globalThis as any).aepHarness.render(c, t), [compName, time] as const)) as {
    width: number;
    height: number;
    pixels: string;
    warnings: string[];
  };
  const out = `${prefix}_${time}.png`;
  writeFileSync(out, encodePng(result.width, result.height, new Uint8Array(Buffer.from(result.pixels, "base64"))));
  console.log(`${out} (${Date.now() - started} ms with footage): ${result.warnings.join(" | ")}`);
}
await browser.close();
