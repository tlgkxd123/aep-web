// Opens compositions in the running dev server's app (headless Edge, real GPU), parks the playhead
// at several times (paused, as when scrubbing), and reports any frame whose footage is still
// "loading" after a few seconds: the viewer must always settle.
//
//   node scripts/check-footage-settles.ts <project.aep> <comp,comp,...> [settle ms=3000] [http://localhost:5173]
import { chromium } from "playwright-core";

const [path, compsArg, settleArg = "3000", base = "http://localhost:5173"] = process.argv.slice(2);
const settle = Number(settleArg);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(base);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(1000);
  const ready = await page.evaluate(() => {
    const store = (window as any).aepFootage;
    return !!store && store.size > 0 && !store.busy;
  });
  if (ready && i > 5) break;
}
for (let pass = 0; pass < 300; pass++) {
  const closed = page.locator(".proj-row .twirl:not(.open)");
  if (!(await closed.count())) break;
  await closed.first().click();
}
const notes = async () => (await page.locator(".render-notes").allInnerTexts()).join(" | ");
let stuck = 0;
for (const name of compsArg.split(",")) {
  await page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${name}$`) }) }).first().dblclick();
  await page.waitForTimeout(1500);
  // A few seconds of playback first, as before scrubbing around a playing comp.
  await page.keyboard.press("Space");
  await page.waitForTimeout(4000);
  await page.keyboard.press("Space");
  const decoders = await page.evaluate(() => JSON.stringify((window as any).aepFootage.stats.decoder));
  console.log(`${name}: played 4 s; decoder counters ${decoders}`);
  // Frame steps of different sizes: forwards, a jump, then backwards.
  const moves: [string, number][] = [["PageDown", 1], ["PageDown", 1], ["Shift+PageDown", 3], ["PageDown", 2], ["Shift+PageUp", 2], ["PageUp", 1], ["Shift+PageDown", 8]];
  for (const [key, times] of moves) {
    for (let i = 0; i < times; i++) await page.keyboard.press(key);
    await page.waitForTimeout(settle);
    const at = (await page.locator(".comp-svg").getAttribute("aria-label"))?.split(" at ").pop();
    const text = await notes();
    const loading = /loading/.test(text);
    if (loading) stuck++;
    console.log(`${name} @ ${at}: ${loading ? "STILL LOADING " + (text.match(/footage is loading \([^)]*\)/g) ?? []).join(", ") : "settled"}`);
  }
}
console.log(`${stuck} parked frames still loading after ${settle} ms`);
await browser.close();
