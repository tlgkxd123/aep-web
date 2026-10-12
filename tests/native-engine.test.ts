// The page's side of the Android app's Vulkan engine (src/native/engine.ts): playback's frames rendered natively as
// pending work, left to WebGL when the engine cannot render them, and the plans it is sent.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompItem, Project } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import "../src/expressions/install.ts";
import { pendingDone, workInFlight } from "../src/media/pending.ts";
import { capacitorBackend, channelBackend, NativeFrames, registerNativePending, toBase64, type FrameChannel, type NativeBackend, type NativeDevice } from "../src/native/engine.ts";
import { decodePlan, encodePlan } from "../src/native/wire.ts";

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

  it("keeps at most three renders in flight, waiting on the oldest without starting another", async () => {
    const { project, comp } = fixture("solid_basic");
    const { frames, backend } = setup();
    frames.enabled = true;
    await frames.probe();
    const first = frames.prefetch(project, comp, "v", 0, 0, 1);
    frames.prefetch(project, comp, "v", 1, 1 / 24, 1);
    frames.prefetch(project, comp, "v", 2, 2 / 24, 1);
    expect(frames.prefetch(project, comp, "v", 3, 3 / 24, 1)).toBe(first);
    expect(backend.plans).toHaveLength(3);
    expect([0, 1, 2, 3].map((f) => frames.renderingFrame("v", f))).toEqual([true, true, true, false]);
  });

  it("tells which frames are rendering, and how long frames take to come back", async () => {
    const { project, comp } = fixture("solid_basic");
    const { frames, backend, bump } = setup();
    frames.enabled = true;
    await frames.probe();
    expect(frames.latencyMs).toBe(0);
    frames.prefetch(project, comp, "v", 4, 4 / 24, 1);
    expect(frames.renderingFrame("v", 4)).toBe(true);
    expect(frames.renderingFrame("w", 4)).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    backend.finish(comp.width, comp.height);
    await settled();
    expect(frames.renderingFrame("v", 4)).toBe(false);
    expect(frames.latencyMs).toBeGreaterThanOrEqual(15);
    // A frame rendering for content that has since changed is not the frame asked about.
    frames.prefetch(project, comp, "v", 5, 5 / 24, 1);
    bump();
    expect(frames.renderingFrame("v", 5)).toBe(false);
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

/** The object NativeEnginePlugin injects: requests it was posted, and replies the test sends back. */
class FakeChannel implements FrameChannel {
  requests: ArrayBuffer[] = [];
  private listener: ((event: { data: unknown }) => void) | undefined;
  postMessage(message: ArrayBuffer | string) {
    if (typeof message !== "string") this.requests.push(message);
  }
  addEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
    this.listener = listener;
  }
  /** The id of request `i`. */
  id(i: number) {
    return new DataView(this.requests[i]).getUint32(0, true);
  }
  /** A frame whose every pixel is `rgba`, as the plugin replies: the pixels, then the id, width and height. */
  frame(id: number, width: number, height: number, rgba: number[], extra = 0) {
    const bytes = new Uint8Array(width * height * 4 + 12 + extra);
    for (let i = 0; i < width * height; i++) bytes.set(rgba, i * 4);
    const tail = new DataView(bytes.buffer, bytes.length - 12);
    tail.setUint32(0, id, true);
    tail.setUint32(4, width, true);
    tail.setUint32(8, height, true);
    this.listener!({ data: bytes.buffer });
  }
  error(id: number, error: string) {
    this.listener!({ data: JSON.stringify({ id, error }) });
  }
}

describe("the plugin's frame channel", () => {
  // Node has no ImageData or createImageBitmap: stand-ins that keep what they were given.
  const bitmaps = () => {
    vi.stubGlobal(
      "ImageData",
      class {
        data: Uint8ClampedArray;
        width: number;
        height: number;
        constructor(data: Uint8ClampedArray, width: number, height: number) {
          this.data = data;
          this.width = width;
          this.height = height;
        }
      },
    );
    vi.stubGlobal("createImageBitmap", async (image: { data: Uint8ClampedArray; width: number; height: number }) => ({ ...image, close() {} }));
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const device = () => Promise.resolve({ available: true });
  const plan = (n: number) => new Uint8Array(n).map((_, i) => i & 255);

  it("posts each plan after its request's id and makes the reply with that id a bitmap", async () => {
    bitmaps();
    const channel = new FakeChannel();
    const backend = channelBackend(channel, device);
    const first = backend.render(plan(40));
    const second = backend.render(plan(8));
    expect(channel.requests).toHaveLength(2);
    expect(new Uint8Array(channel.requests[0], 4)).toEqual(plan(40));
    expect(channel.id(1)).not.toBe(channel.id(0));
    // Replies may come in any order.
    channel.frame(channel.id(1), 2, 1, [9, 8, 7, 6]);
    channel.frame(channel.id(0), 3, 2, [1, 2, 3, 255]);
    const [a, b] = (await Promise.all([first, second])) as unknown as { width: number; height: number; data: Uint8ClampedArray }[];
    expect([a.width, a.height, a.data.length, [...a.data.subarray(0, 4)]]).toEqual([3, 2, 24, [1, 2, 3, 255]]);
    expect([b.width, b.height, [...b.data]]).toEqual([2, 1, [9, 8, 7, 6, 9, 8, 7, 6]]);
  });

  it("fails the request the engine reports an error for, and frames whose size does not add up", async () => {
    bitmaps();
    const channel = new FakeChannel();
    const backend = channelBackend(channel, device);
    const failing = backend.render(plan(4));
    const odd = backend.render(plan(4));
    channel.error(channel.id(0), "device lost");
    channel.frame(channel.id(1), 2, 2, [0, 0, 0, 0], 4);
    await expect(failing).rejects.toThrow("device lost");
    await expect(odd).rejects.toThrow(/2x2 came with 32 bytes/);
  });

  it("gives up on a frame that does not come back", async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel();
    const lost = channelBackend(channel, device).render(plan(4));
    vi.advanceTimersByTime(15000);
    await expect(lost).rejects.toThrow(/did not come back/);
    // A reply after that changes nothing.
    channel.frame(channel.id(0), 1, 1, [0, 0, 0, 0]);
  });

  it("is what the Android backend uses when the app injected it", async () => {
    bitmaps();
    const channel = new FakeChannel();
    vi.stubGlobal("aevkFrames", channel);
    const backend = capacitorBackend();
    const bytes = encodePlan({ root: { width: 1, height: 1, layers: [] }, images: [] });
    const frame = backend.render(bytes);
    expect(new Uint8Array(channel.requests[0], 4)).toEqual(bytes);
    channel.frame(channel.id(0), 1, 1, [0, 0, 0, 0]);
    expect(await frame).toMatchObject({ width: 1, height: 1 });
  });
});
