// Probe: exactly where a keyframe click lands and what it selects.
//   node scripts/probe-keyframe-clicks.ts [http://localhost:5173]
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
const selected = () => position.locator(".tl-kf.selected").count();
step(`layout: track ${JSON.stringify(await position.locator(".tl-track").boundingBox())}, split ${JSON.stringify(await page.locator(".tl-split").boundingBox())}`);

const boxes = [];
for (let i = 0; i < (await kfs.count()); i++) boxes.push((await kfs.nth(i).boundingBox())!);

const b = boxes[0];
for (const dx of [-2, 0, 2, 4, 6, 8, 10]) {
  const x = b.x + b.width / 2 + dx;
  const y = b.y + b.height / 2;
  const hit = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px as number, py as number) as HTMLElement;
    return `${el?.tagName}.${typeof el?.className === "string" ? el.className : ""}`;
  }, [x, y]);
  await page.mouse.click(x, y);
  await page.waitForTimeout(120);
  step(`  dx=${dx} x=${x.toFixed(1)} hit=${hit} -> selected ${await selected()}`);
  await page.mouse.click(boxes[1].x + boxes[1].width / 2, boxes[1].y + boxes[1].height / 2 + 200); // click empty space below to clear? (no)
  await page.evaluate(() => document.querySelectorAll(".tl-kf.selected").forEach((e) => e.classList.remove("selected")));
}

await browser.close();
