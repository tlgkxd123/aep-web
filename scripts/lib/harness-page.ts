// Opens the pixel harness (dist-harness/harness.js) in headless Edge on the machine's GPU with a project loaded
// and its footage located on disk like the dev server does, for scripts that render a user's project.
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { parseProject } from "../../src/aep/parse.ts";
import { resolveFootage } from "../../server/local-footage.ts";

export interface HarnessPage {
  browser: Browser;
  page: Page;
}

/** `discrete` runs on the high-performance GPU of a dual-GPU machine; `build` rebuilds the harness first. */
export async function openHarness(path: string, options: { discrete?: boolean; build?: boolean } = {}): Promise<HarnessPage> {
  if (options.build !== false) execSync("npx vite build -c vite.harness.config.ts --logLevel error", { stdio: "inherit" });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", ...(options.discrete ? ["--force-high-performance-gpu"] : [])],
  });
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
  // WebCodecs (movie decoding, as in the app) is only exposed to secure contexts, so the page gets an https origin.
  const origin = "https://aep-harness.test/";
  await page.route(`${origin}**`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
  await page.goto(origin);
  await page.addScriptTag({ path: resolve("dist-harness/harness.js") });
  const bytes = readFileSync(path);
  await page.evaluate((b64) => (globalThis as any).aepHarness.load(b64), bytes.toString("base64"));
  const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  for (const item of project.items.values()) {
    if (item.kind !== "footage" || item.mainSource.sourceType !== "FileSource") continue;
    const file = await resolveFootage(item.mainSource.file);
    if (!file || statSync(file).size > 300e6) continue;
    await page.evaluate(([p, b64]) => (globalThis as any).aepHarness.addFile(p, b64), [item.mainSource.file, readFileSync(file).toString("base64")] as const);
  }
  return { browser, page };
}
