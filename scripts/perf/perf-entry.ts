// Browser entry for scripts/perf-report.ts: times the viewer path (render +
// present, synchronised with a 1-pixel readback) frame by frame. It only uses
// the Renderer API of the base commit, so the same file builds against older
// sources for before/after numbers.
import type { CompItem, Project } from "../../src/aep/model.ts";
import { parseProject } from "../../src/aep/parse.ts";
import { Renderer } from "../../src/render/renderer.ts";

let project: Project | undefined;
let renderer: Renderer | undefined;
let canvas: OffscreenCanvas | undefined;

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const perf = {
  load(base64: string): void {
    project = parseProject(decodeBase64(base64));
    canvas ??= new OffscreenCanvas(16, 16);
    renderer ??= new Renderer(canvas);
  },
  time(compName: string, times: number[]): { ms: number[]; warnings: string[]; width: number; height: number } {
    if (!project || !renderer || !canvas) throw new Error("load a project first");
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName);
    if (!comp) throw new Error(`no composition named ${compName}`);
    canvas.width = comp.width;
    canvas.height = comp.height;
    const gl = renderer.gl;
    const px = new Uint8Array(4);
    const ms: number[] = [];
    for (const t of times) {
      const start = performance.now();
      const target = renderer.render(project, comp, t);
      renderer.present(target, comp);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      ms.push(performance.now() - start);
      renderer.release(target);
    }
    return { ms, warnings: renderer.lastWarnings, width: comp.width, height: comp.height };
  },
  /**
   * Renders every time twice in a row (warming the content caches), then again
   * with the caches cleared before each frame; returns the frames whose pixels
   * differ. Needs Renderer.clearCaches, so only the working tree has it.
   */
  verifyCaches(compName: string, times: number[]): { checked: number; mismatches: number[] } {
    if (!project || !renderer) throw new Error("load a project first");
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName);
    if (!comp) throw new Error(`no composition named ${compName}`);
    const pixels = (t: number) => {
      const target = renderer!.render(project!, comp, t);
      const out = renderer!.readPixels(target, comp.width, comp.height);
      renderer!.release(target);
      return out;
    };
    const cached = times.map((t) => (pixels(t), pixels(t)));
    const mismatches: number[] = [];
    times.forEach((t, i) => {
      renderer!.clearCaches();
      const fresh = pixels(t);
      const a = cached[i];
      for (let k = 0; k < fresh.length; k++) {
        if (fresh[k] !== a[k]) {
          mismatches.push(t);
          break;
        }
      }
    });
    return { checked: times.length, mismatches };
  },
};

(globalThis as unknown as { aepPerf: typeof perf }).aepPerf = perf;
