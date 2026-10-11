// What the app keeps in memory follows the device: a desktop keeps the budgets the renderer was tuned with, a phone
// or tablet a share of its memory, and half of that once Android reported memory running low. Giving memory back
// empties the caches by how short of it the system is, the Render Queue's included while it renders; its renderer
// goes when the queue stops, and on a phone the viewers make room for it first.
import { expect, test, vi } from "vitest";
import type { CompItem, Layer, Project } from "../src/aep/model.ts";
import { memoryBudgets, type MemoryBudgets } from "../src/device.ts";
import { ImageCache, LayerCache } from "../src/render/contentCache.ts";
import type { GL } from "../src/render/gl.ts";
import { MaskRenderer } from "../src/render/masks.ts";
import type { Renderer } from "../src/render/renderer.ts";

const MIB = 1024 * 1024;
const total = (budgets: MemoryBudgets) => Object.values(budgets).reduce((sum, bytes) => sum + bytes, 0);

test("a desktop keeps the renderer's budgets; a phone an eighth of its memory, half of it once memory ran low", () => {
  expect(memoryBudgets({ mobile: false, memoryGiB: 8 })).toEqual({
    targets: 1024 * MIB,
    floatTargets: 1024 * MIB,
    layers: 320 * MIB,
    shapes: 320 * MIB,
    coverage: 64 * MIB,
    ramPreview: 1024 * MIB,
    footage: 384 * MIB,
  });
  expect(memoryBudgets({ mobile: false, memoryGiB: 4 }).ramPreview).toBe(512 * MIB);

  const phone = memoryBudgets({ mobile: true, memoryGiB: 4 });
  expect(total(phone)).toBe(512 * MIB);
  expect(total(memoryBudgets({ mobile: true, memoryGiB: 2 }))).toBe(256 * MIB);
  // A browser that does not tell is taken for a 4 GiB phone; less than 256 MiB counts as 256.
  expect(memoryBudgets({ mobile: true })).toEqual(phone);
  expect(memoryBudgets({ mobile: true, memoryGiB: 0.1 })).toEqual(memoryBudgets({ mobile: true, memoryGiB: 0.25 }));

  const constrained = memoryBudgets({ mobile: true, memoryGiB: 4, constrained: true });
  for (const key of Object.keys(phone) as (keyof MemoryBudgets)[]) expect(constrained[key]).toBe(phone[key] / 2);
  expect(memoryBudgets({ mobile: false, memoryGiB: 8, constrained: true })).toEqual(
    memoryBudgets({ mobile: true, memoryGiB: 8, constrained: true }),
  );
});

test("shrinking a layer image cache's budget drops the least recently used images beyond it", () => {
  const disposed: string[] = [];
  const cache = new ImageCache<string>(100, (v) => disposed.push(v));
  const [a, b, c] = [{}, {}, {}];
  cache.set(a, "k", "A", 40);
  cache.set(b, "k", "B", 40);
  cache.get(a, "k");
  cache.setBudget(50);
  expect(disposed).toEqual(["B"]);
  expect(cache.get(a, "k")).toBe("A");
  expect(cache.bytes).toBe(40);
  expect(cache.set(c, "k", "C", 60)).toBe(false);
});

test("shape content kept per layer stays within its byte budget, the least recently used dropped first", () => {
  const disposed: string[] = [];
  const cache = new LayerCache<string>((v) => disposed.push(v), 100, (v) => v.length * 10);
  const [a, b, c, d] = [{}, {}, {}, {}] as Layer[];
  const keep = (layer: Layer, key: string, value: string) => {
    cache.offer(layer, key, () => value);
    cache.offer(layer, key, () => value);
  };
  // Kept from the second time the same content is asked for.
  cache.offer(a, "1", () => "aaaa");
  expect(cache.get(a, "1")).toBeUndefined();
  cache.offer(a, "1", () => "aaaa");
  expect(cache.get(a, "1")).toBe("aaaa");
  keep(b, "1", "bbbb");
  cache.get(a, "1");
  keep(c, "1", "cccc");
  expect(disposed).toEqual(["bbbb"]);
  expect(cache.bytes).toBe(80);
  expect(cache.get(b, "1")).toBeUndefined();

  // Content beyond the whole budget is dropped, and not made again while it stays the same.
  const make = vi.fn(() => "x".repeat(11));
  for (let i = 0; i < 3; i++) cache.offer(d, "1", make);
  expect(make).toHaveBeenCalledOnce();
  expect(disposed).toEqual(["bbbb", "xxxxxxxxxxx"]);
  expect(cache.bytes).toBe(80);

  cache.setBudget(40);
  expect(disposed.slice(2)).toEqual(["aaaa"]);
  expect(cache.get(c, "1")).toBe("cccc");
  // New content for a layer drops what it replaces.
  cache.offer(c, "2", () => "cc");
  expect(disposed.slice(3)).toEqual(["cccc"]);
  expect(cache.bytes).toBe(0);
  keep(a, "1", "aaaa");
  cache.clear();
  expect(disposed.slice(4)).toEqual(["aaaa"]);
  expect(cache.bytes).toBe(0);
});

