// Drives Extra > Particle Match in the running app (headless Edge on the high-performance GPU): picks the
// reference video, analyses a window, trains the PyTorch world model through the dev server's trainer
// (server/pmatch-trainer.ts), plays the preview and saves a screenshot.
//   node scripts/check-pmatch-ui.ts [app url | --serve] [--from 50] [--to 80]
// --serve starts a dev server for the run. Before training it checks that the trainer refuses requests
// without the page's token; the page's own training is the accepted case. Prints PMATCH-UI-PASSED when the
// dialog trained, showed the learned particles on a canvas as large as the reference video and named
// PyTorch and a GPU in its report, with no page errors besides the Effects & Presets library's, which the
// dev server cannot load as a JSON module.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { TRAINER_PATH } from "../src/extra/pmatch/trainer.ts";
import { PMATCH_OUT, REFERENCE } from "./lib/pmatch-browser.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const from = option("from", "50");
const to = option("to", "80");
let server: ViteDevServer | undefined;
let url = args.find((a) => /^https?:/.test(a)) ?? "http://localhost:5173/";
if (args.includes("--serve")) {
  server = await createServer({ configFile: "vite.config.ts", logLevel: "error", server: { port: 5192, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
}

const failures: string[] = [];
for (const [what, path] of [
  ["without a token", TRAINER_PATH],
  ["with a wrong token", `${TRAINER_PATH}?token=wrong`],
]) {
  const response = await fetch(new URL(path, url), { method: "POST", body: new Uint8Array(16) });
  if (response.status !== 403) failures.push(`the trainer answered a request ${what} with ${response.status}, not 403`);
}

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force-high-performance-gpu"] });
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("response", (r) => r.status() >= 400 && !r.url().endsWith("/favicon.ico") && errors.push(`${r.status()} ${r.url()}`));
  await page.goto(url);
  await page.getByRole("menuitem", { name: "Extra" }).click();
  await page.getByRole("menuitem", { name: "Particle Match..." }).click();
  const dialog = page.getByRole("dialog", { name: "Particle Match" });
  await dialog.waitFor();
  await dialog.getByLabel("Reference video").setInputFiles(REFERENCE);
  await dialog.getByLabel("Training start (seconds)").fill(from);
  await dialog.getByLabel("Training end (seconds)").fill(to);
  const started = Date.now();
  await dialog.getByRole("button", { name: "Analyze & Train" }).click();
  let last = "";
  while (!(await dialog.getByRole("button", { name: "Train Again" }).isVisible())) {
    const alert = dialog.getByRole("alert");
    if (await alert.isVisible()) throw new Error(`training failed: ${await alert.innerText()}`);
    const status = await dialog.getByRole("status").innerText({ timeout: 500 }).catch(() => "");
    if (status && status !== last) console.log(`${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s  ${(last = status)}`);
    if (Date.now() - started > 600_000) throw new Error("training took over 10 minutes");
    await page.waitForTimeout(500);
  }
  console.log(`trained in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const report = await dialog.locator(".pm-report").innerText();
  console.log(report);
  if (!/PyTorch \S+ on .*(NVIDIA|GeForce|RTX|Radeon|Arc)/.test(report)) failures.push("the report does not name PyTorch and the GPU it trained on");
  await dialog.locator("video").evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  await page.waitForTimeout(3000);
  const learned = dialog.getByLabel("Learned particles");
  const canvasSize = await learned.evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]);
  const videoSize = await dialog.locator("video").evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight]);
  console.log(`preview canvas ${canvasSize.join("x")}, reference ${videoSize.join("x")}`);
  if (canvasSize[0] !== videoSize[0] || canvasSize[1] !== videoSize[1]) failures.push(`the preview canvas is ${canvasSize.join("x")}, not the reference's ${videoSize.join("x")}`);
  const lit = await learned.evaluate((canvas: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let bright = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 120) bright++;
    return bright;
  });
  console.log(`preview: ${lit} lit pixels`);
  if (lit < 200) failures.push(`the preview shows ${lit} lit pixels, not the learned particles`);
  const out = join(PMATCH_OUT, "ui");
  mkdirSync(out, { recursive: true });
  await dialog.screenshot({ path: join(out, "dialog.png") });
  console.log(`screenshot: ${join(out, "dialog.png")}`);
} finally {
  await browser.close();
  await server?.close();
}
const library = (e: string) => /effect library could not be loaded|effect-library\.json|Expected a JSON module script/.test(e);
if (errors.some(library)) console.log(`not Particle Match's (the effect library's JSON import under the dev server):\n${errors.filter(library).join("\n")}`);
if (errors.some((e) => !library(e))) failures.push(`page errors:\n${errors.filter((e) => !library(e)).join("\n")}`);
if (failures.length) {
  for (const f of failures) console.log(`FAILED: ${f}`);
  process.exit(1);
}
console.log("PMATCH-UI-PASSED");
