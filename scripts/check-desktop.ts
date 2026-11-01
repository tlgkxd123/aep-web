// Opens a project in the desktop app (Electron from the repo, a built .exe, or
// the portable .exe, whose NSIS stub is driven over the DevTools protocol) and
// checks that it renders and that the local footage service answers.
//
//   node scripts/check-desktop.ts [project.aep] [--exe path/to/exe] [--portable]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, _electron as electron, type Page } from "playwright-core";

const args = process.argv.slice(2);
const exeAt = args.indexOf("--exe");
const exe = exeAt >= 0 ? resolve(args[exeAt + 1] ?? "") : undefined;
const portable = args.includes("--portable");
const project = resolve(args.find((a, i) => !a.startsWith("--") && i !== exeAt + 1) ?? "refs/fixtures/fixtures.aep");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The portable NSIS launcher starts the app as a child; its page is reached over CDP. */
async function launchPortable(app: string): Promise<{ page: Page; close(): Promise<void> }> {
  const port = Number(process.env.AEP_CDP_PORT ?? 9333);
  const userData = mkdtempSync(join(tmpdir(), "aep-web-check-"));
  const child = spawn(app, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { stdio: "ignore", windowsHide: true });
  const deadline = Date.now() + 120_000;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  while (!browser) {
    if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode}`);
    if (Date.now() > deadline) throw new Error("the app did not open its DevTools port");
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await wait(500);
    }
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error("the app opened no browser context");
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));
  return {
    page,
    close: async () => {
      await browser.close().catch(() => {});
      await new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once("exit", () => done());
        setTimeout(done, 5000);
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill();
      });
      // The app may still hold its user data for a moment; it is a temp folder.
      try {
        rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {}
    },
  };
}

const errors: string[] = [];

async function verify(page: Page): Promise<void> {
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console error: ${m.text()}`));
  await page.waitForLoadState("domcontentloaded");
  console.log(`window: ${await page.title()}`);

  const token = await page.locator('meta[name="aep-local-footage"]').getAttribute("content");
  const status = async (t: string) =>
    (
      await fetch(new URL("/__aep/footage/locate", page.url()), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: t, paths: [] }),
      })
    ).status;
  const [wrong, right] = [await status("wrong"), await status(token ?? "")];
  console.log(`local footage: token ${token ? "present" : "missing"}, wrong token -> ${wrong}, right token -> ${right}`);

  await page.locator('input[aria-label="Open After Effects project"]').setInputFiles(project);
  const canvas = page.locator(".comp-canvas").first();
  await canvas.waitFor({ state: "attached", timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>(".comp-canvas")?.dataset.complete === "true", undefined, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const notes = (await page.locator(".render-notes").allInnerTexts()).join(" | ").trim();
  console.log(`render notes: ${notes || "(none)"}`);
  const pixels = await page.evaluate(() => {
    const source = document.querySelector<HTMLCanvasElement>(".comp-canvas")!;
    const probe = document.createElement("canvas");
    probe.width = source.width;
    probe.height = source.height;
    const ctx = probe.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, probe.width, probe.height);
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 24) lit++;
    return { width: probe.width, height: probe.height, lit, share: lit / (probe.width * probe.height) };
  });
  console.log(`viewer: ${pixels.width}x${pixels.height}, ${(pixels.share * 100).toFixed(2)}% of pixels lit`);

  // The composition menu, which creates layers and solids, on the pasteboard around the comp.
  const pasteboard = page.locator(".pasteboard");
  const box = await pasteboard.boundingBox();
  const menu = page.getByRole("menuitem", { name: /^New/ });
  let opened = false;
  let newSolid = false;
  if (box) {
    await page.mouse.click(box.x + 8, box.y + 8, { button: "right" });
    await menu.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    opened = await menu.isVisible().catch(() => false);
    if (opened) {
      await menu.hover();
      await page.waitForTimeout(200);
      newSolid = await page.getByRole("menuitem", { name: /^Solid\.\.\./ }).isVisible().catch(() => false);
    }
    await page.keyboard.press("Escape");
  }
  console.log(`viewer context menu: ${opened ? "open" : "missing"}, New > Solid ${newSolid ? "present" : "missing"}`);

  mkdirSync("refs/probe", { recursive: true });
  await page.screenshot({ path: "refs/probe/desktop-app.png" });
  console.log("screenshot: refs/probe/desktop-app.png");

  if (!token || wrong !== 403 || right !== 200) errors.push("the local footage service did not answer as expected");
  if (notes.includes("Render failed")) errors.push(`the viewer reported: ${notes}`);
  if (pixels.share < 0.001) errors.push("the viewer drew an empty frame");
  if (!newSolid) errors.push("the composition context menu has no New > Solid");
}

if (portable) {
  if (!exe) throw new Error("--portable needs --exe");
  const { page, close } = await launchPortable(exe);
  try {
    await verify(page);
  } finally {
    await close();
  }
} else {
  const app = await electron.launch({
    ...(exe ? { executablePath: exe } : { args: ["."] }),
    env: { ...process.env, AEP_WEB_SOFTWARE_GL: "1" },
    timeout: 120_000,
  });
  try {
    await verify(await app.firstWindow());
  } finally {
    await app.close();
  }
}

if (errors.length) {
  console.error(`FAIL\n${errors.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("PASS");
}
