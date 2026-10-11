// The page's side of the Android app's Vulkan engine (src/native/engine.ts): playback's frames rendered natively as
// pending work, left to WebGL when the engine cannot render them, and the plans it is sent.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompItem, Project } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import "../src/expressions/install.ts";
import { pendingDone, workInFlight } from "../src/media/pending.ts";
import { NativeFrames, registerNativePending, toBase64, type NativeBackend, type NativeDevice } from "../src/native/engine.ts";
import { decodePlan } from "../src/native/wire.ts";

let fixtures: Project | undefined;
function fixture(name: string): { project: Project; comp: CompItem } {
  fixtures ??= parseProject(new Uint8Array(readFileSync(resolve("refs/fixtures/fixtures.aep"))));
  const comp = [...fixtures.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name);
  if (!comp) throw new Error(`no comp ${name}`);
  return { project: fixtures, comp };
}

/** A backend whose renders finish when the test says. */
class FakeBackend implements NativeBackend {
  device: NativeDevice = { available: true, device: "Test GPU", vulkan: "1.3.0", software: false };
  plans: Uint8Array[] = [];
  private settle: { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }[] = [];
  closed = 0;

  probe() {
    return Promise.resolve(this.device);
  }
  render(plan: Uint8Array) {
    this.plans.push(plan);
    return new Promise<ImageBitmap>((resolve, reject) => this.settle.push({ resolve, reject }));
  }
  finish(width: number, height: number) {
    const bitmap = { width, height, close: () => this.closed++ } as unknown as ImageBitmap;
    this.settle.shift()!.resolve(bitmap);
  }
  fail(message: string) {
    this.settle.shift()!.reject(new Error(message));
  }
}

function setup(backend: FakeBackend | undefined = new FakeBackend()) {
  const put: { view: string; frame: number; bytes: number }[] = [];
  let generation = 0;
  const frames = new NativeFrames(() => backend, { put: (view, frame, _bitmap, bytes) => put.push({ view, frame, bytes }) }, () => generation);
  registerNativePending(frames);
  return { frames, backend: backend!, put, bump: () => generation++ };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe("native playback frames", () => {
  it("stays off until switched on and the device has an engine", async () => {
    const { project, comp } = fixture("solid_basic");
    const { frames, backend } = setup();
    expect(frames.prefetch(project, comp, "1@1", 0, 0, 1)).toBeUndefined();
    frames.enabled = true;
    // Not probed yet: WebGL renders meanwhile.
    expect(frames.prefetch(project, comp, "1@1", 0, 0, 1)).toBeUndefined();
    expect(await frames.probe()).toMatchObject({ available: true, device: "Test GPU" });
    expect(frames.active).toBe(true);
    expect(frames.prefetch(project, comp, "1@1", 0, 0, 1)).toMatch(/^native\n/);
    expect(backend.plans).toHaveLength(1);
  });

  it("reports no engine outside the Android app", async () => {
    const frames = new NativeFrames(() => undefined, { put: () => {} }, () => 0);
    frames.enabled = true;
    expect(await frames.probe()).toMatchObject({ available: false });
    expect(frames.active).toBe(false);
  });

  it("renders a frame as pending work and caches it when it arrives", async () => {
    const { project, comp } = fixture("solid_basic");
    const { frames, backend, put } = setup();
    frames.enabled = true;
    await frames.probe();
    const entry = frames.prefetch(project, comp, `${comp.id}@2`, 3, 3 / 24, 0.5)!;
    expect(pendingDone([entry])).toBe(false);
    expect(workInFlight()).toBe(true);
    // Asked again while it renders: the same work, not a second render.
    expect(frames.prefetch(project, comp, `${comp.id}@2`, 3, 3 / 24, 0.5)).toBe(entry);
    expect(backend.plans).toHaveLength(1);
    const plan = decodePlan(backend.plans[0]);
    expect(plan.root).toMatchObject({ width: comp.width / 2, height: comp.height / 2 });
    backend.finish(plan.root.width, plan.root.height);
    await settled();
    expect(pendingDone([entry])).toBe(true);
    expect(put).toEqual([{ view: `${comp.id}@2`, frame: 3, bytes: (comp.width / 2) * (comp.height / 2) * 4 }]);
  });

  it("drops a frame whose content changed while it rendered", async () => {
    const { project, comp } = fixture("solid_basic");
    const { frames, backend, put, bump } = setup();
    frames.enabled = true;
    await frames.probe();
    frames.prefetch(project, comp, "v", 0, 0, 1);
    bump();
    backend.finish(comp.width, comp.height);
    await settled();
    expect(put).toEqual([]);
    expect(backend.closed).toBe(1);
  });

  it("leaves comps with content it cannot render yet to WebGL", async () => {
    const project = parseProject(new Uint8Array(readFileSync(resolve("refs/fixtures/adjust.aep"))));
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "adjust_blur")!;
    const { frames, backend } = setup();
    frames.enabled = true;
    await frames.probe();
    expect(frames.prefetch(project, comp, "adjust", 0, 0, 1)).toBeUndefined();
    expect(frames.lastRefusal).toMatch(/adjustment layer effects/);
    expect(frames.prefetch(project, comp, "adjust", 1, 1 / 24, 1)).toBeUndefined();
    expect(backend.plans).toHaveLength(0);
  });

  it("falls back to WebGL for frames it failed on, and for good after repeated failures", async () => {
    const { project, comp } = fixture("solid_basic");
    const { frames, backend } = setup();
    frames.enabled = true;
    await frames.probe();
    for (let frame = 0; frame < 3; frame++) {
      const entry = frames.prefetch(project, comp, "v", frame, frame / 24, 1)!;
      backend.fail("device lost");
      await settled();
      expect(pendingDone([entry])).toBe(true);
      expect(frames.prefetch(project, comp, "v", frame, frame / 24, 1)).toBeUndefined();
    }
    expect(frames.lastRefusal).toMatch(/device lost/);
    expect(frames.active).toBe(false);
    expect(frames.prefetch(project, comp, "v", 5, 5 / 24, 1)).toBeUndefined();
  });

  it("keeps at most two renders in flight, waiting on the oldest", async () => {
    const { project, comp } = fixture("solid_basic");
    const { frames, backend } = setup();
    frames.enabled = true;
    await frames.probe();
    const first = frames.prefetch(project, comp, "v", 0, 0, 1);
    frames.prefetch(project, comp, "v", 1, 1 / 24, 1);
    expect(frames.prefetch(project, comp, "v", 2, 2 / 24, 1)).toBe(first);
    expect(backend.plans).toHaveLength(2);
  });

  it("keeps the Preview Renderer choice but renders with WebGL outside the Android app", async () => {
    const { previewRenderer, nativeFrames } = await import("../src/playback/previewRenderer.ts");
    let changes = 0;
    const stop = previewRenderer.subscribe(() => changes++);
    previewRenderer.set(true);
    expect(previewRenderer.vulkan).toBe(true);
    expect(await nativeFrames.probe()).toMatchObject({ available: false, reason: expect.stringMatching(/Android app/) });
    expect(nativeFrames.active).toBe(false);
    const { project, comp } = fixture("solid_basic");
    expect(nativeFrames.prefetch(project, comp, "v", 0, 0, 1)).toBeUndefined();
    previewRenderer.set(false);
    stop();
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it("encodes plans for the plugin bridge as base64", () => {
    const bytes = new Uint8Array(70000).map((_, i) => (i * 7) & 255);
    expect(Buffer.from(toBase64(bytes), "base64").equals(Buffer.from(bytes))).toBe(true);
  });
});
