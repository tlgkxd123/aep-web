// The app runs the networks the PyTorch trainer exports exactly. The fixture comes from
//   uv run --project ml/pmatch python -m pmatch parity tests/data/pmatch-parity.json
// (ml/pmatch/pmatch/parity.py): a model with random networks as the effect stores it, features, and the
// outputs PyTorch computes for them in float64.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeModel, type Dynamics } from "../src/extra/pmatch/model.ts";
import { runDynamics } from "../src/extra/pmatch/tcn.ts";

interface Fixture {
  model: string;
  frames: number;
  dims: number;
  features: string;
  outputs: string;
  arrays: Record<"prototypes" | "weights" | "jitter" | "opacityOverLife" | "spriteData" | "spriteTint", string>;
}

const fixture = JSON.parse(readFileSync("tests/data/pmatch-parity.json", "utf8")) as Fixture;
const floats = (text: string) => {
  const bytes = Buffer.from(text, "base64");
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const model = decodeModel(new Uint8Array(Buffer.from(fixture.model, "base64")));
const features = floats(fixture.features);
const expected = floats(fixture.outputs);

const worstGap = (d: Dynamics) => {
  const ours = runDynamics(d, features, fixture.frames);
  expect(ours.length).toBe(expected.length);
  let worst = 0;
  for (let i = 0; i < ours.length; i++) worst = Math.max(worst, Math.abs(ours[i] - expected[i]));
  return worst;
};

describe("the PyTorch trainer's exported model in the app", () => {
  it("runs the audio network as PyTorch does over 2000 feature frames", () => {
    expect(fixture.frames).toBeGreaterThanOrEqual(2000);
    expect(fixture.dims).toBe(model.dynamics.inputs);
    expect(worstGap(model.dynamics)).toBeLessThan(1e-4);
  });

  it("notices a network that differs from PyTorch's in one weight", () => {
    const weights = Float32Array.from(model.dynamics.weights);
    weights[model.dynamics.channels * model.dynamics.inputs + model.dynamics.channels + 5] += 0.1;
    expect(worstGap({ ...model.dynamics, weights })).toBeGreaterThan(1e-3);
  });

  it("reads the bank, sprites and curves PyTorch wrote", () => {
    const a = fixture.arrays;
    expect(model.prototypes).toEqual(floats(a.prototypes));
    expect(model.weights).toEqual(floats(a.weights));
    expect(model.jitter).toEqual(floats(a.jitter));
    expect(model.opacityOverLife).toEqual(floats(a.opacityOverLife));
    expect(model.sprites.data).toEqual(floats(a.spriteData));
    expect(model.sprites.tint).toEqual(floats(a.spriteTint));
    expect(model.trainer.framework).toBe("pytorch");
    expect(model.shake).toEqual({ frequency: 2.5, x: 3, y: 2, tilt: 0.5, level: 0.4 });
  });
});