test("the mask renderer deletes the targets of a size once two frames in a row did not use it", () => {
  const live = new Set<object>();
  const gl = new Proxy(
    {},
    {
      get: (_, name) => {
        if (typeof name !== "string") return undefined;
        if (/^[A-Z0-9_]+$/.test(name)) return 0;
        return (...args: unknown[]) => {
          const object = {};
          if (name === "createTexture") live.add(object);
          if (name === "deleteTexture") live.delete(args[0] as object);
          return object;
        };
      },
    },
  ) as GL;
  const masks = new MaskRenderer(gl, () => {});
  const targetsFor = (w: number, h: number) => (masks as unknown as { targetsFor(w: number, h: number): object[] }).targetsFor(w, h);
  const shared = live.size;

  // Masked content that grows every frame, beside some that keeps its size.
  for (let size = 10; size < 20; size++) {
    targetsFor(size, size);
    expect(targetsFor(5, 5)).toHaveLength(3);
    masks.trim();
  }
  // Three targets each for this frame's size, the last frame's and the one that stays.
  expect(live.size - shared).toBe(9);
  masks.trim(true);
  expect(live.size).toBe(shared);
});

test("giving memory back empties the caches by how short of it the system is", async () => {
  vi.resetModules();
  const { appBudgets, memoryConstrained, releaseMemory } = await import("../src/playback/memory.ts");
  const { ramCache, registerRenderer } = await import("../src/playback/ramCache.ts");
  const { footageStore } = await import("../src/media/store.ts");
  const renderer = { releaseMemory: vi.fn(), setBudgets: vi.fn() };
  const unregister = registerRenderer(renderer as unknown as Renderer);
  const releaseFootage = vi.spyOn(footageStore, "releaseMemory");
  const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap;
  ramCache.put("1@1", 0, bitmap(), 1000);

  // Out of sight: the renderers' caches and the video decoders go, the RAM preview stays to play on return.
  releaseMemory("hidden");
  expect(renderer.releaseMemory).toHaveBeenCalledOnce();
  expect(releaseFootage).toHaveBeenLastCalledWith(true);
  expect(ramCache.size).toBe(1);

  releaseMemory("background");
  expect(renderer.releaseMemory).toHaveBeenCalledTimes(2);
  expect(releaseFootage).toHaveBeenLastCalledWith(true);
  expect(ramCache.size).toBe(0);
  expect(memoryConstrained()).toBe(false);
  expect(renderer.setBudgets).not.toHaveBeenCalled();

  // Running low while in sight (no document here): the decoders playing stay, the budgets shrink for good.
  ramCache.put("1@1", 0, bitmap(), 1000);
  releaseMemory("low");
  expect(releaseFootage).toHaveBeenLastCalledWith(false);
  expect(ramCache.size).toBe(0);
  expect(memoryConstrained()).toBe(true);
  expect(renderer.setBudgets).toHaveBeenCalledWith(appBudgets());
  expect(ramCache.budget).toBe(appBudgets().ramPreview);
  unregister();
});

