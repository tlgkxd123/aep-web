// Checks in the running dev server's app (headless Edge) that View > Render Sapphire effects
// switches the viewer between the look-alikes and skipping them, and that the setting sticks.
//
//   node scripts/check-sapphire-toggle.ts <project.aep> <comp> <timecode> [http://localhost:5173]
import { chromium } from "playwright-core";

const [path, compName, timecode, base = "http://localhost:5173"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(base);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(1000);
  if (i > 5 && (await page.evaluate(() => !!(window as any).aepFootage && !(window as any).aepFootage.busy))) break;
}
for (let guard = 0; guard < 300; guard++) {
  const closed = page.locator(".proj-row .twirl:not(.open)");
  if (!(await closed.count())) break;
  await closed.first().click();
}
await page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${compName}$`) }) }).first().dblclick();
await page.waitForTimeout(1000);
await page.locator(".tl-timecode").first().click();
await page.locator(".tl-timecode-input").fill(timecode);
await page.keyboard.press("Enter");

const notes = async () => {
  await page.waitForTimeout(1500);
  return (await page.locator(".render-notes").allInnerTexts()).join(" ").match(/Sapphire S_\w+[^|.]*/g)?.join(" / ") ?? "(no Sapphire notes)";
};
const menuItem = async () => {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  return page.getByRole("menuitemcheckbox", { name: "Render Sapphire effects" });
};
const report = async (label: string) => {
  const item = await menuItem();
  const checked = await item.getAttribute("aria-checked");
  await page.keyboard.press("Escape");
  console.log(`${label}: menu checked=${checked}; notes: ${await notes()}`);
};

await report("initially");
await (await menuItem()).click();
await report("after toggling");
await page.reload();
console.log(`after reload, stored: ${await page.evaluate(() => localStorage.getItem("aep-web.sapphireLookalikes"))}`);
await page.evaluate(() => localStorage.removeItem("aep-web.sapphireLookalikes"));
await browser.close();
