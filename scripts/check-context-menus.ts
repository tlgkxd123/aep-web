// Opens a project in the running dev server's app (headless Edge), right-clicks a
// Project item, a Timeline layer and the Composition viewer, and saves screenshots
// of each context menu (and an opened submenu) to refs/probe-context-*.png.
//
//   node scripts/check-context-menus.ts <project.aep> [http://localhost:5173]
import { chromium } from "playwright-core";

const [path, base = "http://localhost:5173"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(base);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
await page.waitForTimeout(4000);

const menuItems = async () => (await page.locator(".context-menu").first().locator(".menu-item").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
const shot = async (name: string) => page.screenshot({ path: `refs/probe-context-${name}.png` });

await page.locator(".proj-row").first().click({ button: "right" });
console.log("project item:", (await menuItems()).join(" | "));
await shot("project");
await page.keyboard.press("Escape");

// The first layer with a source, so "Reveal Layer Source in Project" applies.
const layers = page.locator(".tl-layer");
const reveal = page.locator(".context-menu .menu-item", { hasText: "Reveal Layer Source in Project" });
for (let i = 0; i < (await layers.count()); i++) {
  await layers.nth(i).click({ button: "right" });
  const ok = await reveal.isEnabled();
  console.log(`  layer row ${i} "${(await layers.nth(i).innerText()).split("\n").slice(0, 3).join(" ")}": reveal ${ok ? "enabled" : "disabled"}`);
  if (ok) break;
  await page.keyboard.press("Escape");
}
console.log("layer:", (await menuItems()).join(" | "));
await page.locator(".context-menu .menu-item", { hasText: "Blending Mode" }).hover();
await page.waitForTimeout(200);
console.log("blending submenu open:", await page.locator(".context-menu").count(), "menus");
await shot("layer");
await page.locator(".context-menu .menu-item", { hasText: "Reveal Layer Source in Project" }).click();
await page.waitForTimeout(300);
console.log("after reveal, selected project row:", await page.locator(".proj-row.selected").first().innerText().catch(() => "none"));

const svg = page.locator(".comp-svg");
const box = (await svg.boundingBox())!;
await page.mouse.click(box.x + 4, box.y + 4, { button: "right" });
console.log("viewer:", (await menuItems()).join(" | "));
await shot("viewer");
await browser.close();
