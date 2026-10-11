// Plays a trained model on a visible canvas: its particles over black at any time of
// the reference video, with the clock driven by the reference's sound, framed as the
// reference was (same emitter, same scale relative to the frame height).
import type { AudioFeatures } from "./audio.ts";
import { Clock } from "./dynamics.ts";
import { createGpu, type Gpu } from "./gpu.ts";
import type { ParticleWorldModel } from "./model.ts";
import { Synthesizer } from "./pipeline.ts";
import { prepare, type Prepared, type View } from "./sample.ts";

const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform int u_height;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = vec4(texelFetch(u_src, ivec2(p.x, u_height - 1 - p.y), 0).rgb, 1.0);
}`;

export class ModelPreview {
  readonly gpu: Gpu;
  private readonly synth: Synthesizer;
  private readonly prepared: Prepared;
  private readonly clock: Clock;
  private readonly view: View;
  private readonly output: ImageBitmapRenderingContext;

  constructor(canvas: HTMLCanvasElement, model: ParticleWorldModel, features: AudioFeatures | null) {
    const output = canvas.getContext("bitmaprenderer");
    if (!output) throw new Error("This browser cannot show the preview.");
    this.output = output;
    const { width, height } = canvas;
    this.gpu = createGpu(width, height);
    this.synth = new Synthesizer(this.gpu, width, height);
    this.prepared = prepare(model);
    this.clock = new Clock(model.dynamics, features, model.preRun, { reactivity: 1, speed: 1 });
    const { source } = model;
    const s = width / source.width;
    this.view = { x: source.center[0] * s, y: source.center[1] * s, scale: source.height * s, width, height, size: 1, light: 1, density: 1, seed: 1 };
  }

  /** Shows the particles at `t` seconds of the reference. */
  draw(t: number): void {
    const { gpu, view } = this;
    const frame = this.synth.render(this.prepared, this.clock, t, view, null);
    gpu.pass(gpu.program(PRESENT_FS), null, [frame], (u) => {
      gpu.gl.uniform1i(u("u_src"), 0);
      gpu.gl.uniform1i(u("u_height"), view.height);
    });
    this.output.transferFromImageBitmap(gpu.canvas.transferToImageBitmap());
  }

  dispose(): void {
    this.synth.dispose();
    this.gpu.dispose();
  }
}
