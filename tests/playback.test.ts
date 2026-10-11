// Playback timing (the Preview panel's range, Play From, Frame Rate, Skip and Loop), the resolutions Fast Previews
// steps down to, the RAM preview cache, and render target pools that keep a frame's working set for the next frame.
import { describe, expect, it } from "vitest";
import type { CompItem } from "../src/aep/model.ts";
import { FrameCache } from "../src/playback/frameCache.ts";
import { adaptiveFactor, adaptiveLimit, DEFAULT_PREVIEW, dueSlot, playbackSpan, slotTime } from "../src/playback/usePlayback.ts";
import { TargetPool, type GL } from "../src/render/gl.ts";

const comp = (over: Partial<CompItem> = {}) =>
  ({ frameRate: 24, frameDuration: 1 / 24, duration: 10, workAreaStart: 2, workAreaDuration: 3, ...over }) as CompItem;

describe("playback span", () => {
  it("plays the work area from its start, looping, one comp frame per slot", () => {
    const span = playbackSpan(comp(), 0, { ...DEFAULT_PREVIEW, range: "workArea" });
    expect(span).toMatchObject({ start: 2, end: 5, begin: 2, loop: true });
    expect(span.step).toBeCloseTo(1 / 24, 9);
    expect(slotTime(span, 0)).toEqual({ time: 2, pass: 0 });
    expect(slotTime(span, 24)!.time).toBeCloseTo(3, 9);
    const wrapped = slotTime(span, 72)!;
    expect(wrapped.pass).toBe(1);
    expect(wrapped.time).toBeCloseTo(2, 9);
  });

  it("extends the work area to the current time and plays from it when asked", () => {
    const span = playbackSpan(comp(), 7, { ...DEFAULT_PREVIEW, range: "extended", playFrom: "current" });
    expect(span.start).toBe(2);
    expect(span.end).toBeCloseTo(7 + 1 / 24, 9);
    expect(span.begin).toBe(7);
  });

  it("finds the slot due a time after the one shown when the clock started, across passes", () => {
    const span = playbackSpan(comp(), 0, { ...DEFAULT_PREVIEW, range: "workArea" });
    expect(dueSlot(span, 10, 0)).toBe(10);
    expect(dueSlot(span, 10, 1 / 24 - 1e-9)).toBe(11);
    expect(dueSlot(span, 10, 0.5)).toBe(22);
    // Three seconds of a three-second work area later: the same frame, one pass on.
    const later = slotTime(span, dueSlot(span, 10, 3))!;
    expect(later.pass).toBe(1);
    expect(later.time).toBeCloseTo(slotTime(span, 10)!.time, 9);
  });

  it("ends after one pass without Loop, and Frame Rate and Skip space the shown frames", () => {
    const span = playbackSpan(comp(), 0, { ...DEFAULT_PREVIEW, range: "workArea", loop: false, frameRate: 12, skip: 1 });
    expect(span.step).toBeCloseTo(2 / 12, 9);
    expect(slotTime(span, 17)!.time).toBeCloseTo(2 + 17 / 6, 9);
    expect(slotTime(span, 18)).toBeNull();
  });
});

describe("Fast Previews", () => {
  it("goes down to Quarter on desktops and to 1/8 on phones and tablets", () => {
    expect(adaptiveLimit(false)).toBe(4);
    expect(adaptiveLimit(true)).toBe(8);
  });

  it("steps straight to the resolution whose share of the pixels brings GPU time under budget", () => {
    // 30 ms at Full: Half takes about a quarter of it.
    expect(adaptiveFactor(1, 30, 4)).toBe(2);
    expect(adaptiveFactor(1, 400, 4)).toBe(4);
    // 1000 ms at Full takes about 20 ms at 1/7.
    expect(adaptiveFactor(1, 1000, 8)).toBe(7);
  });

  it("stops at the limit however slow the GPU is", () => {
    expect(adaptiveFactor(1, 1000, 4)).toBe(4);
    expect(adaptiveFactor(3, 1000, 4)).toBe(4);
    // A phone still too slow at Quarter goes on down to 1/8, where it has a quarter of the pixels to render.
    expect(adaptiveFactor(4, 260, 8)).toBe(8);
  });
});

describe("RAM preview cache", () => {
  it("keeps frames within its budget, least recently used out first, and reports cached ranges", () => {
    const disposed: number[] = [];
    const cache = new FrameCache<number>(30, (v) => disposed.push(v));
    for (const f of [0, 1, 2]) cache.put("1@1", f, f, 10);
    cache.get("1@1", 0);
    cache.put("1@1", 3, 3, 10);
    expect(disposed).toEqual([1]);
    expect(cache.ranges("1@1")).toEqual([
      [0, 1],
      [2, 4],
    ]);
    cache.invalidate((view) => view === "1@1");
    expect(cache.size).toBe(0);
  });
});

/** Just enough of WebGL2 for TargetPool, counting textures alive. */
function fakeGL() {
  let live = 0;
  const gl = new Proxy(
    {},
    {
      get: (_, name) => {
        if (name === "createTexture") return () => (live++, {});
        if (name === "deleteTexture") return () => live--;
        if (typeof name === "string" && /^[A-Z_0-9]+$/.test(name)) return 0;
        return () => ({});
      },
    },
  ) as GL;
  return { gl, live: () => live };
}

describe("render target pool", () => {
  it("keeps what a frame used for the next frame and drops what frames stopped using", () => {
    const { gl, live } = fakeGL();
    const pool = new TargetPool(gl);
    const frame = (sizes: number[]) => {
      const targets = sizes.map((s) => pool.acquire(s, s));
      for (const t of targets) pool.release(t);
      pool.trim(Infinity);
    };
    frame([100, 100, 200]);
    expect(live()).toBe(3);
    // The same working set again allocates nothing.
    frame([100, 100, 200]);
    expect(live()).toBe(3);
    // A size no longer used goes after KEEP_FRAMES frames.
    frame([100, 100]);
    frame([100, 100]);
    expect(live()).toBe(2);
  });
});
