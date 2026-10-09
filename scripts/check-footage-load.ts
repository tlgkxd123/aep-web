// Measures how long footage takes to show in the running dev server's app (headless Edge, real GPU): from
// opening a project to the first complete frame of a composition, then after each jump of the playhead to
// the given times (typed into the timeline's current time display, as when jumping around a comp).
//
//   node scripts/check-footage-load.ts <project.aep> <comp name> <seconds,seconds,...> [http://localhost:5173]
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { parseProject } from "../src/aep/parse.ts";

const [path, compName, timesArg = "", base = "http://localhost:5173"] = process.argv.slice(2);
if (!path || !compName) throw new Error("usage: node scripts/check-footage-load.ts <project.aep> <comp name> <seconds,...> [url]");
const bytes = readFileSync(path);
const comp = [...parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).items.values()].find(
  (i) => i.kind === "comp" && i.name === compName,
);
if (comp?.kind !== "comp") throw new Error(`no composition named ${compName}`);
const rate = comp.frameRate;
const timecode = (t: number) => {
  const frames = Math.round(t * rate);
  const fps = Math.round(rate);
  const s = Math.floor(frames / fps);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(frames % fps)}`;
};

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(base);
// Every frame the viewer shows, with the render notes on screen at the time.
await page.evaluate(() => {
  const w = window as any;
  w.__log = [];
  const tick = () => {
    const canvas = document.querySelector<HTMLCanvasElement>(".comp-canvas");
    const notes = [...document.querySelectorAll(".render-notes")].map((n) => n.textContent ?? "").join(" | ");
    const entry = { t: performance.now(), frame: canvas?.dataset.frame ?? "", complete: canvas?.dataset.complete === "true", notes };
    const last = w.__log[w.__log.length - 1];
    if (!last || last.frame !== entry.frame || last.complete !== entry.complete || last.notes !== entry.notes) w.__log.push(entry);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const now = () => page.evaluate(() => performance.now());
const stats = () => page.evaluate(() => JSON.parse(JSON.stringify((window as any).aepFootage?.stats ?? {})));
/** Waits for the viewer to show `frame` (any frame when undefined) complete; the ms it took and the footage notes seen meanwhile. */
const settle = async (since: number, frame?: number) => {
  await page.waitForFunction(
    (f) => {
      const c = document.querySelector<HTMLCanvasElement>(".comp-canvas");
      return !!c && c.dataset.complete === "true" && (f === undefined || c.dataset.frame === String(f));
    },
    frame,
    { timeout: 120000, polling: "raf" },
  );
  const log: { t: number; frame: string; complete: boolean; notes: string }[] = await page.evaluate(() => (window as any).__log);
  const done = log.filter((e) => e.t >= since && e.complete && (frame === undefined || e.frame === String(frame)))[0]?.t ?? (await now());
  const loading = new Set<string>();
  for (const e of log) if (e.t >= since && e.t <= done) for (const m of e.notes.match(/footage is loading \([^)]*\)/g) ?? []) loading.add(m.slice(20, -1));
  return { ms: done - since, loading: [...loading] };
};

const start = await now();
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
const escaped = compName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const row = page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${escaped}$`) }) }).first();
for (let pass = 0; pass < 300 && !(await row.count()); pass++) {
  const closed = page.locator(".proj-row .twirl:not(.open)");
  if (await closed.count()) await closed.first().click();
  else await page.waitForTimeout(50);
}
await row.dblclick();
const first = await settle(start);
const files = await page.evaluate(() => (window as any).aepFootage?.size ?? 0);
console.log(`open project -> first complete frame: ${first.ms.toFixed(0)} ms (${files} files located; waited on ${first.loading.join(", ") || "nothing"})`);

let before = await stats();
for (const t of timesArg.split(",").filter(Boolean).map(Number)) {
  await page.locator(".tl-timecode").first().click();
  const input = page.locator(".tl-timecode-input");
  await input.fill(timecode(t));
  const since = await now();
  await input.press("Enter");
  const frame = Math.round(t * rate);
  const jump = await settle(since, frame);
  const after = await stats();
  const d = (k: string) => (after.decoder?.[k] ?? 0) - (before.decoder?.[k] ?? 0);
  const runs = (after.videoRuns ?? 0) - (before.videoRuns ?? 0);
  const runMs = (after.videoMs ?? 0) - (before.videoMs ?? 0);
  console.log(
    `jump to ${timecode(t)} (frame ${frame}): ${jump.ms.toFixed(0)} ms; ${runs} decode runs (${(runMs / Math.max(1, runs)).toFixed(0)} ms each), resets ${d("resets")}, fed ${d("fed")}, frames ${d("frames")}, convert ${d("convertMs").toFixed(0)} ms, wait ${d("waitMs").toFixed(0)} ms; waited on ${jump.loading.join(", ") || "nothing"}`,
  );
  before = after;
}
await browser.close();
