// Preview audio as playback's clock: the comp time being heard follows the audio device's output clock from the
// moment the sound started, and the counters show every start and every stop while playing.
import { afterEach, describe, expect, it } from "vitest";
import type { CompItem, Project } from "../src/aep/model.ts";
import { AudioPreview } from "../src/media/audioPreview.ts";

/** Just enough of an AudioContext: a clock the test moves, output timestamps from it, no sound. */
class FakeContext {
  static now = 0;
  private time = 0;
  /** Page time of the audio thread's last update. */
  private updatedAt = 0;
  state = "running";
  outputLatency = 0.02;
  baseLatency = 0.01;
  destination = {};
  get currentTime() {
    return this.time;
  }
  set currentTime(t: number) {
    this.time = t;
    this.updatedAt = FakeContext.now;
  }
  getOutputTimestamp() {
    // The device outputs what the context rendered outputLatency ago.
    return { contextTime: Math.max(0, this.time - this.outputLatency), performanceTime: this.updatedAt };
  }
  resume() {
    return Promise.resolve();
  }
}

const globals = globalThis as unknown as { AudioContext?: unknown; performance: Performance };
const realNow = performance.now.bind(performance);

function setup() {
  globals.AudioContext = FakeContext;
  performance.now = () => FakeContext.now;
  const preview = new AudioPreview();
  const comp = { id: 1, layers: [], duration: 60 } as unknown as CompItem;
  const project = { items: new Map() } as unknown as Project;
  return { preview, comp, project, context: () => (preview as unknown as { context: FakeContext }).context };
}

afterEach(() => {
  delete globals.AudioContext;
  performance.now = realNow;
  FakeContext.now = 0;
});

describe("audio preview clock", () => {
  it("reports the comp time heard, moving with the device clock between its updates", () => {
    const { preview, comp, project, context } = setup();
    expect(preview.position()).toBeNull();
    preview.play(project, comp, 10, 20);
    const ctx = context();
    expect(preview.stats).toEqual({ starts: 1, stops: 0 });
    // Nothing heard yet: the first output is still in the device's latency.
    expect(preview.position()).toBe(10);
    FakeContext.now = 5000;
    ctx.currentTime = 1.02;
    expect(preview.position()).toBeCloseTo(11, 9);
    // Between audio thread updates the clock runs on with the page's clock.
    FakeContext.now = 5250;
    expect(preview.position()).toBeCloseTo(11.25, 9);
  });

  it("stands still while the context is suspended, and counts stops while playing", () => {
    const { preview, comp, project, context } = setup();
    preview.play(project, comp, 3, 20);
    context().state = "suspended";
    expect(preview.position()).toBeNull();
    preview.stop();
    preview.stop();
    expect(preview.stats).toEqual({ starts: 1, stops: 1 });
    expect(preview.position()).toBeNull();
    // Playing again from elsewhere stops the sound that played: a restart.
    context().state = "running";
    preview.play(project, comp, 3, 20);
    preview.play(project, comp, 7, 20);
    expect(preview.stats).toEqual({ starts: 3, stops: 2 });
    preview.resetStats();
    expect(preview.stats).toEqual({ starts: 0, stops: 0 });
  });
});
