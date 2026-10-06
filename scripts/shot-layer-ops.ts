// Screenshots of the layer-operation UI in the running dev server (headless Edge):
// the selected layer's box, handles and anchor after a drag, the Layer > New
// submenu, the Solid Settings dialog and the editable Transform values.
//
//   node scripts/shot-layer-ops.ts [project.aep] [http://localhost:5173]
// Writes refs/probe-layerops-*.png.
import { chromium } from "playwright-core";

const [path = "refs/fixtures/layerops.base.aep", base = "http://localhost:5173"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console error:", m.text()));
await page.goto(base);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
await page.waitForSelector(".comp-svg");
await page.waitForTimeout(800);

const svg = page.locator(".comp-svg");
const box = (await svg.boundingBox())!;
const at = (x: number, y: number) => [box.x + (x / 160) * box.width, box.y + (y / 120) * box.height] as const;

// Select "layerops wide" from the Timeline, then drag it in the viewer and rotate it a little.
await page.getByRole("treeitem", { name: "layerops wide" }).click();
await page.mouse.move(...at(80, 60));
await page.mouse.down();
await page.mouse.move(...at(70, 50), { steps: 4 });
await page.mouse.up();
await page.keyboard.press("w");
await page.mouse.move(...at(140, 50));
await page.mouse.down();
await page.mouse.move(...at(140, 70), { steps: 4 });
await page.mouse.up();
await page.keyboard.press("v");
await page.getByRole("button", { name: "Expand layerops wide" }).click();
await page.getByRole("button", { name: "Expand Transform" }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: "refs/probe-layerops-viewer.png" });

await page.getByRole("menuitem", { name: "Layer", exact: true }).click();
await page.getByRole("menuitem", { name: /^Transform/ }).hover();
await page.waitForTimeout(200);
await page.screenshot({ path: "refs/probe-layerops-menu.png", clip: { x: 0, y: 0, width: 900, height: 700 } });
await page.keyboard.press("Escape");

await page.keyboard.press("Control+y");
await page.waitForSelector(".solid-dialog");
await page.screenshot({ path: "refs/probe-layerops-solid.png" });
await page.getByRole("button", { name: "OK" }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: "refs/probe-layerops-after-solid.png" });
await browser.close();
