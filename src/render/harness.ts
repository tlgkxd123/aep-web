// Browser entry used by scripts/pixel-report.ts: loads a project and renders
// frames to straight-alpha RGBA, exposed on window.aepHarness.
import type { CompItem, Project } from "../aep/model.ts";
import { parseProject } from "../aep/parse.ts";
import { Renderer } from "./renderer.ts";

let project: Project | undefined;
let renderer: Renderer | undefined;

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
  render(compName: string, time: number): { width: number; height: number; pixels: string; warnings: string[] } {
    if (!project || !renderer) throw new Error("load a project first");
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName);
    if (!comp) throw new Error(`no composition named ${compName}`);
    const target = renderer.render(project, comp, time);
    const pixels = renderer.readPixels(target, comp.width, comp.height);
    renderer.release(target);
    return { width: comp.width, height: comp.height, pixels: encodeBase64(pixels), warnings: renderer.lastWarnings };
  },
};

(globalThis as unknown as { aepHarness: typeof harness }).aepHarness = harness;
