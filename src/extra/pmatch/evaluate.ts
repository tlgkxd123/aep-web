// How well a model matches a held-out window of its reference video. The video's
// particles are found as in training; the model is rendered over the video's own
// background, and its particles are found by the same detector through the same
// masks and linked by the same tracker. Mirroring is measured on white-residual
// maps of whole frames: the video's (mirrored at its axis) and the model's
// particles alone.
import { DEFAULT_DETECTOR, Detector, type DetectorOptions } from "./detect.ts";
import { Clock } from "./dynamics.ts";
import { decodeWindow, videoInfo } from "./frames.ts";
import { createGpu, frameTexture, uploadFrame, type Gpu } from "./gpu.ts";
import { compare, measure, median, spriteMatch, type Comparison, type SpriteMatch } from "./metrics.ts";
import type { ParticleWorldModel } from "./model.ts";
import { analyseVideo, mirrorCorrelation, referenceView, synthesize, Synthesizer, videoAudioFeatures, type FrameMask, type VideoAnalysis } from "./pipeline.ts";
import { prepare, type Prepared, type View } from "./sample.ts";
import { correlation, meanTemplate } from "./sprites.ts";
import { DEFAULT_TRACKER, particleDetection, track } from "./track.ts";

/** Pixels around the mirror axis left out of the mirror correlation. */
const AXIS_MARGIN = 40;
/** Times (shares of the window) the mirror correlation is measured at. */
const MIRROR_TIMES = [0.25, 0.5, 0.75];

export interface Evaluation {
  seconds: number;
  frames: number;
  /** [reference, model] pairs. */
  count: [number, number];
  peak: [number, number];
  spread: [number, number];
  radius: [number, number];
  steps: [number, number];
  crops: [number, number];
  comparison: Comparison;
  /** Each sprite class against the reference crops most like it. */
  sprites: SpriteMatch[];
  /** The mean crop of the model's particles against the reference's. */
  meanSprite: number;
  /** Mirror correlations (the median over a few frames) and the axis they are measured about. */
  mirror: { reference: number; model: number; axis: number };
  /** The model clock's mean speed over the window (clock seconds per second). */
  clockSpeed: number;
}

export async function evaluateModel(blob: Blob, model: ParticleWorldModel, from: number, to: number): Promise<Evaluation> {
  const started = performance.now();
  const info = await videoInfo(blob);
  const features = await videoAudioFeatures(blob);
  const gpu = createGpu();
  try {
    const analysis = await analyseVideo(gpu, blob, info, from, to);
    const { frames } = analysis;
    const prepared = prepare(model);
    const clock = new Clock(model.dynamics, features, model.preRun, { reactivity: 1, speed: 1 });
    const view = referenceView(model);
    const range = [frames[0].index, frames[frames.length - 1].index + 1] as const;
    const ours = await synthesize(gpu, analysis, prepared, clock, view, [range], true);
    const tracker = { ...DEFAULT_TRACKER, accept: particleDetection };
    const center = model.source.center;
    const reference = measure(frames, track(frames, tracker), center);
    const mine = measure(ours.frames, track(ours.frames, tracker), center);
    const mirror = await mirrorScores(gpu, blob, analysis, prepared, clock, view, from, to);
    gpu.release(analysis.background);
    return {
      seconds: (performance.now() - started) / 1000,
      frames: frames.length,
      count: [reference.count, mine.count],
      peak: [median(reference.peaks), median(mine.peaks)],
      spread: [median(reference.spreads), median(mine.spreads)],
      radius: [median(reference.radii), median(mine.radii)],
      steps: [reference.steps.length, mine.steps.length],
      crops: [analysis.crops.length, ours.crops.length],
      comparison: compare(reference, mine, info.frameRate),
      sprites: spriteMatch(model.sprites, analysis.crops),
      meanSprite: correlation(meanTemplate(analysis.crops), meanTemplate(ours.crops)),
      mirror,
      clockSpeed: (clock.timeAt(to) - clock.timeAt(from)) / (to - from),
    };
  } finally {
    gpu.dispose();
  }
}

async function mirrorScores(gpu: Gpu, blob: Blob, analysis: VideoAnalysis, model: Prepared, clock: Clock, view: View, from: number, to: number): Promise<Evaluation["mirror"]> {
  const { info } = analysis;
  const W = info.width;
  const H = info.height;
  const fps = info.frameRate;
  const axis = analysis.mirror?.axis ?? W / 2;
  const options: DetectorOptions = { ...DEFAULT_DETECTOR, region: [0, 0, W, H], openEdges: [true, true, true, true] };
  const texture = frameTexture(gpu.gl, W, H);
  const synth = new Synthesizer(gpu, W, H);
  const references: number[] = [];
  const models: number[] = [];
  try {
    for (const share of MIRROR_TIMES) {
      const index = Math.round((from + share * (to - from)) * fps);
      let detector = new Detector(gpu, options);
      const warmup = detector.warmup;
      let mask = null as FrameMask | null;
      await decodeWindow(blob, info, (index - warmup) / fps, (index + 0.5) / fps, (frame, at) => {
        if (mask) return;
        uploadFrame(gpu.gl, texture, frame);
        detector.process(texture, W, H);
        if (at < index || !detector.warm) return;
        mask = { data: detector.read().mask, columns: detector.grid[0], tile: options.tile };
        references.push(mirrorCorrelation(gpu, detector.residualTexture, W, H, axis, AXIS_MARGIN, mask));
      });
      detector.dispose();
      if (!mask) continue;
      detector = new Detector(gpu, options);
      for (let at = index - warmup; at <= index; at++) detector.process(synth.render(model, clock, at / fps, view, null), W, H);
      models.push(mirrorCorrelation(gpu, detector.residualTexture, W, H, axis, AXIS_MARGIN, mask));
      detector.dispose();
    }
  } finally {
    synth.dispose();
    gpu.gl.deleteTexture(texture);
  }
  return { reference: median(references), model: median(models), axis };
}
