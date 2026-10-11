// Synthetic Particle Match inputs for the tests: a small world model and sound features.
import { FEATURES, type AudioFeatures } from "../src/extra/pmatch/audio.ts";
import {
  dynamicsWeightCount,
  JITTER_COUNT,
  LIFE_SAMPLES,
  MODEL_VERSION,
  P_AMP,
  P_LIFE,
  P_OX,
  P_OY,
  P_SIZE,
  P_SPRITE,
  P_VX,
  P_VY,
  P_VZ,
  PROTO_STRIDE,
  type ParticleWorldModel,
} from "../src/extra/pmatch/model.ts";

/** A small audio network; its log clock speed is its head's bias plus its skip from the first feature (the skip weights come last). */
const SHAPE = { inputs: FEATURES, channels: 2, kernel: 3, dilations: [1], outputs: 3 };
const SPEED_SKIP = dynamicsWeightCount(SHAPE) - SHAPE.outputs * SHAPE.inputs;
/** Index of the bias of the model's log clock speed among its dynamics weights. */
export const SPEED_BIAS = SPEED_SKIP - SHAPE.outputs;

/** 96 prototypes over two Gaussian sprites, slower ones living longer, whose clock speed follows the first audio feature. */
export function syntheticModel(mirrorAxis: number | null): ParticleWorldModel {
  const count = 96;
  const prototypes = new Float32Array(count * PROTO_STRIDE);
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count;
    const p = prototypes.subarray(i * PROTO_STRIDE, (i + 1) * PROTO_STRIDE);
    const angle = i * 2.399963;
    p[P_VX] = 0.02 * Math.cos(angle);
    p[P_VY] = 0.02 * Math.sin(angle);
    p[P_VZ] = -(0.05 + 0.3 * u);
    p[P_OX] = 0.3 * Math.cos(angle * 1.7);
    p[P_OY] = 0.2 * Math.sin(angle * 1.3);
    p[P_SIZE] = 0.0015 + (0.001 * ((i * 7) % 5)) / 4;
    p[P_AMP] = 0.5 + (0.4 * ((i * 3) % 7)) / 6;
    p[P_LIFE] = 1 + 8 * (1 - u);
    p[P_SPRITE] = i % 2;
  }
  const size = 32;
  const reach = 4;
  const data = new Float32Array(2 * size * size);
  for (let k = 0; k < 2; k++) {
    const sigma = k ? 0.6 : 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const rho = (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2)) * reach;
        data[k * size * size + y * size + x] = Math.exp(-((rho / sigma) ** 2) / 2);
      }
    }
  }
  // Log clock speed follows the first feature.
  const weights = new Float32Array(dynamicsWeightCount(SHAPE));
  weights[SPEED_SKIP] = 1;
  return {
    version: MODEL_VERSION,
    rate: 200,
    preRun: 10,
    sizeDepth: 0.1,
    lightDepth: 0.2,
    prototypes,
    weights: new Float32Array(count).fill(1),
    jitter: new Float32Array(JITTER_COUNT).fill(0.05),
    opacityOverLife: Float32Array.from({ length: LIFE_SAMPLES }, (_, k) => 0.6 + 0.4 * Math.sin((Math.PI * k) / (LIFE_SAMPLES - 1))),
    sprites: { size, reach, count: 2, data, tint: Float32Array.from([1, 1, 1, 0.9, 0.95, 1]) },
    dynamics: { rate: 100, ...SHAPE, weights },
    shake: null,
    source: { name: "synthetic.mp4", width: 1280, height: 720, frameRate: 30, mirrorAxis, center: [600, 350], train: [0, 10] },
    trainer: { framework: "pytorch", version: "test", device: "cpu", deviceName: "test", seconds: 0 },
    report: {},
  };
}

/** Features whose first band swings once a second. */
export function swingingFeatures(seconds: number): AudioFeatures {
  const rate = 100;
  const frames = seconds * rate;
  const data = new Float32Array(frames * FEATURES);
  for (let k = 0; k < frames; k++) data[k * FEATURES] = 0.5 * Math.sin((2 * Math.PI * k) / rate);
  return { rate, frames, dims: FEATURES, data };
}
