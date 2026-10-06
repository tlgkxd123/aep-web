// Opens a project in the running dev server's app (headless Edge) and prints the
// Composition panel's render notes before and after footage loads from disk.
//
//   node scripts/check-app-footage.ts <project.aep> [http://localhost:5173]
import { chromium } from "playwright-core";

const [path, base = "http://localhost:5173"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(base);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
const notes = async () => (await page.locator(".render-notes").allInnerTexts()).join(" | ") || "(no notes)";
await page.waitForTimeout(3000);
console.log("after 3s:", await notes());
await page.waitForTimeout(30000);
console.log("after 33s:", await notes());
await page.screenshot({ path: "refs/probe-app-footage.png" });
await browser.close();
