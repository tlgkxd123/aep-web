// Plays compositions in the app (headless Edge, real GPU) and records every displayed frame: the frame the
// viewer shows, whether it was complete and a fingerprint of the viewer canvas. Reports the frame rate shown,
// skipped frames, frames shown while footage was loading, frames that flicker (a fingerprint that jumps away
// and comes back), and how the preview audio played: how often it started and stopped, and how far the
// picture was from it.
//
//   node scripts/check-video-playback.ts <project.aep> <comp name[,comp name...]> [seconds=8] [start seconds=0]
//     [--serve | --base http://localhost:5173] [--throttle <cpu slowdown>] [--require-fps <n>] [--require-audio]
//     [--discrete] [--bench <frames>] [--require-smooth <ms>] [--max-drift <frames>]
//
// --serve starts a dev server for the run. NOPIXELS=1 records only the frames shown (reading pixels back waits
// for the GPU and slows playback down); --require-* imply it. PROFILE=1 prints main-thread self time, TRACE=1
// writes a Chrome trace (see trace-summary.ts). --discrete runs on the high-performance GPU of a dual-GPU
// machine. --bench renders that many consecutive frames instead of playing, timing each once its footage has
// loaded (STAGES=1 adds the time per render stage).
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1] !== undefined && !argv[at + 1].startsWith("--") ? argv[at + 1] : "";
  argv.splice(at, value === "" ? 1 : 2);
  return value;
};
const serve = flag("--serve") !== undefined;
const baseFlag = flag("--base");
const throttle = Number(flag("--throttle") ?? 1);
const requireFps = flag("--require-fps");
const requireAudio = flag("--require-audio") !== undefined;
const requireSmooth = flag("--require-smooth");
/** Comp frames the picture may be from the sound with --require-audio. */
const maxDrift = Number(flag("--max-drift") ?? 2);
const verifySpectra = flag("--verify-spectra") !== undefined;
const bench = flag("--bench");
const discrete = flag("--discrete") !== undefined;
const [path, compList, secondsArg = "8", startArg = "0", basePositional] = argv;
const compNames = compList.split(",").map((s) => s.trim()).filter(Boolean);
const pixels = !process.env.NOPIXELS && requireFps === undefined && !requireAudio && requireSmooth === undefined;

let server: ViteDevServer | undefined;
let base = baseFlag || basePositional || "http://localhost:5173";
if (serve) {
  server = await createServer({ configFile: "vite.config.ts", logLevel: "error", server: { port: 5191, strictPort: false } });
  await server.listen();
  base = server.resolvedUrls!.local[0];
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--use-angle=d3d11",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--autoplay-policy=no-user-gesture-required",
    ...(process.env.TRACE === "calls" ? ["--enable-gpu-service-tracing"] : []),
    ...(discrete ? ["--force-high-performance-gpu"] : []),
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log("console error:", m.text().slice(0, 300)));
await page.goto(base, { timeout: 180_000 });
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
const cdp = await page.context().newCDPSession(page);
if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });

async function startProfile(): Promise<void> {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
}

/** Main-thread self time per function since startProfile, with the callers of the costliest few. */
async function printProfile(): Promise<void> {
  type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
  const { profile } = (await cdp.send("Profiler.stop")) as { profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] } };
  const self = new Map<number, number>();
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const parent = new Map<number, Node>();
  for (const node of profile.nodes) for (const c of node.children ?? []) parent.set(c, node);
  const name = (f: Node["callFrame"]) => `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()?.split("?")[0]}:${f.lineNumber + 1}`;
  const byName = new Map<string, number>();
  const stacks = new Map<string, Map<string, number>>();
  for (const node of profile.nodes) {
    const ms = (self.get(node.id) ?? 0) / 1000;
    if (!ms) continue;
    const key = name(node.callFrame);
    byName.set(key, (byName.get(key) ?? 0) + ms);
    const chain: string[] = [];
    for (let p = parent.get(node.id); p && chain.length < 6; p = parent.get(p.id)) chain.push(name(p.callFrame).replace(/ \S+:\d+$/, ""));
    const callers = stacks.get(key) ?? stacks.set(key, new Map()).get(key)!;
    callers.set(chain.join(" < "), (callers.get(chain.join(" < ")) ?? 0) + ms);
  }
  const top = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log("main-thread self time (ms):\n" + top.map(([k, v]) => `  ${v.toFixed(0).padStart(6)}  ${k}`).join("\n"));
  for (const [k] of top.filter(([k]) => !k.startsWith("(")).slice(0, 4)) {
    const [chain, ms] = [...stacks.get(k)!].sort((a, b) => b[1] - a[1])[0];
    console.log(`  ${k} mostly from (${ms.toFixed(0)} ms): ${chain}`);
  }
}

