// Draws and edits masks and shapes by touch on emulated phones (headless Edge: their viewport, user agent and touch
// input through DevTools), the way scripts/check-drawing.ts does with a mouse on a desktop screen: the Rectangle tool
// masks the selected solid, a pinch during a draw adds nothing, a finger beside a vertex drags it, the Pen closes a
// path with a tap near its first vertex, a second tap on a tool opens its flyout (Delete Vertex, Star), a long press on
// a layer reaches Layer > Mask > New Mask and Show Properties > Mask Path, a long press on a mask its Mode; the project
// saved from the menu sheet is read back. Screenshots go to dist-tools/mobile-drawing/. Prints MOBILE-DRAWING-PASSED
// when every check holds on every device.
//
//   node scripts/check-mobile-drawing.ts [app url | --serve] [--only device,device] [--android]
//
// --android runs it in the Android app instead (the debug APK on the connected emulator or device), saving into
// Documents/aep-web as the app does.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, devices, type CDPSession, type Locator, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import type { CompItem, Property, PropertyGroup, PropertyNode, Shape } from "../src/aep/model.ts";
import { projectFromRifx } from "../src/aep/parse.ts";
import { readRifx } from "../src/aep/riff.ts";
import { addLayer } from "../src/edit/layers.ts";
import { MaskMode } from "../src/edit/masks.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";

const W = 640;
const H = 360;
const OUT = resolve(import.meta.dirname, "../dist-tools/mobile-drawing");
const DEVICES = [
  { name: "android-portrait", descriptor: devices["Pixel 7"] },
  { name: "iphone-portrait", descriptor: devices["iPhone 13"] },
];

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : undefined;
const android = args.includes("--android");
let server: ViteDevServer | undefined;
let url = args.find((a) => /^https?:/.test(a)) ?? "http://localhost:5173/";
if (args.includes("--serve")) {
  server = await createServer({ configFile: "vite.config.ts", logLevel: "error", server: { port: 5197, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
}
mkdirSync(OUT, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "aep-touch-draw-"));
const projectPath = join(dir, "draw.aep");
{
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Draw", width: W, height: H, frameRate: 30, duration: 5 });
  addLayer(editor, comp, { kind: "solid", name: "Plate", color: [0.2, 0.6, 0.9], width: 400, height: 240 });
  writeFileSync(projectPath, editor.save());
}

const failures: string[] = [];
let device = "";
const check = (ok: boolean, what: string, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${device}: ${what}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(`${device}: ${what}`);
};

type Point = { x: number; y: number };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real touch input, fingers numbered in the order given. */
class Fingers {
  private readonly cdp: CDPSession;
  constructor(cdp: CDPSession) {
    this.cdp = cdp;
  }
  send(type: "touchStart" | "touchMove" | "touchEnd", points: Point[]) {
    return this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id, radiusX: 4, radiusY: 4 })) });
  }
  /** One finger from `from` to `to`, held still before it lifts so the browser does not fling. */
  async drag(from: Point, to: Point, steps = 10) {
    await this.send("touchStart", [from]);
    for (let i = 1; i <= steps; i++) {
      await this.send("touchMove", [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
      await pause(16);
    }
    await pause(120);
    await this.send("touchEnd", []);
    await pause(450);
  }
  async tap(at: Point) {
    await this.send("touchStart", [at]);
    await pause(60);
    await this.send("touchEnd", []);
    await pause(450);
  }
  async press(at: Point, ms: number) {
    await this.send("touchStart", [at]);
    await pause(ms);
    await this.send("touchEnd", []);
    await pause(300);
  }
}

async function until(test: () => Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await test()) return true;
    if (Date.now() > end) return false;
    await pause(100);
  }
}

