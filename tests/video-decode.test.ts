import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { FootageItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { FootageStore } from "../src/media/store.ts";
import { openWebCodecs } from "../src/media/video.ts";

const refs = resolve("refs");

/** A WebCodecs decoder stand-in: each chunk comes out as a 2x2 RGBA frame a few milliseconds after it is fed. */
class FakeDecoder {
  static resets = 0;
  static decoded: number[] = [];
  static instances: FakeDecoder[] = [];
  resets = 0;
  fed = 0;
  state = "unconfigured";
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly output: (frame: unknown) => void;
  constructor(init: { output: (frame: unknown) => void }) {
    this.output = init.output;
    FakeDecoder.instances.push(this);
  }
  static async isConfigSupported() {
    return { supported: true };
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk: { timestamp: number }) {
    FakeDecoder.decoded.push(chunk.timestamp);
    this.fed++;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.output({
        timestamp: chunk.timestamp,
        format: "RGBA",
        codedWidth: 2,
        codedHeight: 2,
        visibleRect: { width: 2, height: 2 },
        colorSpace: { fullRange: true },
        allocationSize: () => 16,
        copyTo: async (data: Uint8Array) => data.fill(chunk.timestamp),
        close() {},
      });
    }, 2);
    this.timers.add(timer);
  }
  reset() {
    FakeDecoder.resets++;
    this.resets++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.state = "unconfigured";
  }
  async flush() {
    while (this.timers.size) await new Promise((r) => setTimeout(r, 1));
  }
  close() {
    this.reset();
    this.state = "closed";
  }
}

const globals = globalThis as Record<string, unknown>;

beforeEach(() => {
  FakeDecoder.resets = 0;
  FakeDecoder.decoded = [];
  globals.VideoDecoder = FakeDecoder;
  globals.EncodedVideoChunk = class {
    timestamp: number;
    constructor(init: { timestamp: number }) {
      this.timestamp = init.timestamp;
    }
  };
});

afterEach(() => {
  delete globals.VideoDecoder;
  delete globals.EncodedVideoChunk;
});

function clip(): { store: FootageStore; item: FootageItem } {
  const project = parseProject(new Uint8Array(readFileSync(join(refs, "fixtures", "footage.aep"))));
  const item = [...project.items.values()].find((i): i is FootageItem => i.kind === "footage" && i.name === "clip.mp4");
  if (!item) throw new Error("footage.aep has no clip.mp4");
  const store = new FootageStore();
  store.addFiles([{ path: "media/clip.mp4", blob: new Blob([readFileSync(join(refs, "media", "clip.mp4"))]) }]);
  return { store, item };
}

/** The frame's fill value: the presentation index the fake decoder stamped into it. */
function stamp(state: ReturnType<FootageStore["frame"]>): number | undefined {
  const frame = state.status === "ready" ? state.frame : state.status === "pending" ? state.fallback : undefined;
  return frame?.kind === "rgba" ? frame.data[0] : undefined;
}

/** Polls frame `i` every millisecond, as playback does, until it is ready. */
async function until(store: FootageStore, item: FootageItem, i: number) {
  let state = store.frame(item, i);
  while (state.status === "pending") {
    await new Promise((r) => setTimeout(r, 1));
    state = store.frame(item, i);
  }
  return state;
}

test("playing a video forward decodes each sample once, without resetting the decoder between frames", async () => {
  const { store, item } = clip();
  const shown: number[] = [];
  for (let i = 0; i < 30; i++) {
    const state = await until(store, item, i);
    expect(state.status).toBe("ready");
    shown.push(stamp(state)!);
  }
  expect(shown).toEqual(Array.from({ length: 30 }, (_, i) => i));
  // Once to start from the first key frame; never again while playing forward.
  expect(FakeDecoder.resets).toBe(1);
  expect(new Set(FakeDecoder.decoded).size).toBe(FakeDecoder.decoded.length);
});

test("requests queued behind a run that already delivered their frame do not decode again", async () => {
  const { store, item } = clip();
  store.frame(item, 0);
  await store.idle();
  for (let i = 0; i < 6; i++) store.frame(item, i);
  await store.idle();
  for (let i = 0; i < 6; i++) expect(store.frame(item, i).status).toBe("ready");
  expect(FakeDecoder.resets).toBe(1);
  expect(new Set(FakeDecoder.decoded).size).toBe(FakeDecoder.decoded.length);
});

test("a frame that decoding ahead is already producing is waited for, so the view renders again when it lands", async () => {
  const { store, item } = clip();
  await until(store, item, 0);
  // Let the first run's last pictures land, so only decoding ahead is in flight below.
  await new Promise((r) => setTimeout(r, 60));
  await store.idle();
  // Showing decoded frames starts decoding ahead from the first one missing; the loop ends asking for that one.
  let last = 0;
  while (store.frame(item, last + 1).status === "ready") last++;
  // Waiting for the store must include it: exports and the pixel harness render once it is idle.
  await store.idle();
  expect(store.frame(item, last + 1).status).toBe("ready");
});

test("a frame that came out after the previous request finished is on its way, not decoded again", async () => {
  const reader = await openWebCodecs(new Blob([readFileSync(join(refs, "media", "clip.mp4"))]));
  const got: number[] = [];
  const sink = (index: number) => got.push(index);
  const before = FakeDecoder.instances.length;
  await reader.decode(0, sink);
  const decoder = FakeDecoder.instances[before];
  const seen = got.length;
  // The lookahead pictures land after the reply, as they reach a worker's caller after its "done".
  await new Promise((r) => setTimeout(r, 30));
  const late = got[seen];
  expect(late).toBeGreaterThan(0);
  const fed = decoder.fed;
  await reader.decode(late, sink);
  expect(decoder.resets).toBe(1);
  expect(decoder.fed).toBe(fed);
  // Asked for again after a request that saw it come out: the caller lost it, so it is decoded again.
  await reader.decode(0, sink);
  expect(decoder.resets).toBe(2);
  expect(got.filter((i) => i === 0)).toHaveLength(2);
  reader.close();
});

test("two layers showing one movie at different times each hold their own nearest frame while decoding", async () => {
  const { store, item } = clip();
  expect(stamp(await until(store, item, 2))).toBe(2);
  expect(stamp(await until(store, item, 25))).toBe(25);
  // Requested together, as one render asks for both layers.
  const early = store.frame(item, 3);
  const late = store.frame(item, 26);
  if (early.status === "pending") expect(stamp(early)).toBeLessThanOrEqual(3);
  if (late.status === "pending") expect(stamp(late)).toBeGreaterThanOrEqual(20);
  await store.idle();
});

test("while a frame decodes, the layer holds the nearest earlier decoded frame instead of going blank", async () => {
  const { store, item } = clip();
  expect(stamp(await until(store, item, 0))).toBe(0);
  const later = store.frame(item, 25);
  expect(later.status).toBe("pending");
  // Frames decoded ahead of frame 0 stand in, the latest of them before 25.
  const held = stamp(later)!;
  expect(held).toBeGreaterThan(0);
  expect(held).toBeLessThan(25);
  await store.idle();
  expect(stamp(store.frame(item, 25))).toBe(25);
});
