// Probe: what the Timeline's keyframes do when clicked, dragged, deleted and copied.
//   node scripts/probe-keyframe-ui.ts [http://localhost:5173]
import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { SAMPLES } from "./lib/paths.ts";

const [base = "http://localhost:5173"] = process.argv.slice(2);
const sample = resolve(SAMPLES, "models/property/keyframe_BEZIER.aep");
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
const step = (t: string) => console.log(`- ${t}`);

await page.goto(base);
await page.locator('input[type="file"][accept*=".aep"]').setInputFiles(sample);
await page.waitForTimeout(3000);
const timeline = page.locator('[role="tree"]').filter({ has: page.locator(".tl-row") }).first();
await timeline.locator(".tl-row .twirl").first().click();
await page.getByRole("button", { name: "Expand Transform" }).first().click();
await page.waitForTimeout(300);

const position = page.locator('[role="treeitem"][aria-label="Position"]').first();
const kfs = position.locator(".tl-kf");
step(`keyframes on Position: ${await kfs.count()}`);
const track = (await position.locator(".tl-track").boundingBox())!;
step(`track box: ${JSON.stringify(track)}`);
const boxes: { x: number; y: number; width: number; height: number }[] = [];
for (let i = 0; i < (await kfs.count()); i++) boxes.push((await kfs.nth(i).boundingBox())!);
step(`kf boxes: ${JSON.stringify(boxes)}`);

/** Clicks a keyframe at a point inset from its centre, away from the panel splitter. */
async function clickKf(i: number, dx = 4) {
  const b = boxes[i];
  await page.mouse.click(b.x + b.width / 2 + dx, b.y + b.height / 2);
  await page.waitForTimeout(150);
}

await clickKf(1);
step(`after clicking kf1, selected: ${await position.locator(".tl-kf.selected").count()}`);
step(`activeElement: ${await page.evaluate(() => `${(document.activeElement as HTMLElement)?.tagName}.${(document.activeElement as HTMLElement)?.className}`)}`);

// Drag kf1 right by 120 px.
const mid = { x: boxes[1].x + boxes[1].width / 2 + 4, y: boxes[1].y + boxes[1].height / 2 };
await page.mouse.move(mid.x, mid.y);
await page.mouse.down();
for (let s = 1; s <= 10; s++) await page.mouse.move(mid.x + 12 * s, mid.y);
await page.mouse.up();
await page.waitForTimeout(300);
step(`after drag, kf titles: ${JSON.stringify(await kfs.evaluateAll((els) => els.map((e) => (e as HTMLElement).title)))}`);

await page.keyboard.press("Delete");
await page.waitForTimeout(300);
step(`after Delete, keyframes: ${await position.locator(".tl-kf").count()}`);
await page.keyboard.press("Control+c");
await page.keyboard.press("Control+v");
await page.waitForTimeout(300);
step(`after Ctrl+C/Ctrl+V, keyframes: ${await position.locator(".tl-kf").count()}`);

// Right-click a keyframe: does AE's keyframe menu appear?
const left = await kfs.count();
if (left) {
  const b = (await kfs.first().boundingBox())!;
  await page.mouse.click(b.x + b.width / 2 + 4, b.y + b.height / 2, { button: "right" });
  await page.waitForTimeout(300);
  step(`right-click menu: ${JSON.stringify(await page.locator(".context-menu").allInnerTexts())}`);
  await page.keyboard.press("Escape");
}

await page.screenshot({ path: "refs/probe/keyframe-ui.png", clip: { x: 0, y: 520, width: 1400, height: 400 } });
step("screenshot: refs/probe/keyframe-ui.png");
await browser.close();