/** The touch run on an opened project; `save` taps Save with the function it is given and returns the saved file. */
async function run(page: Page, fingers: Fingers, save: (tapSave: () => Promise<void>) => Promise<Uint8Array>) {
  const frame = page.locator(".comp-frame");
  /** A finger's tap on the middle of what `locator` finds. */
  const tapOn = async (locator: Locator) => {
    await locator.scrollIntoViewIfNeeded();
    const b = (await locator.boundingBox())!;
    await fingers.tap({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  };
  const at = async (x: number, y: number): Promise<Point> => {
    const b = (await frame.boundingBox())!;
    return { x: b.x + (x / W) * b.width, y: b.y + (y / H) * b.height };
  };
  const centre = async (selector: string, nth = 0): Promise<Point> => {
    const b = (await page.locator(selector).nth(nth).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const sheet = page.locator(".sheet");
  /** A row of the menu sheet by its label (rows with a check mark are not plain menu items). */
  const entry = (label: RegExp) => sheet.locator(".sheet-item").filter({ has: page.locator(".sheet-label", { hasText: label }) }).first();
  const tool = (name: string) => page.locator(`.toolbar button[aria-label="${name}"]`).first();
  const pick = async (name: string) => {
    await tapOn(tool(name));
    await pause(150);
  };
  /** A second tap on the tool in use opens its flyout; then the tool `name` is tapped in the sheet. */
  const flyout = async (current: string, name: string) => {
    // Not straight after the tap that picked it: the browser takes two quick taps on one spot for a double tap.
    await pause(600);
    await tapOn(tool(current));
    const row = entry(new RegExp(`^${name}$`));
    const opened = await until(() => row.isVisible());
    if (!opened) await page.screenshot({ path: join(OUT, `${device}-flyout.png`) });
    check(opened, `a second tap on the ${current} opens its tools as a sheet`);
    await tapOn(row);
    await until(async () => (await tool(name).getAttribute("aria-pressed")) === "true");
    await pause(150);
  };
  const vertices = () => page.locator(".path-overlay .path-vertex").count();
  const outlines = () => page.locator(".path-overlay .path-line").count();
  const timeline = page.getByRole("tree", { name: "Timeline layers" });
  const layerRow = (name: string) => timeline.getByRole("treeitem", { name, exact: true });

  check(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "the screen reports a coarse pointer, as a phone's does");
  await tapOn(page.getByRole("tab", { name: "Timeline", exact: true }));
  await pause(500);
  await tapOn(layerRow("Plate").locator(".c-name"));
  check(await until(async () => (await layerRow("Plate").getAttribute("aria-selected")) === "true"), "a tap selects the solid");

  // The Rectangle tool: one finger draws a mask on the selected solid.
  await pick("Rectangle Tool");
  await fingers.drag(await at(200, 100), await at(400, 250));
  await pick("Selection Tool");
  check((await vertices()) === 4 && (await outlines()) === 1, "a one-finger drag with the Rectangle tool masks the selected solid", `${await vertices()} vertices`);

  // A second finger during a draw turns it into a pinch: no mask, no box left on screen.
  await pick("Rectangle Tool");
  const zoom0 = await page.getByLabel("Magnification").inputValue();
  const a = await at(100, 60);
  const b = await at(140, 90);
  await fingers.send("touchStart", [a]);
  for (let i = 1; i <= 4; i++) await fingers.send("touchMove", [{ x: a.x + i * 6, y: a.y + i * 4 }]), await pause(16);
  const a1 = { x: a.x + 24, y: a.y + 16 };
  await fingers.send("touchStart", [a1, b]);
  for (let i = 1; i <= 8; i++) {
    await fingers.send("touchMove", [{ x: a1.x - i * 6, y: a1.y - i * 3 }, { x: b.x + i * 6, y: b.y + i * 3 }]);
    await pause(16);
  }
  await pause(120);
  await fingers.send("touchEnd", []);
  await pause(450);
  const zoom1 = await page.getByLabel("Magnification").inputValue();
  check((await outlines()) === 1 && (await page.locator(".draw-draft").count()) === 0 && zoom1 !== zoom0, "a pinch during a draw zooms and draws nothing", `zoom ${zoom0} -> ${zoom1}, ${await outlines()} paths`);
  await page.getByLabel("Magnification").selectOption("fit");
  await pause(300);

  // The Selection tool: a finger beside a vertex (outside its square, inside a finger's reach) drags it.
  await pick("Selection Tool");
  const vertexX = async (i: number) => Number(await page.locator(".path-overlay .path-vertex").nth(i).getAttribute("x"));
  const [x0, other0] = [await vertexX(0), await vertexX(2)];
  const v = await centre(".path-overlay .path-vertex");
  await fingers.drag({ x: v.x + 9, y: v.y + 9 }, { x: v.x + 9 + 40, y: v.y + 9 + 10 });
  const [x1, other1] = [await vertexX(0), await vertexX(2)];
  // Not the layer or the whole path: the vertex alone.
  check(x1 - x0 > 20 && Math.abs(other1 - other0) < 0.01, "a finger 9 px beside a vertex drags that vertex alone", `x ${x0.toFixed(1)} -> ${x1.toFixed(1)}, another ${other0.toFixed(1)} -> ${other1.toFixed(1)}`);

  // The Pen: taps place vertices, a tap near the first closes the path, a second mask on the solid.
  await pick("Pen Tool");
  for (const [x, y] of [[80, 300], [180, 330], [140, 280]]) await fingers.tap(await at(x, y));
  const close = await at(80, 300);
  await fingers.tap({ x: close.x + 8, y: close.y + 6 });
  await pick("Selection Tool");
  check((await outlines()) === 2 && (await vertices()) === 7, "Pen taps and a tap near the first vertex add a closed path", `${await outlines()} paths, ${await vertices()} vertices`);

  // Delete Vertex from the Pen's flyout.
  await pick("Pen Tool");
  await flyout("Pen Tool", "Delete Vertex Tool");
  await fingers.tap(await centre(".path-overlay .path-vertex", 1));
  check((await vertices()) === 6, "the Delete Vertex tool removes the tapped vertex", `${await vertices()} vertices`);

  // A long press on the layer: Layer > Mask > New Mask, then Show Properties > Mask Path.
  await pick("Selection Tool");
  await fingers.press(await centre('[role="tree"][aria-label="Timeline layers"] .tl-layer .c-name'), 900);
  check(await until(() => entry(/^Mask$/).isVisible()), "a long press on the layer opens its menu, with Mask");
  await tapOn(entry(/^Mask$/));
  await tapOn(entry(/^New Mask$/));
  check(await until(async () => (await outlines()) === 3), "its Mask > New Mask adds a mask", `${await outlines()} paths`);
  await fingers.press(await centre('[role="tree"][aria-label="Timeline layers"] .tl-layer .c-name'), 900);
  await tapOn(entry(/^Show Properties$/));
  await tapOn(entry(/^Mask Path$/));
  const paths = timeline.getByRole("treeitem", { name: "Mask Path" });
  check(await until(async () => (await paths.count()) === 3), "Show Properties > Mask Path shows the three mask paths in the Timeline", `${await paths.count()} rows`);

  // A long press on a mask's row: Mode > Subtract.
  await fingers.press(await centre('[role="treeitem"][aria-label="Mask 1"]'), 900);
  await tapOn(entry(/^Mode$/));
  await tapOn(entry(/^Subtract$/));
  await pause(300);

  // Nothing selected: the Star tool from the Rectangle tool's flyout makes a shape layer.
  await fingers.tap(await at(20, 20));
  await pick("Rectangle Tool");
  await flyout("Rectangle Tool", "Star Tool");
  await fingers.drag(await at(560, 180), await at(600, 180));
  await pick("Selection Tool");
  check(await until(async () => (await layerRow("Shape Layer 1").count()) === 1), "the Star tool with nothing selected makes a shape layer");
  await page.screenshot({ path: join(OUT, `${device}.png`) });

  // File > Save from the menu sheet, read back.
  const bytes = await save(async () => {
    await tapOn(page.getByRole("button", { name: "Menu", exact: true }));
    await tapOn(entry(/^File$/));
    await tapOn(entry(/^Save$/));
  });
  const project = projectFromRifx(readRifx(bytes));
  const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "Draw")!;
  const find = (nodes: readonly PropertyNode[], matchName: string): PropertyNode | undefined => {
    for (const n of nodes) {
      if (n.matchName === matchName) return n;
      const found = n.kind === "group" ? find(n.children, matchName) : undefined;
      if (found) return found;
    }
    return undefined;
  };
  const plate = comp.layers.find((l) => l.name === "Plate");
  const masks = ((plate && (find(plate.properties, "ADBE Mask Parade") as PropertyGroup | undefined))?.children ?? []).filter((n): n is PropertyGroup => n.kind === "group");
  const counts = masks.map((m) => ((find(m.children, "ADBE Mask Shape") as Property).value as Shape).vertices.length);
  const closed = masks.map((m) => ((find(m.children, "ADBE Mask Shape") as Property).value as Shape).closed);
  check(
    masks.length === 3 && masks[0].mask?.maskMode === MaskMode.SUBTRACT && counts.join() === "3,3,4" && closed.every(Boolean),
    "the saved project: three closed masks (the rectangle with a vertex deleted, the Pen's, New Mask's), the first Subtract",
    `${masks.length} masks, vertices ${counts.join(",")}, modes ${masks.map((m) => m.mask?.maskMode).join(",")}`,
  );
  const star = comp.layers.find((l) => l.name === "Shape Layer 1");
  check(!!star && (find(star.properties, "ADBE Vector Star Type") as Property | undefined)?.value === 1, "the saved project has the star's shape layer");
}

const errors: string[] = [];
const runSafely = async (page: Page, fingers: Fingers, save: Parameters<typeof run>[2]) => {
  try {
    await run(page, fingers, save);
  } catch (e) {
    check(false, `the touch drawing runs to the end (${(e as Error).message.split("\n")[0]})`);
  }
  await page.screenshot({ path: join(OUT, `${device}-end.png`) });
};

try {
  if (android) await runOnAndroid();
  else {
    const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
    try {
      for (const d of DEVICES) {
        if (only && !only.includes(d.name)) continue;
        device = d.name;
        const context = await browser.newContext({ ...d.descriptor, acceptDownloads: true });
        const page = await context.newPage();
        page.on("pageerror", (e) => errors.push(`${device}: ${e.message}`));
        await page.addInitScript(() => {
          const w = window as unknown as Record<string, unknown>;
          delete w.showSaveFilePicker;
          delete w.showOpenFilePicker;
        });
        await page.goto(url);
        await page.getByLabel("Open After Effects project").setInputFiles(projectPath);
        await page.locator(".comp-frame").waitFor({ timeout: 30000 });
        await pause(1000);
        await runSafely(page, new Fingers(await context.newCDPSession(page)), async (tapSave) => {
          const download = page.waitForEvent("download", { timeout: 15000 });
          await tapSave();
          const saved = join(dir, `${device}.aep`);
          await (await download).saveAs(saved);
          return new Uint8Array(readFileSync(saved));
        });
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
}

/** The same run in the Android app (debug APK) on the connected emulator or device, over its WebView's DevTools. */
async function runOnAndroid() {
  device = "android-app";
  const PKG = "com.zionschxma.aev3";
  const FOLDER = "/sdcard/Documents/aep-web";
  const adbPath = join(process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? "", "Android/Sdk"), "platform-tools/adb");
  const adb = (...a: string[]) => execFileSync(adbPath, a, { encoding: "utf8" });
  adb("shell", "am", "force-stop", PKG);
  adb("shell", "rm", "-rf", FOLDER);
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  let socket = "";
  for (let i = 0; i < 80 && !socket; i++) {
    await pause(500);
    const pid = (() => {
      try {
        return adb("shell", "pidof", PKG).trim();
      } catch {
        return "";
      }
    })();
    if (pid && adb("shell", "cat", "/proc/net/unix").includes(`@webview_devtools_remote_${pid}`)) socket = `webview_devtools_remote_${pid}`;
  }
  if (!socket) throw new Error("The app's WebView exposes no DevTools socket (is it a debug build?).");
  adb("forward", "tcp:9334", `localabstract:${socket}`);
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9334");
  try {
    const page = browser.contexts()[0].pages()[0] ?? (await browser.contexts()[0].waitForEvent("page"));
    page.on("pageerror", (e) => errors.push(`${device}: ${e.message}`));
    await page.waitForLoadState("load");
    await page.evaluate(
      ([data, name]) => {
        const input = document.querySelector<HTMLInputElement>('input[aria-label="Open After Effects project"]')!;
        const transfer = new DataTransfer();
        transfer.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name));
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      [readFileSync(projectPath).toString("base64"), "draw.aep"] as const,
    );
    await page.locator(".comp-frame").waitFor({ timeout: 30000 });
    await pause(1500);
    await runSafely(page, new Fingers(await page.context().newCDPSession(page)), async (tapSave) => {
      await tapSave();
      // The app saves into Documents/aep-web.
      let name = "";
      for (let i = 0; i < 40 && !name; i++) {
        await pause(250);
        try {
          name = adb("shell", "ls", "-1", FOLDER).split(/\r?\n/).map((f) => f.trim()).find((f) => f.endsWith(".aep")) ?? "";
        } catch {
          // Not written yet.
        }
      }
      if (!name) throw new Error(`nothing saved in ${FOLDER}`);
      const local = join(dir, name);
      adb("pull", `${FOLDER}/${name}`, local);
      return new Uint8Array(readFileSync(local));
    });
  } finally {
    await browser.close();
  }
}
device = "all";
check(!errors.length, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
console.log(failures.length ? "MOBILE-DRAWING-FAILED" : "MOBILE-DRAWING-PASSED");
process.exit(failures.length ? 1 : 0);
