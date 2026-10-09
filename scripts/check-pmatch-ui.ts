// Drives Extra > Particle Match in the running app (headless Edge, real GPU): picks the
// reference video, trains on a window, plays the preview and saves a screenshot.
//   node scripts/check-pmatch-ui.ts [app url] [--from 50] [--to 80]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { PMATCH_OUT, REFERENCE } from "./lib/pmatch-browser.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = args.find((a) => /^https?:/.test(a)) ?? "http://localhost:5173/";
const from = option("from", "50");
const to = option("to", "80");

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
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
    const status = await dialog.getByRole("status").innerText().catch(() => "");
    if (status && status !== last) console.log(`${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s  ${(last = status)}`);
    if (Date.now() - started > 600_000) throw new Error("training took over 10 minutes");
    await page.waitForTimeout(1000);
  }
  console.log(`trained in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(await dialog.locator(".pm-report").innerText());
  await dialog.locator("video").evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  await page.waitForTimeout(3000);
  const out = join(PMATCH_OUT, "ui");
  mkdirSync(out, { recursive: true });
  await dialog.screenshot({ path: join(out, "dialog.png") });
  console.log(`screenshot: ${join(out, "dialog.png")}`);
} finally {
  await browser.close();
}
if (errors.length) {
  console.log(`page errors:\n${errors.join("\n")}`);
  process.exit(1);
}
