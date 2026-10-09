// Renders a composition to MP4 through the app's Render Queue (headless Edge, real
// GPU): opens the project and comp, Ctrl+M, picks the quality, Render, and saves the
// download. Prints the render time and the file's streams (ffprobe).
//
//   node scripts/check-render-ui.ts <project.aep> <comp> [fast|good|high] [seconds of work area] [http://localhost:5173]
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { chromium } from "playwright-core";

const [path, compName, quality = "good", seconds = "", base = "http://localhost:5173"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(base);
// The save picker would need a real click; force the download path.
await page.evaluate(() => {
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
await page.waitForTimeout(3000);
for (let guard = 0; guard < 200; guard++) {
  const closed = page.locator(".proj-row .twirl:not(.open)");
  if (!(await closed.count())) break;
  await closed.first().click();
}
await page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${compName}$`) }) }).first().dblclick();
await page.waitForTimeout(1500);
if (seconds) {
  // Work area: B at 0, then N after moving `seconds` forward (PageDown steps one frame, Shift+PageDown ten).
  await page.locator(".comp-viewer, canvas").first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press("Home");
  await page.keyboard.press("b");
  const fps = Number(await page.evaluate(() => (document.querySelector(".tl-fps")?.textContent ?? "").match(/[\d.]+/)?.[0] ?? "0")) || 60;
  for (let i = 0; i < Math.round(Number(seconds) * fps / 10); i++) await page.keyboard.press("Shift+PageDown");
  await page.keyboard.press("n");
}
await page.keyboard.press("Control+m");
await page.waitForTimeout(500);
await page.locator(".rq-field", { hasText: "Quality" }).locator("select").first().selectOption(quality);
const started = Date.now();
const download = page.waitForEvent("download", { timeout: 30 * 60_000 });
await page.getByRole("button", { name: "Render", exact: true }).click();
let last = "";
const ticker = setInterval(async () => {
  const text = await page.locator(".rq-progress").innerText().catch(() => "");
  if (text && text !== last) console.log("  ", (last = text));
}, 3000);
const file = await download;
clearInterval(ticker);
const out = `refs/probe-render-${quality}.mp4`;
await file.saveAs(out);
const seconds_ = (Date.now() - started) / 1000;
console.log(`rendered ${out} (${(statSync(out).size / 1048576).toFixed(2)} MB) in ${seconds_.toFixed(1)} s`);
console.log("status:", (await page.locator(".rq-status").allInnerTexts()).join(" | "));
console.log("perf:", (await page.locator(".rq-perf").allInnerTexts()).join(" | "));
console.log("perf:", (await page.locator(".rq-perf").allInnerTexts()).join(" | "));
await browser.close();
try {
  console.log(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames,sample_rate,bit_rate:format=duration", "-of", "compact", out], { encoding: "utf8" }));
} catch (e) {
  console.log("ffprobe failed:", (e as Error).message);
}
