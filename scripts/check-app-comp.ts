// Opens a project in the running dev server's app (headless Edge, real GPU), opens a
// composition by name at a time, and prints the render notes plus a screenshot path.
//
//   node scripts/check-app-comp.ts <project.aep> <comp name> [seconds=5] [http://localhost:5173]
import { chromium } from "playwright-core";

const [path, compName, seconds = "5", base = "http://localhost:5173"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.log(`console ${m.type()}:`, m.text().slice(0, 300)));
await page.goto(base);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
await page.waitForTimeout(3000);
// The comp may sit in a closed folder: expand folders until none is closed.
for (let pass = 0; pass < 6; pass++) {
  const closed = page.locator(".proj-row .twirl:not(.open)");
  if (!(await closed.count())) break;
  await closed.first().click();
  pass--;
  if (pass < -200) break;
}
await page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${compName}$`) }) }).first().dblclick();
await page.waitForTimeout(1000);
// Move the playhead: type the time into the timeline timecode field if present, else press PageDown frames.
const fps = 60;
for (let i = 0; i < Math.round(Number(seconds) * fps) && i < 600; i += 10) await page.keyboard.press("Shift+PageDown");
await page.waitForTimeout(15000);
const notes = (await page.locator(".render-notes").allInnerTexts()).join(" | ") || "(no notes)";
console.log("render notes:", notes);
const out = `refs/probe-comp-${compName.replace(/\W+/g, "_")}.png`;
await page.screenshot({ path: out });
console.log("screenshot:", out);
await browser.close();
