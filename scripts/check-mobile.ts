// Drives the app on emulated phones and tablets (headless Edge: their viewport, device pixel ratio, user agent and
// touch input) and checks that the whole app works there: the layout fits the screen, every panel is reachable, the
// touch targets are large enough, and the gestures act (tap, drag, pinch, long-press). Screenshots of each device go
// to dist-tools/mobile/.
//   node scripts/check-mobile.ts [app url | --serve] [--only device,device]
// --serve starts a dev server for the run. Prints MOBILE-PASSED when every check passes on every device.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, devices, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/roundtrip.base.aep");
const COMP = "roundtrip_minimax";
const CARD = "roundtrip_card";
const OUT = resolve(import.meta.dirname, "../dist-tools/mobile");

const DEVICES = [
  { name: "iphone-portrait", descriptor: devices["iPhone 13"], compact: true },
  { name: "android-portrait", descriptor: devices["Pixel 7"], compact: true },
  { name: "phone-landscape", descriptor: devices["iPhone 13 landscape"], compact: true },
  { name: "ipad-portrait", descriptor: devices["iPad (gen 7)"], compact: true },
  { name: "ipad-landscape", descriptor: devices["iPad (gen 7) landscape"], compact: false },
];

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : undefined;
let server: ViteDevServer | undefined;
let url = args.find((a) => /^https?:/.test(a)) ?? "http://localhost:5173/";
if (args.includes("--serve")) {
  server = await createServer({ configFile: "vite.config.ts", logLevel: "error", server: { port: 5196, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
}
mkdirSync(OUT, { recursive: true });

const failures: string[] = [];
let device = "";
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${device}: ${what}`);
  if (!ok) failures.push(`${device}: ${what}`);
};

/** The page's layout overflow: how far the document reaches past the viewport, in CSS pixels. */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return { x: el.scrollWidth - window.innerWidth, y: el.scrollHeight - window.innerHeight };
  });

/** Every element matching `selector` that is shown, with its box. */
const boxes = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed")
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { label: e.getAttribute("aria-label") ?? e.textContent?.trim() ?? e.tagName, x: r.x, y: r.y, width: r.width, height: r.height };
      });
  }, selector);

const within = (page: Page, b: { x: number; y: number; width: number; height: number }) => {
  const vp = page.viewportSize()!;
  return b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= vp.width + 0.5 && b.y + b.height <= vp.height + 0.5;
};

type Point = { x: number; y: number };
/** Real touch input (the browser turns it into pointer, touch and gesture events), one or more fingers. */
class Fingers {
  private readonly cdp: CDPSession;
  constructor(cdp: CDPSession) {
    this.cdp = cdp;
  }
  private send(type: "touchStart" | "touchMove" | "touchEnd", points: Point[]) {
    return this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id, radiusX: 4, radiusY: 4 })) });
  }
  /**
   * Fingers from `from` to `to` (same count), in `steps` moves, held still before they lift as when placing something:
   * a finger lifting while it moves flings, and the browser spends the next tap on stopping the fling.
   */
  async drag(from: Point[], to: Point[], steps = 10) {
    await this.send("touchStart", from);
    for (let i = 1; i <= steps; i++) {
      await this.send("touchMove", from.map((p, k) => ({ x: p.x + ((to[k].x - p.x) * i) / steps, y: p.y + ((to[k].y - p.y) * i) / steps })));
      await new Promise((r) => setTimeout(r, 16));
    }
    await new Promise((r) => setTimeout(r, 120));
    await this.send("touchMove", to);
    await this.send("touchEnd", []);
    // The browser drops a tap that follows a gesture this closely (its tap suppression); a person is slower.
    await new Promise((r) => setTimeout(r, 450));
  }
  async press(at: Point, ms: number) {
    await this.send("touchStart", [at]);
    await new Promise((r) => setTimeout(r, ms));
    await this.send("touchEnd", []);
  }
}

const centre = async (locator: Locator): Promise<Point> => {
  const b = (await locator.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** Waits for `test` to hold, up to `ms`. */
async function until(test: () => Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await test()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The touch interactions of a compact screen, on comp COMP opened from the Project tab. */
async function interact(page: Page, fingers: Fingers) {
  // Opening a comp by touch: a tap selects it, a second tap opens it.
  await page.getByRole("tab", { name: "Project", exact: true }).tap();
  await page.getByLabel("Search project").fill(COMP);
  const item = page.getByRole("tree", { name: "Project items" }).getByRole("treeitem").filter({ hasText: COMP }).first();
  await item.locator(".cell-text").tap();
  await page.waitForTimeout(400);
  await item.locator(".cell-text").tap();
  const viewer = page.getByRole("img", { name: new RegExp(`^${COMP}, `) });
  check(await until(() => viewer.isVisible()), `a tap on the selected ${COMP} opens it in the viewer`);
  check((await page.getByRole("tab", { name: "Timeline", exact: true }).getAttribute("aria-selected")) === "true", "opening a comp shows its Timeline tab");

  // A tap selects a Timeline layer.
  const row = page.getByRole("tree", { name: "Timeline layers" }).getByRole("treeitem", { name: CARD });
  await row.locator(".c-name").tap();
  const box = page.locator(".sel-box polygon");
  check(await until(async () => (await row.getAttribute("class"))?.includes("selected") === true && (await box.count()) > 0), "a tap selects the Timeline layer, and the viewer outlines it");

  // One finger drags the selected layer.
  const before = (await box.boundingBox())!;
  const from = await centre(viewer);
  await fingers.drag([from], [{ x: from.x + 30, y: from.y + 20 }]);
  const after = (await box.boundingBox())!;
  const moved = { x: after.x - before.x, y: after.y - before.y };
  check(Math.abs(moved.x - 30) <= 2 && Math.abs(moved.y - 20) <= 2, `a one-finger drag moves the layer with the finger (moved ${moved.x.toFixed(1)}, ${moved.y.toFixed(1)} px for 30, 20)`);

  // The menu button's sheet runs Edit > Undo.
  await page.getByRole("button", { name: "Menu", exact: true }).tap();
  const sheet = page.locator(".sheet");
  check(await until(() => sheet.isVisible()), "the Menu button opens the menus as a sheet");
  check(
    await until(async () => {
      const b = await sheet.boundingBox();
      return !!b && within(page, b);
    }),
    "the menu sheet is on screen",
  );
  await sheet.getByRole("menuitem", { name: "Edit" }).tap();
  const undo = sheet.getByRole("menuitem", { name: /^Undo/ });
  const rows = await boxes(page, ".sheet-item");
  const short = rows.filter((r) => r.height < 44);
  check(rows.length > 0 && !short.length, `sheet rows are at least 44 px tall (${rows.length} rows${short.length ? `; short: ${short.map((r) => `${r.label} ${r.height}`).join(", ")}` : ""})`);
  await undo.tap();
  check(await until(async () => !(await sheet.isVisible())), "choosing an item closes the sheet");
  const undone = (await box.boundingBox())!;
  check(Math.abs(undone.x - before.x) <= 1 && Math.abs(undone.y - before.y) <= 1, "Edit > Undo from the sheet puts the layer back");

  // A long press on a layer opens its context menu as a sheet.
  await fingers.press(await centre(row.locator(".c-name")), 900);
  check(await until(() => sheet.getByRole("menuitem", { name: /^Duplicate/ }).isVisible()), "a long press on a Timeline layer opens its menu as a sheet");
  await page.screenshot({ path: join(OUT, `${device}-sheet.png`) });
  await sheet.getByRole("button", { name: "Close menu" }).tap();
  check(await until(async () => !(await sheet.isVisible())), "the sheet's Close button closes it");

  // Two fingers pinch the viewer to zoom.
  const frame = page.locator(".comp-frame");
  const width0 = (await frame.boundingBox())!.width;
  const c = await centre(viewer);
  await fingers.drag(
    [
      { x: c.x - 30, y: c.y },
      { x: c.x + 30, y: c.y },
    ],
    [
      { x: c.x - 75, y: c.y },
      { x: c.x + 75, y: c.y },
    ],
  );
  const width1 = (await frame.boundingBox())!.width;
  const zoom = await page.getByLabel("Magnification").inputValue();
  check(width1 / width0 > 2 && width1 / width0 < 3 && zoom !== "fit", `a pinch zooms the viewer (${(width1 / width0).toFixed(2)}x for 2.5x, magnification ${zoom})`);
  const still = (await box.boundingBox())!;
  check(Math.abs(still.width / undone.width - width1 / width0) < 0.15, "the pinch does not move the layer");

  // Dragging on the time ruler moves the current time.
  const time = page.locator(".mtransport-time");
  const t0 = await time.innerText();
  const ruler = (await page.getByRole("slider", { name: "Current time" }).boundingBox())!;
  // Clear of the outline splitter's grip at the ruler's left edge.
  await fingers.drag([{ x: ruler.x + 16, y: ruler.y + ruler.height / 2 }], [{ x: ruler.x + ruler.width * 0.6, y: ruler.y + ruler.height / 2 }]);
  const t1 = await time.innerText();
  check(t1 !== t0, `dragging on the time ruler moves the current time (${t0} to ${t1})`);

  // Play starts and stops playback.
  await page.getByRole("button", { name: "Play", exact: true }).tap();
  const playing = await until(() => page.getByRole("button", { name: "Stop", exact: true }).isVisible());
  check(playing, "Play starts playback");
  if (!playing) await page.screenshot({ path: join(OUT, `${device}-play.png`) });
  else {
    await page.getByRole("button", { name: "Stop", exact: true }).tap();
    check(await until(() => page.getByRole("button", { name: "Play", exact: true }).isVisible()), "Stop ends playback");
  }

  // An effect applies from Effects & Presets with taps only.
  await page.getByRole("tab", { name: "Effects & Presets", exact: true }).tap();
  await page.getByLabel("Search effects and presets").fill("mirror");
  const mirror = page.getByRole("tree", { name: "Effects & Presets" }).getByRole("treeitem", { name: "Distort", exact: true }).getByRole("treeitem", { name: "Mirror", exact: true });
  await until(async () => (await mirror.getAttribute("aria-disabled")) === null);
  await mirror.tap();
  await page.getByRole("button", { name: `Apply Mirror to ${CARD}` }).tap();
  const applied = await until(async () => (await page.getByRole("tree", { name: "Effect Controls" }).locator(".ec-effect-name").allInnerTexts()).includes("Mirror"));
  check(applied, "tapping an effect and Apply adds it to the selected layer, shown in Effect Controls");

  // A render is queued by tapping, and its row and settings fit the panel.
  await page.getByRole("tab", { name: "Render Queue", exact: true }).tap();
  await page.getByRole("button", { name: "Add Active Comp" }).tap();
  const queued = page.getByRole("listitem", { name: `${COMP}: Queued` });
  check(await until(() => queued.isVisible()), "Add Active Comp queues the comp");
  const panelBox = (await boxes(page, "#mpanel"))[0];
  const parts = await boxes(page, ".rq-row, .rq-settings .rq-field");
  const outside = parts.filter((p) => p.x < panelBox.x - 0.5 || p.x + p.width > panelBox.x + panelBox.width + 0.5);
  check(parts.length > 1 && !outside.length, `the queued item's row and settings fit the panel${outside.length ? ` (outside: ${outside.map((p) => p.label).join(", ")})` : ""}`);
  await page.screenshot({ path: join(OUT, `${device}-render-queue.png`) });

  // Touch targets of the compact chrome.
  const chrome = (await boxes(page, ".mtab, .mtop-btn, .mtransport-btn")).filter((b) => b.height < 44);
  check(!chrome.length, `the tab bar, top bar and playback buttons are at least 44 px tall${chrome.length ? ` (short: ${chrome.map((b) => `${b.label} ${b.height}`).join(", ")})` : ""}`);
  await page.screenshot({ path: join(OUT, `${device}-applied.png`) });
}

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const errors: string[] = [];
try {
  for (const d of DEVICES) {
    if (only && !only.includes(d.name)) continue;
    device = d.name;
    const context: BrowserContext = await browser.newContext({ ...d.descriptor });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`${device}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(`${device}: ${m.text()}`));
    await page.goto(url);
    await page.screenshot({ path: join(OUT, `${device}-home.png`) });
    const home = await overflow(page);
    check(home.x <= 0 && home.y <= 0, `the home screen fits (overflow ${home.x} x ${home.y} px)`);

    // Opened as a person does: tapping Open Project must bring up the browser's file chooser, unfiltered, since phones
    // and tablets grey out files of a type they do not know, as .aep is.
    const chooser = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
    await page.getByRole("button", { name: "Open Project" }).tap();
    const fileChooser = await chooser;
    check(!!fileChooser, "tapping Open Project brings up the file chooser");
    if (fileChooser) {
      const accept = await fileChooser.element().getAttribute("accept");
      check(!accept, `the file chooser does not filter by type (accept: ${accept ?? "none"})`);
      await fileChooser.setFiles(FIXTURE);
    } else {
      await page.getByLabel("Open After Effects project").setInputFiles(FIXTURE);
    }
    await page.getByRole("tree", { name: "Project items" }).or(page.getByRole("tree", { name: "Timeline layers" })).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    const compact = await page.locator(".app.compact").count();
    check(!!compact === d.compact, `uses the ${d.compact ? "compact" : "desktop"} workspace`);
    const opened = await overflow(page);
    check(opened.x <= 0 && opened.y <= 0, `the workspace fits (overflow ${opened.x} x ${opened.y} px)`);
    await page.screenshot({ path: join(OUT, `${device}-workspace.png`) });

    if (d.compact) {
      for (const tab of ["Project", "Timeline", "Effect Controls", "Effects & Presets", "Render Queue", "More panels"]) {
        await page.getByRole("tab", { name: tab, exact: true }).tap();
        await page.waitForTimeout(150);
        const panel = (await boxes(page, "#mpanel"))[0];
        check(!!panel && within(page, panel) && panel.height > 60, `the ${tab} tab shows its panel on screen (${panel ? `${Math.round(panel.width)} x ${Math.round(panel.height)}` : "none"})`);
        await page.screenshot({ path: join(OUT, `${device}-tab-${tab.replace(/[^a-z]+/gi, "-").toLowerCase()}.png`) });
      }
      try {
        await interact(page, new Fingers(await context.newCDPSession(page)));
      } catch (e) {
        await page.screenshot({ path: join(OUT, `${device}-failed.png`) });
        check(false, `the touch interactions run to the end (${(e as Error).message.split("\n")[0]})`);
      }
      const final = await overflow(page);
      check(final.x <= 0 && final.y <= 0, `the workspace still fits after the gestures (overflow ${final.x} x ${final.y} px)`);
    } else {
      check((await page.locator(".ws").count()) === 1, "shows the desktop frames");
    }
    await context.close();
  }
} finally {
  await browser.close();
  await server?.close();
}
device = "all";
check(!errors.length, `no page errors${errors.length ? `:\n  ${errors.join("\n  ")}` : ""}`);
if (failures.length) process.exit(1);
console.log("MOBILE-PASSED");
