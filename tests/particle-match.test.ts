// What the app plays a trained Particle Match world model with: the clock its audio
// network drives, the model as the effect stores it, and particle sampling.
import { describe, expect, it } from "vitest";
import { FEATURES, type AudioFeatures } from "../src/extra/pmatch/audio.ts";
import { Clock } from "../src/extra/pmatch/dynamics.ts";
import { decodeModel, dynamicsWeightCount, encodeModel, JITTER_COUNT, LIFE_SAMPLES, MODEL_VERSION, PROTO_STRIDE, type ParticleWorldModel } from "../src/extra/pmatch/model.ts";
import { particlesAt, prepare, type View } from "../src/extra/pmatch/sample.ts";
import { runDynamics } from "../src/extra/pmatch/tcn.ts";

const SHAPE = { inputs: FEATURES, channels: 4, kernel: 3, dilations: [1, 2], outputs: 3 };
// The skip weights come last, after the head's bias.
const SKIP = dynamicsWeightCount(SHAPE) - SHAPE.outputs * SHAPE.inputs;
const HEAD_BIAS = SKIP - SHAPE.outputs;
const HEAD = HEAD_BIAS - SHAPE.outputs * SHAPE.channels;

/** A model whose log clock speed follows the first band (through its skip) plus a small convolutional trunk. */
function syntheticModel(): ParticleWorldModel {
  const weights = Float32Array.from({ length: dynamicsWeightCount(SHAPE) }, (_, i) => 0.05 * Math.sin(1.7 * i));
  for (const output of [1, 2]) {
    for (let c = 0; c < SHAPE.channels; c++) weights[HEAD + output * SHAPE.channels + c] = 0;
    for (let i = 0; i < SHAPE.inputs; i++) weights[SKIP + output * SHAPE.inputs + i] = 0;
    weights[HEAD_BIAS + output] = 0;
  }
  weights[SKIP] = 0.8;
  const count = 40;
  const prototypes = new Float32Array(count * PROTO_STRIDE);
  for (let i = 0; i < count; i++) {
    const a = i * 2.399963;
    prototypes.set([0.02 * Math.cos(a), 0.02 * Math.sin(a), -0.1 - (0.3 * i) / count, 0.05 * Math.cos(a), 0.05 * Math.sin(a), 0, 0.002, 0.6, 2 + (i % 5), i % 2], i * PROTO_STRIDE);
  }
  return {
    version: MODEL_VERSION,
    rate: 300,
    preRun: 6,
    sizeDepth: 0.1,
    lightDepth: 0.2,
    prototypes,
    weights: Float32Array.from({ length: count }, (_, i) => 0.5 + (i % 3)),
    jitter: new Float32Array(JITTER_COUNT).fill(0.04),
    opacityOverLife: Float32Array.from({ length: LIFE_SAMPLES }, (_, k) => Math.sin((Math.PI * (k + 0.5)) / LIFE_SAMPLES)),
    sprites: { size: 8, reach: 5, count: 2, data: Float32Array.from({ length: 128 }, (_, i) => (i % 9) / 8), tint: Float32Array.of(1, 1, 1, 0.9, 0.95, 1) },
    dynamics: { rate: 100, ...SHAPE, weights },
    shake: { frequency: 3, x: 4, y: 2, tilt: 0.5, level: 0.3 },
    source: { name: "synthetic", width: 1920, height: 1080, frameRate: 60, mirrorAxis: null, center: [960, 540], train: [10, 40] },
    trainer: { framework: "pytorch", version: "test", device: "cpu", deviceName: "test", seconds: 1 },
    report: { tracks: 10 },
  };
}

/** Five seconds of features with the first band's fast envelope at 2 from 1 s to 2 s. */
function bassFeatures(): AudioFeatures {
  const rate = 100;
  const frames = 5 * rate;
  const data = new Float32Array(frames * FEATURES);
  for (let k = rate; k < 2 * rate; k++) data[k * FEATURES] = 2;
  return { rate, frames, dims: FEATURES, data };
}

describe("the Particle Match clock", () => {
  const model = syntheticModel();
  const features = bassFeatures();

  it("integrates its network's speed monotonically, as a direct sum", () => {
    const clock = new Clock(model.dynamics, features, model.preRun, { reactivity: 1, speed: 1 });
    const outputs = runDynamics(model.dynamics, features.data, features.frames);
    const speeds = Array.from({ length: features.frames }, (_, k) => Math.exp(Math.max(-3, Math.min(3, outputs[k * SHAPE.outputs]))));
    for (const t of [0.37, 1.25, 2.5, 4.99]) {
      const x = t * features.rate;
      const k = Math.floor(x);
      const direct = speeds.slice(0, k).reduce((s, v) => s + v / features.rate, 0) + ((x - k) * speeds[k]) / features.rate;
      expect(clock.timeAt(t) - model.preRun).toBeCloseTo(direct, 9);
    }
    let previous = -Infinity;
    for (let t = 0; t < 5; t += 0.013) {
      const tau = clock.timeAt(t);
      expect(tau).toBeGreaterThan(previous);
      previous = tau;
    }
  });

  it("runs faster on the bass it follows", () => {
    const clock = new Clock(model.dynamics, features, model.preRun, { reactivity: 1, speed: 1 });
    expect(clock.speedAt(1.5)).toBeGreaterThan(3 * clock.speedAt(3.5));
  });

  it("keeps one speed at Reactivity 0", () => {
    const clock = new Clock(model.dynamics, features, model.preRun, { reactivity: 0, speed: 1 });
    expect(clock.speedAt(1.5)).toBeCloseTo(clock.speedAt(3.5), 12);
    expect(clock.speedAt(0.2)).toBeCloseTo(clock.speedAt(3.5), 12);
  });

  it("holds its silent speed without a sound track", () => {
    const silent = new Clock(model.dynamics, null, 0, { reactivity: 1, speed: 2 });
    const quiet = new Clock(model.dynamics, features, 0, { reactivity: 0, speed: 2 });
    expect(silent.speedAt(10)).toBeCloseTo(quiet.speedAt(3.5), 12);
    expect(silent.timeAt(3)).toBeCloseTo(3 * silent.speedAt(0), 12);
  });
});

describe("a stored Particle Match model", () => {
  it("survives encoding and decoding bit for bit", () => {
    const bytes = encodeModel(syntheticModel());
    const decoded = decodeModel(bytes);
    expect(Buffer.from(encodeModel(decoded)).equals(Buffer.from(bytes))).toBe(true);
    expect(decoded.dynamics.dilations).toEqual(SHAPE.dilations);
    expect(decoded.trainer.framework).toBe("pytorch");
  });

  it("is refused when its network's weights do not fit its shape", () => {
    const model = syntheticModel();
    model.dynamics = { ...model.dynamics, weights: model.dynamics.weights.subarray(1) };
    expect(() => decodeModel(encodeModel(model))).toThrow(/wrong length/);
  });
});

describe("Particle Match sampling", () => {
  it("draws the same particles at a moment however it is reached", () => {
    const prepared = prepare(syntheticModel());
    const view: View = { x: 960, y: 540, scale: 1080, width: 1920, height: 1080, size: 1, light: 1, density: 1.5, seed: 7 };
    const first = particlesAt(prepared, 20, 1, view);
    const snapshot = first.data.slice(0, first.count * 5);
    expect(first.count).toBeGreaterThan(100);
    particlesAt(prepared, 27.5, 1, view, first);
    const again = particlesAt(prepared, 20, 1, view, first);
    expect(again.data.slice(0, again.count * 5)).toEqual(snapshot);
  });
});