let failed = false;
for (const compName of compNames) {
  await page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${compName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`) }) }).first().dblclick();
  await page.waitForTimeout(1500);
  const label = (await page.locator(".comp-svg").getAttribute("aria-label")) ?? "";
  console.log(`\n== ${compName}: viewer ${label}`);
  const frameRate = await page.evaluate(() => Number(document.querySelector<HTMLElement>(".tl-frames")?.textContent?.match(/\(([\d.]+) fps\)/)?.[1] ?? 0));
  console.log("viewer notes:", await page.evaluate(() => document.querySelector(".render-notes")?.textContent ?? "(none)"));
  console.log(
    "viewer settings:",
    JSON.stringify(
      await page.evaluate(async () => {
        const v = await import(/* @vite-ignore */ "/src/playback/viewer.ts" as string);
        let id = 0;
        while (id < 1e5 && !v.getViewer(id)) id++;
        return { comp: id, fastPreviews: v.fastPreviews.adaptive, zoom: v.viewerZooms.get(id), factor: v.viewerFactors.get(id) };
      }),
    ),
  );
  const start = Number(startArg);
  // The Project panel row keeps focus after the double click and takes keys for itself.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Home");
  if (start > 0) {
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

  const stopTrace = async () => {
    const file = `refs/probe/trace-${compName.replace(/\W+/g, "_")}.json`;
    writeFileSync(file, await browser.stopTracing());
    console.log(`trace written to ${file}`);
  };
  const startTrace = () =>
    browser.startTracing(page, {
      categories: ["toplevel", "gpu", "viz", "cc", "benchmark", "blink", "media", "v8.execute", "disabled-by-default-devtools.timeline", "disabled-by-default-gpu.service", "disabled-by-default-gpu.device", "disabled-by-default-gpu.decoder"],
    });
  if (bench !== undefined) {
    if (process.env.PROFILE) await startProfile();
    if (process.env.TRACE) await startTrace();
    // Consecutive frames rendered by the viewer once what they need has loaded: CPU time of the render call, and
    // with the GPU work finished.
    const { rows, stages }: { rows: { frame: number; waitMs: number; cpuMs: number; gpuMs: number }[]; stages: [string, number, number][] } = await page.evaluate(
      async ([count, staged, factor]) => {
        const { getViewer } = await import(/* @vite-ignore */ "/src/playback/viewer.ts" as string);
        const canvas = document.querySelector<HTMLCanvasElement>(".comp-canvas")!;
        const first = Number(canvas.dataset.frame ?? 0);
        let viewer: any;
        for (let id = 0; id < 1e5 && !viewer; id++) viewer = getViewer(id);
        if (factor) viewer.attach(viewer.project, viewer.comp, factor);
        const out = [];
        const profile = new Map<string, { ms: number; count: number }>();
        // The panel re-attaches its viewer at the comp's resolution and shows the paused frame again whenever
        // footage arrives; those renders would compete with the ones measured.
        const attach = () => factor && viewer.attach(viewer.project, viewer.comp, factor);
        viewer.show = () => "same";
        for (let f = first; f < first + count; f++) {
          const waiting = performance.now();
          for (let i = 0; i < 400 && (attach(), !viewer.prefetch(f)); i++) await new Promise((r) => setTimeout(r, 25));
          const waitMs = performance.now() - waiting;
          attach();
          // gl.finish() is only a flush in Chrome: reading a pixel back waits for the GPU.
          const sync = () => viewer.renderer.readPixel(viewer.last.target, 0, 0);
          sync();
          if (staged) viewer.renderer.profile = profile;
          const started = performance.now();
          viewer["render"](f).bitmap.close();
          const cpuMs = performance.now() - started;
          sync();
          viewer.renderer.profile = null;
          out.push({ frame: f, waitMs, cpuMs, gpuMs: performance.now() - started });
        }
        // GL calls reaching the browser in one more render, by method.
        const proto = Object.getPrototypeOf(viewer.renderer.gl);
        const calls = new Map<string, number>();
        const originals = new Map<string, Function>();
        for (const name of Object.getOwnPropertyNames(proto)) {
          const descriptor = Object.getOwnPropertyDescriptor(proto, name);
          const fn = descriptor?.value;
          if (typeof fn !== "function" || name === "constructor") continue;
          originals.set(name, fn);
          proto[name] = function (this: unknown, ...a: unknown[]) {
            calls.set(name, (calls.get(name) ?? 0) + 1);
            return fn.apply(this, a);
          };
        }
        attach();
        viewer["render"](first + count).bitmap.close();
        for (const [name, fn] of originals) proto[name] = fn;
        calls.set("(all)", [...calls.values()].reduce((a, b) => a + b, 0));
        const stages = [...profile].map(([k, v]): [string, number, number] => [k, v.ms / count, v.count / count]).sort((a, b) => b[1] - a[1]);
        for (const [name, n] of [...calls].sort((a, b) => b[1] - a[1]).slice(0, 14)) stages.push([`gl.${name}`, n, 1]);
        return { rows: out, stages };
      },
      [Number(bench || 30), !!process.env.STAGES, Number(process.env.FACTOR ?? 0)] as const,
    );
    for (const r of rows) console.log(`  frame ${r.frame}: ready after ${r.waitMs.toFixed(0)} ms, render ${r.cpuMs.toFixed(1)} ms cpu, ${r.gpuMs.toFixed(1)} ms with the GPU`);
    for (const [stage, ms, n] of stages.slice(0, 16)) console.log(`  ${ms.toFixed(1).padStart(8)} ms ${n.toFixed(0).padStart(4)}x  ${stage}`);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    console.log(`${compName}: median render ${median(rows.map((r) => r.cpuMs)).toFixed(1)} ms cpu, ${median(rows.map((r) => r.gpuMs)).toFixed(1)} ms with the GPU`);
    if (process.env.PROFILE) await printProfile();
    if (process.env.TRACE) await stopTrace();
    continue;
  }
  await page.evaluate((pixels) => {
    const w = window as any;
    w.__samples = [];
    w.__pixels = pixels;
    w.__drift = [];
    const probe = document.createElement("canvas");
    probe.width = 48;
    probe.height = 27;
    const ctx = probe.getContext("2d", { willReadFrequently: true })!;
    // A small bitmap of the canvas, made off the main thread, so sampling does not slow playback down.
    let sampling = false;
    w.__shown = [];
    w.__rafs = [];
    const tick = () => {
      const now = performance.now();
      w.__rafs.push(now);
      const canvas = document.querySelector<HTMLCanvasElement>(".comp-canvas");
      const at = canvas?.dataset.frame;
      if (at && w.__shown[w.__shown.length - 1]?.at !== at) {
        w.__shown.push({ t: now, at, complete: canvas!.dataset.complete !== "false" });
        // How far the picture is from the sound: the audio clock's comp time against the frame now shown.
        const audio = w.aepAudio?.position?.();
        if (typeof audio === "number") w.__drift.push({ t: now, frame: Number(at), audio });
      }
      if (w.__pixels && canvas && canvas.width > 1 && canvas.dataset.frame && !sampling) {
        sampling = true;
        const sample = { t: now, at: canvas.dataset.frame, notes: canvas.dataset.complete === "false" ? "loading" : "", cells: [] as number[] };
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
  }, pixels);
  await page.evaluate(() => {
    const w = window as any;
    const stats = w.aepFootage.stats;
    Object.assign(stats, { imageDecodes: 0, imageMs: 0, videoRuns: 0, videoMs: 0, evictions: 0 });
    Object.assign(stats.decoder, { resets: 0, fed: 0, frames: 0, convertMs: 0, waitMs: 0 });
    w.aepAudio?.resetStats?.();
    for (const stats of [w.aepSpectra, w.aepViewer]) if (stats) for (const k of Object.keys(stats)) if (typeof stats[k] === "number") stats[k] = 0;
    // Every footage frame the renderer asks for, by item, to see each movie's access pattern.
    const store = w.aepFootage;
    const original = store.__frame ?? store.frame.bind(store);
    store.__frame = original;
    const log: Record<string, number[]> = {};
    w.__requests = log;
    store.frame = (item: { name: string; id: number }, index: number) => {
      (log[`${item.name}#${item.id}`] ??= []).push(index);
      return original(item, index);
    };
  });
  if (process.env.PROFILE) await startProfile();
  await page.evaluate((verify) => {
    const spectra = (window as any).aepSpectra;
    if (spectra) spectra.verify = verify;
  }, verifySpectra);
  if (process.env.TRACE) await startTrace();
  await page.keyboard.press("Space");
  await page.waitForTimeout(1000);
  console.log(
    "viewer while playing:",
    JSON.stringify(
      await page.evaluate(async () => {
        const v = await import(/* @vite-ignore */ "/src/playback/viewer.ts" as string);
        let id = 0;
        while (id < 1e5 && !v.getViewer(id)) id++;
        const viewer = v.getViewer(id) as any;
        return { factor: viewer?.factor, gpuMs: viewer?.gpuMs, samples: viewer?.gpuSamples, queue: viewer?.gpuQueue() };
      }),
    ),
  );
  await page.waitForTimeout(Number(secondsArg) * 1000 - 1000);
  console.log(
    "viewer at the end:",
    JSON.stringify(
      await page.evaluate(async () => {
        const v = await import(/* @vite-ignore */ "/src/playback/viewer.ts" as string);
        let id = 0;
        while (id < 1e5 && !v.getViewer(id)) id++;
        const viewer = v.getViewer(id) as any;
        return { factor: viewer?.factor, gpuMs: viewer?.gpuMs, samples: viewer?.gpuSamples };
      }),
    ),
  );
  // Read the audio counters while still playing: stopping playback stops the audio.
  const audio: { starts: number; stops: number } | null = await page.evaluate(() => (window as any).aepAudio?.stats ?? null);
  // Animation frames count while playing; stopping renders the frame shown again at the comp's resolution.
  await page.evaluate(() => ((window as any).__stopAt = performance.now()));
  await page.keyboard.press("Space");
  if (process.env.TRACE) await stopTrace();
  if (process.env.PROFILE) await printProfile();
  console.log("footage store work:", JSON.stringify(await page.evaluate(() => (window as any).aepFootage.stats)));
  const spectra: { computed: number; fromWorkers: number; hits: number; verified: number; mismatches: number } | null = await page.evaluate(() => {
    const s = (window as any).aepSpectra;
    return s ? { ...s } : null;
  });
  if (spectra) console.log("audio spectra:", JSON.stringify(spectra));
  const viewer = await page.evaluate(() => (window as any).aepViewer && { ...(window as any).aepViewer });
  if (viewer) {
    console.log(
      `viewer renders: ${viewer.renders}, incomplete ${viewer.incomplete} (footage ${viewer.waitingFootage}, spectra ${viewer.waitingSpectra}, unknown ${viewer.waitingUnknown}), ${(viewer.renderMs / Math.max(1, viewer.renders)).toFixed(1)} ms each; rendering ahead stopped for a full GPU queue ${viewer.aheadGpuFull} times, for footage ${viewer.aheadFootage}`,
    );
  }
  if (verifySpectra) {
    const ok = !!spectra && spectra.verified > 0 && spectra.mismatches === 0;
    if (!ok) failed = true;
    console.log(`${compName}: ${ok ? "SPECTRA-IDENTICAL" : "SPECTRA-DIFFERENT"} verified=${spectra?.verified ?? 0} mismatches=${spectra?.mismatches ?? "?"}`);
  }
  const requests: Record<string, number[]> = await page.evaluate(() => (window as any).__requests);
  for (const [name, list] of Object.entries(requests)) {
    const distinct = [...new Set(list)];
    const backwards = distinct.filter((v, i) => i > 0 && v < distinct[i - 1]).length;
    console.log(`  requests ${name}: ${list.length} calls, ${distinct.length} frames, ${backwards} backward jumps, first ${distinct.slice(0, 12).join(",")}`);
  }
  const { samples, shown, rafs, drift }: {
    samples: { t: number; at: string; notes: string; cells: number[] }[];
    shown: { t: number; at: string; complete: boolean }[];
    rafs: number[];
    drift: { t: number; frame: number; audio: number }[];
  } = await page.evaluate(() => {
    const w = window as any;
    w.__sampling = false;
    return { samples: w.__samples, shown: w.__shown, rafs: w.__rafs.filter((t: number) => t <= w.__stopAt), drift: w.__drift };
  });
  const gaps = rafs.slice(1).map((t, i) => t - rafs[i]);
  const longest = gaps.reduce((m, g) => Math.max(m, g), 0);
  console.log(`${rafs.length} animation frames, longest gap ${longest.toFixed(0)} ms, ${gaps.filter((g) => g > 50).length} gaps over 50 ms`);
  const startedAt = shown[0]?.t ?? rafs[0] ?? 0;
  const late = gaps.map((g, i) => [g, rafs[i] - startedAt] as const).filter(([g]) => g > 50);
  if (late.length) console.log(`  gaps over 50 ms (ms at s after the first frame): ${late.map(([g, t]) => `${g.toFixed(0)}@${(t / 1000).toFixed(2)}`).join(" ")}`);
  if (requireSmooth !== undefined) {
    // Once the sound plays: before that, playback renders its first frames (and Fast Previews settles).
    const soundAt = drift[0]?.t ?? startedAt;
    const playing = gaps.filter((_, i) => rafs[i] >= soundAt);
    const worstPlaying = playing.reduce((m, g) => Math.max(m, g), 0);
    const ok = playing.length > 0 && worstPlaying <= Number(requireSmooth);
    if (!ok) failed = true;
    console.log(
      `${compName}: ${ok ? "UI-RESPONSIVE-OK" : "UI-STALLED"} longest gap between animation frames once the sound started ${worstPlaying.toFixed(0)} ms (limit ${requireSmooth}; ${((soundAt - startedAt) / 1000).toFixed(2)} s after the first frame)`,
    );
  }

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
  // The first frame shows when playback starts; the rate counts the frames after it over the time they took.
  const playing = shown.slice(1);
  const span = playing.length > 1 ? (playing[playing.length - 1].t - shown[0].t) / 1000 : 0;
  const fps = playing.length / Math.max(span, 1e-3);
  let skipped = 0;
  for (let i = 1; i < shown.length; i++) {
    const gap = Number(shown[i].at) - Number(shown[i - 1].at);
    if (gap > 1) skipped += gap - 1;
  }
  const incomplete = shown.filter((s) => !s.complete).length;
  console.log(`${shown.length} frames shown over ${span.toFixed(1)} s (${fps.toFixed(1)} per second), ${skipped} frames skipped; ${samples.length} pixel samples`);
  console.log(`frames shown while footage was loading: ${loading} sampled, ${incomplete} of the frames shown`);
  if (pixels) console.log(`flickering frames (${flickers.length}): ${flickers.slice(0, 30).join("; ")}`);
  const notes = [...new Set(frames.map((f) => f.notes).filter(Boolean))];
  if (notes.length) console.log(`render notes seen: ${notes.slice(0, 8).join(" || ")}`);
  if (requireFps !== undefined) {
    const ok = fps >= Number(requireFps) && incomplete === 0 && shown.length > 1;
    if (!ok) failed = true;
    console.log(`${compName}: ${ok ? "PLAYBACK-FPS-OK" : "PLAYBACK-FPS-LOW"} ${fps.toFixed(1)} fps (need ${requireFps}), ${incomplete} incomplete`);
  }
  if (requireAudio) {
    // Drift after the first half second, once the sound has started, in frames of the comp.
    const settled = drift.filter((d) => shown.length && d.t - shown[0].t > 500);
    const worst = settled.reduce((m, d) => Math.max(m, Math.abs(d.audio * frameRate - d.frame)), 0);
    const off = settled.filter((d) => Math.abs(d.audio * frameRate - d.frame) > maxDrift);
    if (off.length) {
      const at = (d: (typeof off)[number]) => `${(d.audio * frameRate - d.frame).toFixed(1)}@${((d.t - shown[0].t) / 1000).toFixed(2)}`;
      console.log(`  frames more than ${maxDrift} frames from the sound (frames at s): ${off.length}: ${off.slice(0, 20).map(at).join(" ")}`);
    }
    const ok = !!audio && audio.starts === 1 && audio.stops === 0 && settled.length > 0 && worst <= maxDrift;
    if (!ok) failed = true;
    console.log(
      `${compName}: ${ok ? "AUDIO-CONTINUOUS-OK" : "AUDIO-BROKEN"} starts=${audio?.starts ?? "?"} stops=${audio?.stops ?? "?"} drift=${worst.toFixed(2)} frames over ${settled.length} frames`,
    );
  }
  mkdirSync("refs/probe", { recursive: true });
  writeFileSync(`refs/probe/playback-${compName.replace(/\W+/g, "_")}.json`, JSON.stringify(frames.map((f) => ({ at: f.at, notes: f.notes, mean: f.cells.reduce((a, b) => a + b, 0) / f.cells.length }))));
  await page.waitForTimeout(500);
}
await browser.close();
await server?.close();
process.exit(failed ? 1 : 0);
