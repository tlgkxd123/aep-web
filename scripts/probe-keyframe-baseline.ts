// Probe: the Timeline's keyframe editing baseline, measured precisely.
//   node scripts/probe-keyframe-baseline.ts [http://localhost:5173]
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
const times = () => kfs.evaluateAll((els) => els.map((e) => (e as HTMLElement).title.split(" ·")[0]));
const layers = () => page.locator(".tl-layer").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
const selected = () => position.locator(".tl-kf.selected").count();

const boxes: { x: number; y: number; width: number; height: number }[] = [];
for (let i = 0; i < (await kfs.count()); i++) boxes.push((await kfs.nth(i).boundingBox())!);
/** A point just right of a keyframe's centre, past the outline splitter. */
const spot = (i: number, dx = 6) => ({ x: boxes[i].x + boxes[i].width / 2 + dx, y: boxes[i].y + boxes[i].height / 2 });
const click = async (i: number, dx = 6, mods: string[] = []) => {
  const { x, y } = spot(i, dx);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.click(x, y);
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(150);
};

step(`keyframes: ${JSON.stringify(await times())}`);

// 1. Selection: click, shift-click, and the row's own selection.
await click(0);
step(`1a click kf0 (off centre) -> keyframes selected ${await selected()}, layer rows selected ${await page.locator(".tl-layer.selected").count()}`);
await click(1, 6, ["Shift"]);
step(`1b shift-click kf1 -> keyframes selected ${await selected()}`);
await click(1, 6, ["Shift"]);
step(`1c shift-click kf1 again -> keyframes selected ${await selected()}`);

// 2. Does the splitter cover a keyframe at time 0?
const centre0 = { x: boxes[0].x + boxes[0].width / 2, y: boxes[0].y + boxes[0].height / 2 };
await page.mouse.click(centre0.x, centre0.y);
await page.waitForTimeout(150);
step(`2 click kf0 exactly on its centre -> keyframes selected ${await selected()} (0 = the outline splitter ate it)`);

// 3. Delete.
await click(1);
step(`3a selected before Delete: ${await selected()}`);
await page.keyboard.press("Delete");
await page.waitForTimeout(400);
step(`3b after Delete -> keyframes ${JSON.stringify(await times())}, layers ${JSON.stringify(await layers())}`);
await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
step(`3c after Ctrl+Z -> keyframes ${JSON.stringify(await times())}, layers ${JSON.stringify(await layers())}`);

// 4. Drag.
const from = spot(1);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
for (let s = 1; s <= 10; s++) await page.mouse.move(from.x + 20 * s, from.y);
await page.mouse.up();
await page.waitForTimeout(300);
step(`4 after dragging kf1 right -> keyframes ${JSON.stringify(await times())}`);

// 5. Copy / cut / paste.
await click(1);
await page.keyboard.press("Control+c");
await page.waitForTimeout(150);
await page.keyboard.press("Control+v");
await page.waitForTimeout(400);
step(`5a after Ctrl+C then Ctrl+V -> keyframes ${JSON.stringify(await times())}`);
await page.keyboard.press("Control+x");
await page.waitForTimeout(150);
await page.keyboard.press("Control+v");
await page.waitForTimeout(400);
step(`5b after Ctrl+X then Ctrl+V -> keyframes ${JSON.stringify(await times())}`);

// 6. Right-click a keyframe.
await page.mouse.click(from.x, from.y, { button: "right" });
await page.waitForTimeout(300);
const menu = await page.locator(".context-menu, .sheet").allInnerTexts();
step(`6 right-click on a keyframe -> ${menu.length ? JSON.stringify(menu[0].split("\n").filter(Boolean).slice(0, 8)) : "(no menu)"}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 7. Clicking empty track space clears the selection.
await click(1);
step(`7a selected ${await selected()} before clicking empty space`);
await page.mouse.click(from.x + 500, from.y);
await page.waitForTimeout(200);
step(`7b after clicking empty track space -> keyframes selected ${await selected()}, layers selected ${await page.locator(".tl-layer.selected").count()}`);

// 8. The Animation menu's keyframe commands.
await page.getByRole("menuitem", { name: "Animation" }).click();
await page.waitForTimeout(250);
const anim = await page.locator('[role="menu"]').last().getByRole("menuitem").evaluateAll((els) =>
  els.map((e) => `${(e as HTMLButtonElement).disabled ? "off" : "ON "} ${e.textContent}`),
);
step(`8 Animation menu: ${JSON.stringify(anim.slice(0, 10))}`);
await page.keyboard.press("Escape");

await page.screenshot({ path: "refs/probe/keyframe-baseline.png", clip: { x: 0, y: 520, width: 1500, height: 400 } });
step("screenshot: refs/probe/keyframe-baseline.png");
await browser.close();
