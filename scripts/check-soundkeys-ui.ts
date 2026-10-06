// Opens a project in the running app, selects the Sound Keys layer of a comp,
// clicks Apply in Effect Controls and reports the status line and the keyframes
// the Timeline then shows for Output 1.
//
//   node scripts/check-soundkeys-ui.ts <project.aep> <comp> <sound keys layer> [http://localhost:5173]
import { chromium } from "playwright-core";

const [path, compName, layerName, base = "http://localhost:5173"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(base);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
await page.waitForTimeout(3000);
for (let guard = 0; guard < 200; guard++) {
  const closed = page.locator(".proj-row .twirl:not(.open)");
  if (!(await closed.count())) break;
  await closed.first().click();
}
await page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${compName}$`) }) }).first().dblclick();
await page.waitForTimeout(1500);
await page.locator(".tl-layer", { has: page.locator(".c-name .cell-text", { hasText: new RegExp(`^${layerName}$`) }) }).first().click();
await page.waitForTimeout(500);
await page.getByText(/^Effect Controls/).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: "refs/probe-soundkeys-selected.png" });
console.log("effect controls:", (await page.locator(".ec-path").allInnerTexts()).join(" | ") || "(none)", "| effects:", (await page.locator(".ec-effect-name").allInnerTexts()).join(", "));
const kps = page.getByRole("spinbutton", { name: "Keyframes per Second" });
console.log("Keyframes per Second fields:", await kps.count(), "shows:", await kps.first().innerText().catch(() => "-"));
if (await kps.count()) {
  await kps.first().click();
  const input = page.locator("input.hot-input");
  console.log("text field opened:", await input.count());
  if (await input.count()) {
    await input.fill("30");
    await input.press("Enter");
  }
  await page.waitForTimeout(500);
  console.log("after typing 30:", await kps.first().innerText().catch(() => "-"));
}
const apply = page.getByRole("button", { name: "Apply", exact: true });
console.log("Apply buttons:", await apply.count(), "enabled:", await apply.first().isEnabled().catch(() => false));
if (!(await apply.count())) {
  await browser.close();
  process.exit(1);
}
await apply.first().click();
const status = page.locator(".ec-status");
await status.waitFor({ timeout: 120_000 });
for (let i = 0; i < 240 && /Analysing/.test(await status.innerText()); i++) await page.waitForTimeout(500);
console.log("status:", await status.innerText());
if (process.env.SK_VIEW) {
  // Show the display: switch the layer's video on and move the playhead.
  const row = page.locator(".tl-layer", { has: page.locator(".c-name .cell-text", { hasText: new RegExp(`^${layerName}$`) }) }).first();
  await row.getByRole("button", { name: /^Video/ }).first().click().catch(() => console.log("no video switch"));
  for (let i = 0; i < Number(process.env.SK_VIEW) * 6; i++) await page.keyboard.press("Shift+PageDown");
  await page.waitForTimeout(6000);
  await page.locator(".viewer, .comp-viewer, canvas").first().screenshot({ path: "refs/probe-soundkeys-display.png" }).catch(() => page.screenshot({ path: "refs/probe-soundkeys-display.png" }));
  console.log("render notes:", (await page.locator(".render-notes").allInnerTexts()).join(" | "));
  console.log("display: refs/probe-soundkeys-display.png");
}
const undo = await page.evaluate(() => document.title);
console.log("title:", undo);
await page.screenshot({ path: "refs/probe-soundkeys-apply.png" });
console.log("screenshot: refs/probe-soundkeys-apply.png");
await browser.close();