/** A Render Queue with one PNG item of a 4 x 4 comp, rendered by stand-ins for the renderer, kept in `made`. */
async function stubQueue(onWrite: () => void = () => {}) {
  const { RenderQueue } = await import("../src/export/queue.ts");
  const made: { releaseMemory: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] = [];
  const queue = new RenderQueue();
  queue.createRenderer = () => {
    const renderer = {
      requestFootage: () => true,
      render: () => ({}),
      lastComplete: true,
      lastWarnings: [],
      readPixels: (_target: unknown, width: number, height: number) => new Uint8Array(width * height * 4),
      release: () => {},
      releaseMemory: vi.fn(),
      setBudgets: vi.fn(),
      clearCaches: vi.fn(),
      dispose: vi.fn(),
      gl: { canvas: {} },
    };
    made.push(renderer);
    return renderer as unknown as Renderer;
  };
  queue.openSink = async () => ({ write: async () => onWrite(), close: async () => {}, abort: async () => {} });
  const comp = { kind: "comp", id: 3, name: "Shot", width: 4, height: 4, pixelAspect: 1, duration: 0.2, frameRate: 10, frameDuration: 0.1 } as unknown as CompItem;
  Object.assign(comp, { workAreaStart: 0, workAreaDuration: 0.2, bgColor: [0, 0, 0], layers: [] });
  const item = queue.add({ items: new Map([[comp.id, comp]]) } as unknown as Project, comp);
  queue.setOutput(item.id, { ...item.output, format: "png" });
  return { queue, made, item };
}

test("the Render Queue's renderer gives memory back under pressure while it renders, and goes, context and all, when it stops", async () => {
  vi.resetModules();
  const { releaseMemory } = await import("../src/playback/memory.ts");
  const { viewerRenderers } = await import("../src/playback/ramCache.ts");
  let registered: boolean[] = [];
  const { queue, made, item } = await stubQueue(() => {
    registered.push([...viewerRenderers()].includes(made.at(-1) as unknown as Renderer));
    releaseMemory("hidden");
  });

  await queue.render();
  expect(queue.getSnapshot().items[0].status).toBe("Done");
  expect(registered.length).toBeGreaterThan(0);
  expect(registered.every(Boolean)).toBe(true);
  expect(made[0].releaseMemory).toHaveBeenCalled();
  expect(made[0].dispose).toHaveBeenCalledOnce();
  expect([...viewerRenderers()]).toEqual([]);

  // The next run gets a renderer of its own.
  registered = [];
  queue.setQueued(item.id, true);
  await queue.render();
  expect(made).toHaveLength(2);
  expect(made[1].dispose).toHaveBeenCalledOnce();
  expect(registered.every(Boolean)).toBe(true);
});

test("on a phone the viewers give back what they keep before a render makes its own renderer; a desktop's keep it", async () => {
  for (const mobile of [true, false]) {
    vi.resetModules();
    vi.doMock("../src/device.ts", async (original) => ({ ...(await original<typeof import("../src/device.ts")>()), isMobileDevice: () => mobile }));
    const { registerRenderer } = await import("../src/playback/ramCache.ts");
    const viewer = { releaseMemory: vi.fn(), setBudgets: vi.fn(), clearCaches: vi.fn() };
    const unregister = registerRenderer(viewer as unknown as Renderer);
    const { queue, made } = await stubQueue();
    const create = queue.createRenderer;
    let releasedFirst: boolean | undefined;
    queue.createRenderer = () => {
      releasedFirst = viewer.releaseMemory.mock.calls.length > 0;
      return create();
    };
    await queue.render();
    expect(made).toHaveLength(1);
    expect(releasedFirst).toBe(mobile);
    expect(viewer.releaseMemory).toHaveBeenCalledTimes(mobile ? 1 : 0);
    unregister();
    vi.doUnmock("../src/device.ts");
  }
});

test("constraining memory shrinks every cache once, and the budgets new renderers get", async () => {
  vi.resetModules();
  const { deviceBudgets } = await import("../src/device.ts");
  const { appBudgets, constrainMemory } = await import("../src/playback/memory.ts");
  const { ramCache } = await import("../src/playback/ramCache.ts");
  const { footageStore } = await import("../src/media/store.ts");
  const setFootageBudget = vi.spyOn(footageStore, "setBudget");
  expect(appBudgets()).toEqual(deviceBudgets());
  expect(ramCache.budget).toBe(deviceBudgets().ramPreview);

  constrainMemory();
  constrainMemory();
  const constrained = deviceBudgets(true);
  expect(appBudgets()).toEqual(constrained);
  expect(total(constrained)).toBeLessThan(total(deviceBudgets()));
  expect(ramCache.budget).toBe(constrained.ramPreview);
  expect(setFootageBudget).toHaveBeenCalledOnce();
  expect(setFootageBudget).toHaveBeenCalledWith(constrained.footage);
});
