// Browser entry used by scripts/pixel-report.ts: loads a project and renders
// frames to straight-alpha RGBA, exposed on window.aepHarness.
import type { CompItem, Project } from "../aep/model.ts";
import { parseProject } from "../aep/parse.ts";
import { footageStore } from "../media/store.ts";
import { finishGpu, type Target } from "./gl.ts";
import type { RendererOptions } from "./registry.ts";
import { Renderer } from "./renderer.ts";

let project: Project | undefined;
let renderer: Renderer | undefined;
/** Renders without reusing layer images between frames, to compare against (compareReuse). */
let reference: Renderer | undefined;

/** Render passes allowed while footage frames are still arriving. */
const MAX_PASSES = 32;

/** A target's premultiplied pixels as stored (GL rows, border included). */
function raw(r: Renderer, target: Target): Uint8Array {
  const gl = r.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  const pixels = new Uint8Array(target.width * target.height * 4);
  gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const harness = {
  load(base64: string): string[] {
    project = parseProject(decodeBase64(base64));
    renderer ??= new Renderer(new OffscreenCanvas(16, 16));
    return project.warnings;
  },
  /** Changes renderer options (after `load`); the pixel suites keep the defaults. */
  setOptions(options: Partial<RendererOptions>): void {
    if (!renderer) throw new Error("load a project first");
    Object.assign(renderer.options, options);
  },
  /** Makes a footage file available, by its path relative to the project (e.g. "media/clip.mp4"). */
  addFile(path: string, base64: string): void {
    footageStore.addFiles([{ path, blob: new Blob([decodeBase64(base64) as BlobPart]) }]);
  },
  /** Resolves once no footage is decoding. */
  ready(): Promise<void> {
    return footageStore.idle();
  },
  /** Renders a frame, waiting for the footage frames it needs to decode. */
  async render(compName: string, time: number): Promise<{ width: number; height: number; pixels: string; warnings: string[] }> {
    if (!project || !renderer) throw new Error("load a project first");
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName);
    if (!comp) throw new Error(`no composition named ${compName}`);
    let target = renderer.render(project, comp, time);
    for (let pass = 1; pass < MAX_PASSES && footageStore.busy; pass++) {
      renderer.release(target);
      await footageStore.idle();
      target = renderer.render(project, comp, time);
    }
    const pixels = renderer.readPixels(target, comp.width, comp.height);
    renderer.release(target);
    return { width: comp.width, height: comp.height, pixels: encodeBase64(pixels), warnings: renderer.lastWarnings };
  },
  /**
   * Renders `times` (after one warm-up render each): ms per frame (GPU work included), then once more with the
   * stage profiler on for ms per stage. With `layers`, also how much each top-level layer adds to a frame (the
   * frame's time without it, subtracted).
   */
  async profile(
    compName: string,
    times: number[],
    options: { scale?: number; layers?: boolean } = {},
  ): Promise<{ frameMs: number[]; warmMs: number[]; coldMs: number[]; stages: [string, number, number][]; layers: [string, number][]; gpu: string }> {
    if (!project || !renderer) throw new Error("load a project first");
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName);
    if (!comp) throw new Error(`no composition named ${compName}`);
    const gl = renderer.gl;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
    const scale = options.scale ?? 1;
    const timedRender = (time: number) => {
      finishGpu(gl);
      const started = performance.now();
      renderer!.release(renderer!.render(project!, comp, time, { scale }));
      finishGpu(gl);
      return performance.now() - started;
    };
    const best = (time: number) => Math.min(timedRender(time), timedRender(time), timedRender(time));
    const frameMs: number[] = [];
    const warmMs: number[] = [];
    const coldMs: number[] = [];
    const stages = new Map<string, { ms: number; count: number }>();
    const layerMs = new Map<string, number>();
    for (const time of times) {
      const warming = performance.now();
      renderer.release(await harness.renderTarget(comp, time, scale));
      warmMs.push(performance.now() - warming);
      coldMs.push(harness.lastPassMs);
      const base = best(time);
      frameMs.push(base);
      renderer.profile = stages;
      renderer.release(renderer.render(project, comp, time, { scale }));
      renderer.profile = null;
      if (!options.layers) continue;
      for (const layer of comp.layers) {
        if (!layer.enabled) continue;
        layer.enabled = false;
        const without = best(time);
        layer.enabled = true;
        const key = `${layer.index} ${layer.name}`;
        layerMs.set(key, (layerMs.get(key) ?? 0) + (base - without) / times.length);
      }
    }
    const rows = [...stages].map(([k, v]): [string, number, number] => [k, v.ms / times.length, v.count / times.length]);
    rows.sort((a, b) => b[1] - a[1]);
    return { frameMs, warmMs, coldMs, stages: rows, layers: [...layerMs].sort((a, b) => b[1] - a[1]), gpu };
  },
  /**
   * Renders `count` consecutive frames of a comp from `start` seconds, each once with layer images reused between
   * frames and once by a renderer that renders every layer anew, and compares the premultiplied pixels exactly.
   */
  async compareReuse(
    compName: string,
    start: number,
    count: number,
  ): Promise<{ frames: number; different: { frame: number; bytes: number; worst: number }[]; incomplete: number; hits: number; misses: number; cachedMs: number; freshMs: number }> {
    if (!project || !renderer) throw new Error("load a project first");
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName);
    if (!comp) throw new Error(`no composition named ${compName}`);
    reference ??= new Renderer(new OffscreenCanvas(16, 16), renderer.options);
    reference.reuseLayers = false;
    const frame = comp.frameDuration || 1 / (comp.frameRate || 24);
    const first = Math.round(start / frame);
    const stats = renderer.reuseStats;
    const before = { ...stats };
    const different: { frame: number; bytes: number; worst: number }[] = [];
    let incomplete = 0;
    let cachedMs = 0;
    let freshMs = 0;
    for (let k = 0; k < count; k++) {
      const time = (first + k) * frame;
      const cached = await harness.renderTarget(comp, time);
      cachedMs += harness.lastPassMs;
      const a = raw(renderer, cached);
      renderer.release(cached);
      let started = performance.now();
      let fresh = reference.render(project, comp, time);
      for (let n = 1; n < MAX_PASSES && !reference.lastComplete; n++) {
        reference.release(fresh);
        await footageStore.idle();
        started = performance.now();
        fresh = reference.render(project, comp, time);
      }
      finishGpu(reference.gl);
      freshMs += performance.now() - started;
      if (!renderer.lastComplete || !reference.lastComplete) incomplete++;
      const b = raw(reference, fresh);
      reference.release(fresh);
      let bytes = 0;
      let worst = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d) {
          bytes++;
          worst = Math.max(worst, d);
        }
      }
      if (bytes || a.length !== b.length) different.push({ frame: first + k, bytes, worst });
    }
    return { frames: count, different, incomplete, hits: stats.hits - before.hits, misses: stats.misses - before.misses, cachedMs, freshMs };
  },
  /**
   * A frame rendered at 1/factor resolution against the full-resolution render averaged over factor x factor
   * blocks: mean error per channel (of 255, premultiplied) and the share of pixels off by more than 24 in a channel.
   */
  async compareScale(compName: string, time: number, factor: number): Promise<{ meanError: number; grossShare: number; scaledMs: number; fullMs: number }> {
    if (!project || !renderer) throw new Error("load a project first");
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName);
    if (!comp) throw new Error(`no composition named ${compName}`);
    const pad = 1;
    const full = await harness.renderTarget(comp, time, 1);
    const fullMs = harness.lastPassMs;
    const a = raw(renderer, full);
    const fw = full.width;
    renderer.release(full);
    const small = await harness.renderTarget(comp, time, 1 / factor);
    const scaledMs = harness.lastPassMs;
    const b = raw(renderer, small);
    const [sw, sh] = [small.width, small.height];
    renderer.release(small);
    const [w, h] = [comp.width, comp.height];
    const [rw, rh] = [sw - 2 * pad, sh - 2 * pad];
    let error = 0;
    let gross = 0;
    for (let t = 0; t < rh; t++) {
      for (let x = 0; x < rw; x++) {
        let worst = 0;
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let dy = 0; dy < factor; dy++) {
            const top = t * factor + dy;
            if (top >= h) continue;
            const row = h - 1 - top + pad;
            for (let dx = 0; dx < factor; dx++) {
              const col = x * factor + dx;
              if (col < w) sum += a[(row * fw + col + pad) * 4 + c];
            }
          }
          const d = Math.abs(sum / (factor * factor) - b[((rh - 1 - t + pad) * sw + x + pad) * 4 + c]);
          error += d;
          worst = Math.max(worst, d);
        }
        if (worst > 24) gross++;
      }
    }
    return { meanError: error / (rw * rh * 4), grossShare: gross / (rw * rh), scaledMs, fullMs };
  },
  /**
   * `count` consecutive full-resolution frames of a comp from `start` seconds through the Render Queue's GPU frame
   * source (as an MP4 export at Ultra fast or Decent quality takes them, encoder left out): where the time goes.
   */
  async exportFrames(compName: string, start: number, count: number): Promise<{ fps: number; stats: string }> {
    if (!project || !renderer) throw new Error("load a project first");
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName);
    if (!comp) throw new Error(`no composition named ${compName}`);
    const { framePlan } = await import("../export/settings.ts");
    const { newStats, rendererFrames, statsSummary } = await import("../export/pipeline.ts");
    const step = comp.frameDuration || 1 / (comp.frameRate || 24);
    const plan = framePlan(comp, { resolution: 1, timeSpan: "custom", customStart: start, customDuration: count * step, frameRate: null });
    const stats = newStats();
    const source = rendererFrames(renderer, project, comp, plan, undefined, stats);
    if (!source) throw new Error("this browser cannot take frames from the GPU");
    const started = performance.now();
    for (let i = 0; i < plan.frames; i++) (await source(plan.time(i), plan.width, plan.height, i, 1)).close();
    finishGpu(renderer.gl);
    return { fps: (plan.frames * 1000) / (performance.now() - started), stats: `${statsSummary(stats)}; footage ${JSON.stringify(footageStore.stats)}` };
  },
  /** Milliseconds (GPU work included) of renderTarget's last pass, the first with all footage decoded. */
  lastPassMs: 0,
  /** A rendered target once the footage it needs has decoded. */
  async renderTarget(comp: CompItem, time: number, scale = 1) {
    const pass = () => {
      const started = performance.now();
      const target = renderer!.render(project!, comp, time, { scale });
      finishGpu(renderer!.gl);
      harness.lastPassMs = performance.now() - started;
      return target;
    };
    let target = pass();
    for (let n = 1; n < MAX_PASSES && footageStore.busy; n++) {
      renderer!.release(target);
      await footageStore.idle();
      target = pass();
    }
    return target;
  },
  /** Composition names with their layer counts. */
  comps(): [string, number, number, number][] {
    if (!project) throw new Error("load a project first");
    return [...project.items.values()].flatMap((i) => (i.kind === "comp" ? [[i.name, i.layers.length, i.width, i.height] as [string, number, number, number]] : []));
  },
};

(globalThis as unknown as { aepHarness: typeof harness }).aepHarness = harness;
