// Plays a composition in the running dev server's app (headless Edge, real GPU) and
// records every displayed frame: the frame the viewer shows, whether it was complete and a
// fingerprint of the viewer canvas. Reports the frame rate shown, skipped frames, frames shown
// while footage was loading and frames that flicker (a fingerprint that jumps away and comes back).
//
//   node scripts/check-video-playback.ts <project.aep> <comp name> [seconds=8] [start seconds=0] [http://localhost:5173]
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const [path, compName, secondsArg = "8", startArg = "0", base = "http://localhost:5173"] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console error:", m.text().slice(0, 300)));
await page.goto(base);
console.log(
  "gpu:",
  await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl && info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "none";
  }),
);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
// Footage loads from disk through the dev server.
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(1000);
  const state = await page.evaluate(() => {
    const store = (window as any).aepFootage;
    return store ? { size: store.size, busy: store.busy } : null;
  });
  if (state && state.size > 0 && !state.busy && i > 5) break;
}
for (let pass = 0; pass < 300; pass++) {
  const closed = page.locator(".proj-row .twirl:not(.open)");
  if (!(await closed.count())) break;
  await closed.first().click();
}
await page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${compName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`) }) }).first().dblclick();
await page.waitForTimeout(1500);
const fps = await page.evaluate(() => {
  const label = document.querySelector(".comp-svg")?.getAttribute("aria-label") ?? "";
  return label;
});
console.log("viewer:", fps);
const start = Number(startArg);
if (start > 0) {
  // The Project panel row keeps focus after the double click and takes PageDown for itself.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Home");
  // Ten frames per press until the viewer's timecode (h:mm:ss:ff) reaches the start second.
  const seconds = async () => {
    const [h, m, s] = ((await page.locator(".comp-svg").getAttribute("aria-label"))?.split(" at ").pop() ?? "").split(":").map(Number);
    return h * 3600 + m * 60 + s;
  };
  for (let i = 0; i < 100000 && (await seconds()) < Math.floor(start); i++) await page.keyboard.press("Shift+PageDown");
  // Playback plays from the start of the work area (Play From: Start): B moves it to the current time.
  await page.keyboard.press("b");
  await page.waitForTimeout(3000);
}

// NOPIXELS=1 records only the frames shown: reading pixels back waits for the GPU and slows playback down.
await page.evaluate((pixels) => {
  const w = window as any;
  w.__samples = [];
  w.__pixels = pixels;
  const probe = document.createElement("canvas");
  probe.width = 48;
  probe.height = 27;
  const ctx = probe.getContext("2d", { willReadFrequently: true })!;
  // A small bitmap of the canvas, made off the main thread, so sampling does not slow playback down.
  let sampling = false;
  w.__shown = [];
  w.__rafs = [];
  const tick = () => {
    w.__rafs.push(performance.now());
    const canvas = document.querySelector<HTMLCanvasElement>(".comp-canvas");
    const at = canvas?.dataset.frame;
    if (at && w.__shown[w.__shown.length - 1]?.at !== at) w.__shown.push({ t: performance.now(), at, complete: canvas!.dataset.complete !== "false" });
    if (w.__pixels && canvas && canvas.width > 1 && canvas.dataset.frame && !sampling) {
      sampling = true;
      const sample = { t: performance.now(), at: canvas.dataset.frame, notes: canvas.dataset.complete === "false" ? "loading" : "", cells: [] as number[] };
      void createImageBitmap(canvas, { resizeWidth: 48, resizeHeight: 27, resizeQuality: "low" })
        .then((bitmap) => {
          ctx.clearRect(0, 0, 48, 27);
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          const d = ctx.getImageData(0, 0, 48, 27).data;
          for (let i = 0; i < d.length; i += 4) sample.cells.push(Math.round((d[i] + d[i + 1] + d[i + 2]) / 3));
          w.__samples.push(sample);
        })
        .finally(() => (sampling = false));
    }
    if (w.__sampling) requestAnimationFrame(tick);
  };
  w.__sampling = true;
  requestAnimationFrame(tick);
}, !process.env.NOPIXELS);
await page.evaluate(() => {
  const stats = (window as any).aepFootage.stats;
  Object.assign(stats, { imageDecodes: 0, imageMs: 0, videoRuns: 0, videoMs: 0, evictions: 0 });
  Object.assign(stats.decoder, { resets: 0, fed: 0, frames: 0, convertMs: 0, waitMs: 0 });
});
// Every footage frame the renderer asks for, by item, to see each movie's access pattern.
await page.evaluate(() => {
  const store = (window as any).aepFootage;
  const original = store.frame.bind(store);
  const log: Record<string, number[]> = {};
  (window as any).__requests = log;
  store.frame = (item: { name: string; id: number }, index: number) => {
    (log[`${item.name}#${item.id}`] ??= []).push(index);
    return original(item, index);
  };
});
const cdp = process.env.PROFILE ? await page.context().newCDPSession(page) : undefined;
if (cdp) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
}
await page.keyboard.press("Space");
await page.waitForTimeout(Number(secondsArg) * 1000);
await page.keyboard.press("Space");
if (cdp) {
  const { profile } = (await cdp.send("Profiler.stop")) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }[]; samples: number[]; timeDeltas: number[] } };
  // Self time per function, from sample time deltas.
  const self = new Map<number, number>();
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const byName = new Map<string, number>();
  for (const node of profile.nodes) {
    const f = node.callFrame;
    const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()?.split("?")[0]}:${f.lineNumber + 1}`;
    byName.set(key, (byName.get(key) ?? 0) + (self.get(node.id) ?? 0) / 1000);
  }
  const top = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log("main-thread self time (ms):\n" + top.map(([k, v]) => `  ${v.toFixed(0).padStart(6)}  ${k}`).join("\n"));
}
console.log("footage store work:", JSON.stringify(await page.evaluate(() => (window as any).aepFootage.stats)));
const requests: Record<string, number[]> = await page.evaluate(() => (window as any).__requests);for (const [name, list] of Object.entries(requests)) {
  const distinct = [...new Set(list)];
  const backwards = distinct.filter((v, i) => i > 0 && v < distinct[i - 1]).length;
  console.log(`  requests ${name}: ${list.length} calls, ${distinct.length} frames, ${backwards} backward jumps, first ${distinct.slice(0, 12).join(",")}`);
}
const { samples, shown, rafs }: { samples: { t: number; at: string; notes: string; cells: number[] }[]; shown: { t: number; at: string; complete: boolean }[]; rafs: number[] } =
  await page.evaluate(() => {
    const w = window as any;
    w.__sampling = false;
    return { samples: w.__samples, shown: w.__shown, rafs: w.__rafs };
  });
await browser.close();
const gaps = rafs.slice(1).map((t, i) => t - rafs[i]);
console.log(`${rafs.length} animation frames, longest gap ${Math.max(0, ...gaps).toFixed(0)} ms, ${gaps.filter((g) => g > 50).length} gaps over 50 ms`);

// Consecutive samples of the same playhead are the same frame; keep the last image of each.
const frames: typeof samples = [];
for (const s of samples) {
  if (frames.length && frames[frames.length - 1].at === s.at) frames[frames.length - 1] = s;
  else frames.push(s);
}
const dist = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
let loading = 0;
const flickers: string[] = [];
frames.forEach((f, i) => {
  if (/loading/i.test(f.notes)) loading++;
  if (i === 0 || i === frames.length - 1) return;
  const prev = frames[i - 1].cells;
  const next = frames[i + 1].cells;
  const away = Math.min(dist(f.cells, prev), dist(f.cells, next));
  const across = dist(prev, next);
  if (away > 4 && away > 3 * across) flickers.push(`${f.at} (off by ${away.toFixed(1)}, neighbours differ by ${across.toFixed(1)})`);
});
const span = shown.length ? (shown[shown.length - 1].t - shown[0].t) / 1000 : 0;
let skipped = 0;
for (let i = 1; i < shown.length; i++) {
  const gap = Number(shown[i].at) - Number(shown[i - 1].at);
  if (gap > 1) skipped += gap - 1;
}
console.log(`${shown.length} frames shown over ${span.toFixed(1)} s (${(shown.length / Math.max(span, 1e-3)).toFixed(1)} per second), ${skipped} frames skipped; ${samples.length} pixel samples`);
console.log(`frames shown while footage was loading: ${loading} sampled, ${shown.filter((s) => !s.complete).length} of the frames shown`);
console.log(`flickering frames (${flickers.length}): ${flickers.slice(0, 30).join("; ")}`);
const notes = [...new Set(frames.map((f) => f.notes).filter(Boolean))];
console.log(`render notes seen: ${notes.slice(0, 8).join(" || ")}`);
mkdirSync("refs/probe", { recursive: true });
writeFileSync(`refs/probe/playback-${compName.replace(/\W+/g, "_")}.json`, JSON.stringify(frames.map((f) => ({ at: f.at, notes: f.notes, mean: f.cells.reduce((a, b) => a + b, 0) / f.cells.length }))));
