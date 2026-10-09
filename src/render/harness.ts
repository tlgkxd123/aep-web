// Browser entry used by scripts/pixel-report.ts: loads a project and renders
// frames to straight-alpha RGBA, exposed on window.aepHarness.
import type { CompItem, Project } from "../aep/model.ts";
import { parseProject } from "../aep/parse.ts";
import { footageStore } from "../media/store.ts";
import type { RendererOptions } from "./registry.ts";
import { Renderer } from "./renderer.ts";

let project: Project | undefined;
let renderer: Renderer | undefined;

/** Render passes allowed while footage frames are still arriving. */
const MAX_PASSES = 32;

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
  /** Renders `times` (after one warm-up render each) with the stage profiler on; returns ms per frame and per stage. */
  async profile(compName: string, times: number[]): Promise<{ frameMs: number[]; warmMs: number[]; coldMs: number[]; stages: [string, number, number][]; gpu: string }> {
    if (!project || !renderer) throw new Error("load a project first");
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName);
    if (!comp) throw new Error(`no composition named ${compName}`);
    const gl = renderer.gl;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
    const frameMs: number[] = [];
    const warmMs: number[] = [];
    const coldMs: number[] = [];
    const stages = new Map<string, { ms: number; count: number }>();
    for (const time of times) {
      const warming = performance.now();
      renderer.release(await harness.renderTarget(comp, time));
      warmMs.push(performance.now() - warming);
      coldMs.push(harness.lastPassMs);
      renderer.profile = stages;
      const started = performance.now();
      renderer.release(renderer.render(project, comp, time));
      gl.finish();
      frameMs.push(performance.now() - started);
      renderer.profile = null;
    }
    const rows = [...stages].map(([k, v]): [string, number, number] => [k, v.ms / times.length, v.count / times.length]);
    rows.sort((a, b) => b[1] - a[1]);
    return { frameMs, warmMs, coldMs, stages: rows, gpu };
  },
  /** Milliseconds (GPU work included) of renderTarget's last pass, the first with all footage decoded. */
  lastPassMs: 0,
  /** A rendered target once the footage it needs has decoded. */
  async renderTarget(comp: CompItem, time: number) {
    const pass = () => {
      const started = performance.now();
      const target = renderer!.render(project!, comp, time);
      renderer!.gl.finish();
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
