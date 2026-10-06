// Drives the toolbars and panel controls of the running dev server's app in headless
// Edge and reports what changed, plus any page errors. Screenshots: refs/probe-ui-*.png.
//
//   node scripts/check-interactions.ts <project.aep> [http://localhost:5173]
import { chromium } from "playwright-core";

const [path, base = "http://localhost:5173"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push([name, ok, detail]);

await page.goto(base);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
await page.waitForTimeout(4000);

const frame = page.locator(".comp-frame");
const svg = page.locator(".comp-svg");
const frameBox = async () => (await frame.boundingBox())!;

// Hand tool pans.
await page.locator('button[aria-label="Hand Tool"]').click();
let b = await frameBox();
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
await page.mouse.down();
await page.mouse.move(b.x + b.width / 2 + 80, b.y + b.height / 2 + 40, { steps: 5 });
await page.mouse.up();
let after = await frameBox();
check("hand tool pans the view", Math.abs(after.x - b.x - 80) < 3 && Math.abs(after.y - b.y - 40) < 3, `moved ${Math.round(after.x - b.x)},${Math.round(after.y - b.y)}`);

// Wheel zooms around the cursor.
b = await frameBox();
await page.mouse.move(b.x + 20, b.y + 20);
await page.mouse.wheel(0, -200);
await page.waitForTimeout(150);
after = await frameBox();
check("wheel zooms in", after.width > b.width * 1.2, `width ${Math.round(b.width)} -> ${Math.round(after.width)}`);

// Zoom tool zooms out with Alt.
await page.locator('button[aria-label="Zoom Tool"]').click();
b = await frameBox();
await page.keyboard.down("Alt");
await svg.click({ position: { x: 10, y: 10 } });
await page.keyboard.up("Alt");
after = await frameBox();
check("zoom tool alt-click zooms out", after.width < b.width, `width ${Math.round(b.width)} -> ${Math.round(after.width)}`);
await page.locator('button[aria-label="Selection Tool"]').click();
await page.locator('select[aria-label="Magnification"]').selectOption("fit");

// Grid and guides menu.
await page.locator('button[aria-label="Choose grid and guide options"]').click();
await page.locator(".context-menu .menu-item", { hasText: "Title/Action Safe" }).click();
check("title/action safe shows", (await page.locator(".viewer-guides .safe-zones").count()) === 1);

// Channels menu.
await page.locator('button[aria-label="Show Channel and Color Management Settings"]').click();
await page.locator(".context-menu .menu-item", { hasText: /^\s*Alpha/ }).click();
check("alpha channel filter applied", ((await page.locator(".comp-canvas").getAttribute("style")) ?? "").includes("aep-channel-alpha"));
await page.screenshot({ path: "refs/probe-ui-viewer.png" });
await page.locator('button[aria-label="Show Channel and Color Management Settings"]').click();
await page.locator(".context-menu .menu-item", { hasText: /^\s*RGB$/ }).first().click();

// Exposure scrub and reset.
const exp = page.locator(".vb-exposure");
const eb = (await exp.boundingBox())!;
await page.mouse.move(eb.x + 5, eb.y + 5);
await page.mouse.down();
await page.mouse.move(eb.x + 45, eb.y + 5, { steps: 4 });
await page.mouse.up();
check("exposure scrubs", (await exp.innerText()).trim() !== "+0.0", await exp.innerText());
await page.locator('button[aria-label="Reset Exposure"]').click();
check("exposure resets", (await exp.innerText()).trim() === "+0.0");

// Snapshot.
await page.locator('button[aria-label="Take Snapshot"]').click();
check("snapshot enables Show Snapshot", await page.locator('button[aria-label="Show Snapshot"]').isEnabled());

// Resolution popup (an undoable comp setting).
await page.locator('button[aria-label^="Resolution/Down Sample Factor"]').click();
await page.locator(".context-menu .menu-item", { hasText: /^\s*Half/ }).click();
await page.waitForTimeout(300);
const canvasW = await page.locator(".comp-canvas").evaluate((c) => (c as HTMLCanvasElement).width);
check("half resolution halves the canvas", canvasW > 0 && canvasW <= 961, `canvas width ${canvasW}`);
await page.keyboard.press("Control+z");

// Timeline: eye switch on a layer.
const eye = page.locator(".tl-layer").nth(1).locator('button[aria-label="Video"]');
const pressed = await eye.getAttribute("aria-pressed");
await eye.click();
await page.waitForTimeout(200);
check("video switch toggles", (await page.locator(".tl-layer").nth(1).locator('button[aria-label="Video"]').getAttribute("aria-pressed")) !== pressed);
await page.keyboard.press("Control+z");

// Mode popup.
await page.locator(".tl-layer").nth(1).locator('button[aria-label^="Mode"]').click();
await page.locator(".context-menu .menu-item", { hasText: /^\s*Screen/ }).click();
await page.waitForTimeout(200);
check("mode popup sets Screen", (await page.locator(".tl-layer").nth(1).innerText()).includes("Screen"));
await page.keyboard.press("Control+z");

// Layer bar drag moves the layer in time.
const bar = page.locator(".tl-layer").nth(1).locator(".tl-bar");
const bb = (await bar.boundingBox())!;
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
await page.mouse.down();
await page.mouse.move(bb.x + bb.width / 2 + 60, bb.y + bb.height / 2, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(200);
const moved = (await page.locator(".tl-layer").nth(1).locator(".tl-bar").boundingBox())!;
check("layer bar drag moves the layer", Math.abs(moved.x - bb.x - 60) < 6, `moved ${Math.round(moved.x - bb.x)} px`);
await page.screenshot({ path: "refs/probe-ui-timeline.png" });
await page.keyboard.press("Control+z");

// Preview panel: Range popup.
await page.locator('button[aria-label^="Range:"]').click();
await page.locator(".context-menu .menu-item", { hasText: "Entire Duration" }).click();
check("preview range set", (await page.locator('button[aria-label^="Range:"]').innerText()).includes("Entire Duration"));

// Snapping checkbox and workspaces.
await page.locator(".snapping").click();
check("snapping toggles", await page.locator(".snapping input").isChecked());
await page.locator(".workspace", { hasText: "Review" }).click();
check("workspace switches", (await page.locator(".workspace.active").innerText()).includes("Review"));

for (const [name, ok, detail] of results) console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
console.log(errors.length ? `page errors:\n  ${errors.join("\n  ")}` : "no page errors");
await browser.close();
process.exit(results.every(([, ok]) => ok) && !errors.length ? 0 : 1);
