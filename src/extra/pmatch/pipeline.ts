// Trains a Particle Match world model from a reference video: the browser decodes a
// window of the video and finds particles in every frame on the GPU (only
// detections, tile masks and a few hundred sprite crops come back), links them into
// tracks and measures the picture's shake; the PyTorch trainer (ml/pmatch, reached
// through a Trainer) learns the model from that; then the browser calibrates it by
// synthesis: it renders the model over the video's own background, finds its
// particles with the same detector through the same masks, and scales birth rate,
// light, size and the bank's weights until what is found matches the video.
import { audioFeatures, channelReader, decodeSoundTrack, type AudioFeatures } from "./audio.ts";
import {
  detectionStats,
  occupancy,
  quarterSpeeds,
  radiusQuarters,
  reweight,
  reweightSprites,
  scalePrototypes,
  scaleVelocities,
  stepBins,
  stepHistogram,
  velocitySteps,
  type DetectionStats,
} from "./calibrate.ts";
import { encodeDataset } from "./dataset.ts";
import { DEFAULT_DETECTOR, Detector, DETECTION_FLOATS, D_PEAK, D_X, D_Y, HISTORY, type DetectorOptions, type DetectorOutput } from "./detect.ts";
import { drawParticles } from "./draw.ts";
import { Clock } from "./dynamics.ts";
import { decodeWindow, videoInfo, type VideoInfo } from "./frames.ts";
import { createGpu, frameTexture, readFloats, uploadFrame, type Gpu, type Surface } from "./gpu.ts";
import { classShares, measure } from "./metrics.ts";
import { decodeModel, type ParticleWorldModel } from "./model.ts";
import { INSTANCE_FLOATS, particlesAt, prepare, random, type Instances, type Prepared, type View } from "./sample.ts";
import { measureShake, ShakeMeter, shakeTrack, type FrameMotion, type MeasuredShake } from "./shake.ts";
import { CROP, CROP_PEAK, CropGatherer, type Crop } from "./sprites.ts";
import { DEFAULT_TRACKER, focusOfExpansion, MIN_PEAK, particleDetection, track, type FrameDetections, type Track } from "./track.ts";

export interface TrainProgress {
  stage: string;
  /** 0..1 over the whole training. */
  share: number;
}

/**
 * Trains the PyTorch world model on a window's analysis (dataset.ts) and gives the model encoded
 * (model.ts), before calibration; `onProgress` shares run from 0 to 1.
 */
export type Trainer = (dataset: Uint8Array<ArrayBuffer>, onProgress: (stage: string, share: number) => void, signal?: AbortSignal) => Promise<Uint8Array>;

export interface TrainOptions {
  /** Training window, seconds of the video. */
  from: number;
  to: number;
  /** The video's sound features when already computed (videoAudioFeatures); read from the video otherwise. */
  features?: AudioFeatures | null;
  trainer: Trainer;
  onProgress?: (p: TrainProgress) => void;
  signal?: AbortSignal;
  /** Calibration rounds (each renders and analyses a few seconds of the model). */
  calibration?: number;
}

const BACKGROUND_SAMPLES = HISTORY;
/** Frames between cropped frames, most crops per frame, and crops in all (spread over the window). */
const CROP_EVERY = 4;
const CROPS_PER_FRAME = 16;
const MAX_CROPS = 1500;

/** Crops a cropped frame may take: an even share of what is left, so every part of a window is cropped. */
class CropBudget {
  private left: number;
  private taken = 0;

  /** `frames`: the frames the crops are spread over. */
  constructor(frames: number) {
    this.left = Math.max(1, Math.ceil(frames / CROP_EVERY));
  }

  get spent(): boolean {
    return this.taken >= MAX_CROPS;
  }

  /** The centres the next cropped frame takes of `centres` (its candidates, in the order they are worth taking). */
  take<T>(centres: (limit: number) => T[]): T[] {
    const share = Math.ceil((MAX_CROPS - this.taken) / Math.max(1, this.left));
    this.left--;
    const taken = centres(Math.max(0, Math.min(CROPS_PER_FRAME, share)));
    this.taken += taken.length;
    return taken;
  }
}
/** Pixels a cropped particle keeps clear of other particles (its halo's reach). */
const ISOLATION = 20;
/** Pixels kept clear of a mirror axis. */
const AXIS_MARGIN = 20;
/** Frames the detector needs before its median background is complete. */
const WARMUP = DEFAULT_DETECTOR.historyStride * HISTORY;

const HALF_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  vec3 c = texelFetch(u_src, p, 0).rgb + texelFetch(u_src, p + ivec2(1, 0), 0).rgb + texelFetch(u_src, p + ivec2(0, 1), 0).rgb + texelFetch(u_src, p + ivec2(1, 1), 0).rgb;
  outColor = vec4(c * 0.25, 1.0);
}`;

const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0); }`;

const MEDIAN_FS = `#version 300 es
precision highp float;
uniform sampler2D u_h[8];
out vec4 outColor;
#define SORT(a, b) { vec3 lo = min(v[a], v[b]); v[b] = max(v[a], v[b]); v[a] = lo; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 v[8];
  v[0] = texelFetch(u_h[0], p, 0).rgb; v[1] = texelFetch(u_h[1], p, 0).rgb;
  v[2] = texelFetch(u_h[2], p, 0).rgb; v[3] = texelFetch(u_h[3], p, 0).rgb;
  v[4] = texelFetch(u_h[4], p, 0).rgb; v[5] = texelFetch(u_h[5], p, 0).rgb;
  v[6] = texelFetch(u_h[6], p, 0).rgb; v[7] = texelFetch(u_h[7], p, 0).rgb;
  SORT(0, 1) SORT(2, 3) SORT(4, 5) SORT(6, 7)
  SORT(0, 2) SORT(1, 3) SORT(4, 6) SORT(5, 7)
  SORT(1, 2) SORT(5, 6)
  SORT(0, 4) SORT(1, 5) SORT(2, 6) SORT(3, 7)
  SORT(2, 4) SORT(3, 5)
  SORT(1, 2) SORT(3, 4) SORT(5, 6)
  outColor = vec4(0.5 * (v[3] + v[4]), 1.0);
}`;

/** Where a mirrored picture's axis is (frame pixels, continuous coordinates) and how alike the halves are. */
export interface Mirror {
  axis: number;
  score: number;
}

/** Side of the blocks the halves are compared in (half-resolution pixels). */
const MIRROR_BLOCK = 24;
/** Mirror score from which a picture counts as mirrored. */
export const MIRRORED = 0.9;

/**
 * Finds a left-right mirror axis near the middle of a frame at half resolution. The score is the median
 * correlation of mirrored blocks, so a part drawn over the mirrored picture (a logo's lettering) does not
 * hide the mirror.
 */
function readHalf(gpu: Gpu, texture: WebGLTexture, w: number, h: number): Float32Array {
  const gl = gpu.gl;
  const half = gpu.surface(w, h, gl.RGBA16F);
  gpu.pass(gpu.program(HALF_FS), half, [texture], (u) => gl.uniform1i(u("u_src"), 0));
  const pixels = readFloats(gl, half.framebuffer, 0, w, h);
  gpu.release(half);
  return pixels;
}

export function findMirror(gpu: Gpu, frame: WebGLTexture, width: number, height: number): Mirror {
  const w = Math.floor(width / 2);
  const h = Math.floor(height / 2);
  const pixels = readHalf(gpu, frame, w, h);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2];
  // Pixels i and s − i mirror each other; the axis is at (s + 1) / 2 half-resolution pixels.
  const score = (s: number) => {
    const scores: number[] = [];
    for (let y0 = 0; y0 + MIRROR_BLOCK <= h; y0 += MIRROR_BLOCK) {
      for (let x0 = 4; x0 + MIRROR_BLOCK <= s / 2 - 4; x0 += MIRROR_BLOCK) {
        if (s - x0 >= w) continue;
        let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
        for (let y = y0; y < y0 + MIRROR_BLOCK; y++) {
          for (let i = x0; i < x0 + MIRROR_BLOCK; i++) {
            const a = lum[y * w + i];
            const b = lum[y * w + s - i];
            n++;
            sa += a;
            sb += b;
            saa += a * a;
            sbb += b * b;
            sab += a * b;
          }
        }
        const va = saa - (sa * sa) / n;
        const vb = sbb - (sb * sb) / n;
        // Flat blocks (sky) say nothing either way.
        if (va > n * 1e-4 && vb > n * 1e-4) scores.push((sab - (sa * sb) / n) / Math.sqrt(va * vb));
      }
    }
    if (scores.length < 8) return 0;
    scores.sort((a, b) => a - b);
    return scores[scores.length >> 1];
  };
  let best = w - 1;
  let bestScore = -Infinity;
  const scores = new Map<number, number>();
  for (let s = w - 1 - 32; s <= w - 1 + 32; s++) {
    const v = score(s);
    scores.set(s, v);
    if (v > bestScore) {
      bestScore = v;
      best = s;
    }
  }
  // Parabola through the best and its neighbours.
  const l = scores.get(best - 1) ?? bestScore;
  const r = scores.get(best + 1) ?? bestScore;
  const curve = l - 2 * bestScore + r;
  const shift = curve < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / curve)) : 0;
  return { axis: best + shift + 1, score: bestScore };
}

/** A detector's tile mask over a whole frame: 1 where tiles are analysed, rows top first. */
export interface FrameMask {
  data: Uint8Array;
  columns: number;
  tile: number;
}

/**
 * Correlation of a frame-sized map's red channel (a detector's white residual) on the left of `axis`
 * (frame pixels) with its mirror image on the right, at half resolution, leaving out `margin` pixels
 * around the axis and the pixels whose tile (or mirrored tile) `mask` leaves out.
 */
export function mirrorCorrelation(gpu: Gpu, map: WebGLTexture, width: number, height: number, axis: number, margin: number, mask: FrameMask | null): number {
  const w = Math.floor(width / 2);
  const h = Math.floor(height / 2);
  const pixels = readHalf(gpu, map, w, h);
  const analysed = (x: number, y: number) => !mask || mask.data[Math.floor(y / mask.tile) * mask.columns + Math.floor(x / mask.tile)] === 1;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; 2 * x + 1 < axis - margin; x++) {
      // Pixel centre x + 0.5 mirrors to 2·axis − (x + 0.5) at half resolution.
      const m = axis - x - 1;
      const m0 = Math.floor(m);
      const f = m - m0;
      if (m0 + 1 >= w || !analysed(2 * x, 2 * y) || !analysed(2 * m0, 2 * y) || !analysed(2 * m0 + 2, 2 * y)) continue;
      const a = pixels[(y * w + x) * 4];
      const b = pixels[(y * w + m0) * 4] * (1 - f) + pixels[(y * w + m0 + 1) * 4] * f;
      n++;
      sa += a;
      sb += b;
      saa += a * a;
      sbb += b * b;
      sab += a * b;
    }
  }
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return n > 0 && va > 0 && vb > 0 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : 0;
}

/** Analysis region and open edges for a frame size and mirror. */
export function regionFor(width: number, height: number, mirror: Mirror | null): Pick<DetectorOptions, "region" | "openEdges"> {
  if (!mirror) return { region: [0, 0, width, height], openEdges: [true, true, true, true] };
  return { region: [0, 0, Math.max(16, Math.floor(mirror.axis - AXIS_MARGIN)), height], openEdges: [true, true, false, true] };
}

/** Keeps the detections whose tile is analysed in `mask`. */
export function maskDetections(data: Float32Array, mask: Uint8Array, options: DetectorOptions, columns: number): Float32Array {
  const keep: number[] = [];
  const [x0, y0] = options.region;
  for (let at = 0; at < data.length; at += DETECTION_FLOATS) {
    const tx = Math.floor((data[at + D_X] - x0) / options.tile);
    const ty = Math.floor((data[at + D_Y] - y0) / options.tile);
    if (mask[ty * columns + tx]) keep.push(at);
  }
  const out = new Float32Array(keep.length * DETECTION_FLOATS);
  keep.forEach((at, i) => out.set(data.subarray(at, at + DETECTION_FLOATS), i * DETECTION_FLOATS));
  return out;
}

/**
 * Bright detections on analysed tiles with no other particle within their halo: the ones worth cropping for
 * sprites, visited in an order shuffled per frame so that every part of the picture is cropped.
 */
function cropCentres(frame: number, detections: Float32Array, mask: Uint8Array, options: DetectorOptions, columns: number, width: number, height: number, limit: number): { frame: number; x: number; y: number }[] {
  const centres: { frame: number; x: number; y: number }[] = [];
  const n = detections.length / DETECTION_FLOATS;
  const margin = (CROP + 1) / 2;
  const tiles = Math.ceil((CROP - 1) / 2 / options.tile);
  const order = Int32Array.from({ length: n }, (_, i) => i);
  const rand = random(Math.imul(frame + 1, 0x9e3779b1));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let k = 0; k < n && centres.length < limit; k++) {
    const i = order[k];
    const at = i * DETECTION_FLOATS;
    const x = detections[at + D_X];
    const y = detections[at + D_Y];
    if (detections[at + D_PEAK] < CROP_PEAK || x < margin || y < margin || x > width - margin || y > height - margin) continue;
    let isolated = true;
    for (let j = 0; j < n && isolated; j++) {
      if (j !== i && Math.hypot(detections[j * DETECTION_FLOATS + D_X] - x, detections[j * DETECTION_FLOATS + D_Y] - y) < ISOLATION) isolated = false;
    }
    const tx = Math.floor((x - options.region[0]) / options.tile);
    const ty = Math.floor((y - options.region[1]) / options.tile);
    let clear = tx >= tiles && tx + tiles < columns;
    for (let dy = -tiles; dy <= tiles && clear; dy++) for (let dx = -tiles; dx <= tiles && clear; dx++) if (!mask[(ty + dy) * columns + tx + dx]) clear = false;
    if (isolated && clear) centres.push({ frame, x, y });
  }
  return centres;
}

/** What a window of a video shows: per-frame detections and tile masks, sprite crops and its background. */
export interface VideoAnalysis {
  info: VideoInfo;
  /** The mirror found in the first frame, when its halves are alike enough to call it one. */
  mirror: Mirror | null;
  mirrorScore: number;
  options: DetectorOptions;
  columns: number;
  rows: number;
  frames: FrameDetections[];
  /** masks[k] belongs to frames[k]. */
  masks: Uint8Array[];
  /** motions[k]: how frames[k]'s picture moved since the frame before it (null when not measured). */
  motions: (FrameMotion | null)[];
  crops: Crop[];
  /** Per-pixel median of frames spread over the window (the caller releases it). */
  background: Surface;
}

/**
 * Frames kept for their sprite crops until their detections come back from the GPU, a few frames later:
 * each frame with the median of the detector's past frames as its background, which moving particles
 * (halos included) are not part of.
 */
class CropFrames {
  private readonly gpu: Gpu;
  private readonly size: [number, number];
  private readonly free: { frame: Surface; back: Surface }[] = [];
  private readonly kept = new Map<number, { frame: Surface; back: Surface }>();

  constructor(gpu: Gpu, width: number, height: number) {
    this.gpu = gpu;
    this.size = [width, height];
  }

  keep(index: number, frame: WebGLTexture, history: WebGLTexture[]): void {
    if (history.length !== HISTORY) return;
    const { gpu } = this;
    const gl = gpu.gl;
    const slot = this.free.pop() ?? { frame: gpu.surface(this.size[0], this.size[1], gl.RGBA8), back: gpu.surface(this.size[0], this.size[1], gl.RGBA8) };
    gpu.pass(gpu.program(COPY_FS), slot.frame, [frame], (u) => gl.uniform1i(u("u_src"), 0));
    gpu.pass(gpu.program(MEDIAN_FS), slot.back, history, (u) => gl.uniform1iv(u("u_h[0]"), history.map((_, i) => i)));
    this.kept.set(index, slot);
  }

  holds(index: number): boolean {
    return this.kept.has(index);
  }

  /** Crops of kept frame `index` at `centres`, forgetting the frame; none when it was not kept. */
  gather(gatherer: CropGatherer, index: number, centres: { frame: number; x: number; y: number }[]): Crop[] {
    const slot = this.kept.get(index);
    if (!slot) return [];
    this.kept.delete(index);
    this.free.push(slot);
    return gatherer.gather(slot.frame.texture, this.size, slot.back.texture, [0, 0], this.size, centres);
  }

  dispose(): void {
    for (const slot of [...this.free, ...this.kept.values()]) {
      this.gpu.release(slot.frame);
      this.gpu.release(slot.back);
    }
    this.free.length = 0;
    this.kept.clear();
  }
}

/** Runs the detector over [from, to) of a video (the first frame decides the mirror and region). */
export async function analyseVideo(gpu: Gpu, blob: Blob, info: VideoInfo, from: number, to: number, onShare?: (share: number) => void, signal?: AbortSignal): Promise<VideoAnalysis> {
  const gl = gpu.gl;
  const W = info.width;
  const H = info.height;
  const texture = frameTexture(gl, W, H);
  // Set from the first decoded frame (the mirror decides the region).
  let detector = null as Detector | null;
  let gatherer = null as CropGatherer | null;
  let cropFrames = null as CropFrames | null;
  let meter = null as ShakeMeter | null;
  let mirror = null as Mirror | null;
  let mirrorScore = 0;
  let options = null as DetectorOptions | null;
  const frames: FrameDetections[] = [];
  const masks: Uint8Array[] = [];
  /** The shake meter's capture of each recorded frame. */
  const captureOf = new Map<number, number>();
  const recordedCaptures: number[] = [];
  const crops: Crop[] = [];
  const backgrounds: Surface[] = [];
  const sampleTimes = Array.from({ length: BACKGROUND_SAMPLES }, (_, k) => from + ((k + 0.5) * (to - from)) / BACKGROUND_SAMPLES);
  const copy = () => {
    const s = gpu.surface(W, H, gl.RGBA8);
    gpu.pass(gpu.program(COPY_FS), s, [texture], (u) => gl.uniform1i(u("u_src"), 0));
    backgrounds.push(s);
  };
  let captures = 0;
  let queued = 0;
  const expected = Math.max(1, Math.round((to - from) * info.frameRate));
  const budget = new CropBudget(expected);
  const record = (reads: { tag: number; output: DetectorOutput }[]) => {
    for (const { tag: index, output } of reads) {
      frames.push({ index, data: output.detections });
      masks.push(output.mask);
      recordedCaptures.push(captureOf.get(index)!);
      captureOf.delete(index);
      if (cropFrames!.holds(index)) {
        const centres = budget.take((limit) => cropCentres(index, output.detections, output.mask, options!, detector!.grid[0], W, H, limit));
        crops.push(...cropFrames!.gather(gatherer!, index, centres));
      }
      if (frames.length % 30 === 0) onShare?.(Math.min(1, frames.length / expected));
    }
  };
  try {
    await decodeWindow(
      blob,
      info,
      Math.max(0, from - WARMUP / info.frameRate),
      to,
      (frame, index, time) => {
        uploadFrame(gl, texture, frame);
        if (!detector) {
          const found = findMirror(gpu, texture, W, H);
          mirrorScore = found.score;
          mirror = found.score >= MIRRORED ? found : null;
          options = { ...DEFAULT_DETECTOR, ...regionFor(W, H, mirror) };
          detector = new Detector(gpu, options);
          gatherer = new CropGatherer(gpu);
          cropFrames = new CropFrames(gpu, W, H);
          meter = new ShakeMeter(gpu, W, H);
        }
        meter!.capture(texture);
        const capture = captures++;
        detector.process(texture, W, H);
        if (backgrounds.length < BACKGROUND_SAMPLES && time >= sampleTimes[backgrounds.length]) copy();
        if (time < from - 1e-6 || !detector.warm) return;
        captureOf.set(index, capture);
        if (queued++ % CROP_EVERY === 0 && !budget.spent) cropFrames!.keep(index, texture, detector.historyTextures);
        record(detector.readLater(index));
        record(detector.collect());
        crops.push(...gatherer!.collect());
      },
      signal,
    );
    if (detector) record(detector.drain());
    if (gatherer) crops.push(...gatherer.drain());
    if (!detector || !options || frames.length < 30) throw new Error("The window has too few frames to analyse.");
    const measured = await meter!.finish();
    const motions = recordedCaptures.map((c) => measured[c] ?? null);
    while (backgrounds.length < BACKGROUND_SAMPLES) copy();
    const background = gpu.surface(W, H, gl.RGBA8);
    gpu.pass(gpu.program(MEDIAN_FS), background, backgrounds.map((s) => s.texture), (u) => gl.uniform1iv(u("u_h[0]"), backgrounds.map((_, i) => i)));
    const [columns, rows] = detector.grid;
    // The first frame may be caught mid-shake; the median of frames across the window is at rest.
    if (mirror) {
      const rest = findMirror(gpu, background.texture, W, H);
      if (rest.score >= MIRRORED) mirror = rest;
    }
    return { info, mirror, mirrorScore, options, columns, rows, frames, masks, motions, crops, background };
  } finally {
    detector?.dispose();
    gatherer?.dispose();
    cropFrames?.dispose();
    meter?.dispose();
    for (const s of backgrounds) gpu.release(s);
    gl.deleteTexture(texture);
  }
}

/** Renders a model over a background, frame by frame, into a frame-sized texture (rows top first). */
export class Synthesizer {
  readonly gpu: Gpu;
  private readonly frame: Surface;
  private readonly instances: Instances = { data: new Float32Array(4096 * INSTANCE_FLOATS), count: 0 };

  constructor(gpu: Gpu, width: number, height: number) {
    this.gpu = gpu;
    this.frame = gpu.surface(width, height, gpu.gl.RGBA8);
  }

  /** The model's particles at time t (seconds of the clock's timeline) over `background` (black when null). */
  render(model: Prepared, clock: Clock, t: number, view: View, background: WebGLTexture | null): WebGLTexture {
    const { gpu } = this;
    const gl = gpu.gl;
    if (background) gpu.pass(gpu.program(COPY_FS), this.frame, [background], (u) => gl.uniform1i(u("u_src"), 0));
    else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.frame.framebuffer);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    const found = particlesAt(model, clock.timeAt(t), clock.zoomAt(t), view, this.instances);
    // The frame's rows are top first: flip y for the drawing's GL row order.
    for (let i = 0; i < found.count; i++) found.data[i * INSTANCE_FLOATS + 1] = this.frame.height - found.data[i * INSTANCE_FLOATS + 1];
    drawParticles(gl, this.frame, 0, this.frame.width, this.frame.height, model, found);
    return this.frame.texture;
  }

  dispose(): void {
    this.gpu.release(this.frame);
  }
}

export interface Synthesis {
  frames: FrameDetections[];
  crops: Crop[];
}

/**
 * The model rendered over the analysis's background for frame index ranges [a, b), found by the same
 * detector and kept to the tiles the video's own masks analysed.
 */
export async function synthesize(gpu: Gpu, analysis: VideoAnalysis, model: Prepared, clock: Clock, view: View, ranges: readonly (readonly [number, number])[], withCrops = false): Promise<Synthesis> {
  const { info, options, columns } = analysis;
  const first = analysis.frames[0].index;
  const synth = new Synthesizer(gpu, info.width, info.height);
  const gatherer = withCrops ? new CropGatherer(gpu) : null;
  const cropFrames = withCrops ? new CropFrames(gpu, info.width, info.height) : null;
  const frames: FrameDetections[] = [];
  const crops: Crop[] = [];
  const budget = new CropBudget(ranges.reduce((sum, [a, b]) => sum + (b - a), 0));
  const record = (reads: { tag: number; output: DetectorOutput }[]) => {
    for (const { tag: index, output } of reads) {
      const mask = analysis.masks[index - first];
      const detections = maskDetections(output.detections, mask, options, columns);
      frames.push({ index, data: detections });
      if (!gatherer || !cropFrames?.holds(index)) continue;
      const centres = budget.take((limit) => cropCentres(index, detections, mask, options, columns, info.width, info.height, limit));
      crops.push(...cropFrames.gather(gatherer, index, centres));
    }
  };
  try {
    for (const [a, b] of ranges) {
      const detector = new Detector(gpu, options);
      let queued = 0;
      for (let index = a - WARMUP; index < b; index++) {
        const texture = synth.render(model, clock, index / info.frameRate, view, analysis.background.texture);
        detector.process(texture, info.width, info.height);
        if (index < a || !detector.warm || !analysis.masks[index - first]) continue;
        if (cropFrames && queued++ % CROP_EVERY === 0 && !budget.spent) cropFrames.keep(index, texture, detector.historyTextures);
        record(detector.readLater(index));
        record(detector.collect());
        if (gatherer) crops.push(...gatherer.collect());
      }
      record(detector.drain());
      detector.dispose();
      await new Promise((r) => setTimeout(r, 0));
    }
    if (gatherer) crops.push(...gatherer.drain());
  } finally {
    synth.dispose();
    gatherer?.dispose();
    cropFrames?.dispose();
  }
  return { frames, crops };
}

/** Audio features of a video's sound track (null when it has none the browser can decode). */
export async function videoAudioFeatures(blob: Blob): Promise<AudioFeatures | null> {
  const audio = await decodeSoundTrack(blob);
  if (!audio) return null;
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  return audioFeatures(channelReader(channels), audio.sampleRate, audio.length / audio.sampleRate);
}

/** The view a model is rendered in to compare with its reference: the reference's emitter and scale. */
export function referenceView(model: ParticleWorldModel): View {
  const { width, height, center } = model.source;
  return { x: center[0], y: center[1], scale: height, width, height, size: 1, light: 1, density: 1, seed: 1 };
}

export interface TrainResult {
  model: ParticleWorldModel;
  tracks: Track[];
  /** The reference's sound features (null when it has no sound the browser can decode). */
  features: AudioFeatures | null;
}

/** A window analysed for training: what the trainer learns from, and what calibration compares the model with. */
export interface TrainingWindow {
  info: VideoInfo;
  from: number;
  to: number;
  analysis: VideoAnalysis;
  tracks: Track[];
  /** Where the particles stream out of (the tracks' focus of expansion), frame pixels. */
  center: [number, number];
  features: AudioFeatures | null;
  shake: MeasuredShake;
  dataset: Uint8Array<ArrayBuffer>;
  /** Seconds spent reading the sound and finding particles. */
  soundSeconds: number;
  detectSeconds: number;
}

/** Analyses [from, to) of a video for training (the caller releases `analysis.background`). */
export async function analyseForTraining(
  gpu: Gpu,
  blob: Blob,
  name: string,
  window: { from: number; to: number; features?: AudioFeatures | null },
  progress: (stage: string, share: number) => void,
  signal?: AbortSignal,
): Promise<TrainingWindow> {
  let mark = performance.now();
  progress("Reading the video", 0);
  const info = await videoInfo(blob);
  const from = Math.max(0, Math.min(window.from, info.duration - 1));
  const to = Math.max(from + 1, Math.min(window.to, info.duration));
  progress("Reading the sound", 0.03);
  const features = window.features !== undefined ? window.features : await videoAudioFeatures(blob);
  const soundSeconds = (performance.now() - mark) / 1000;
  mark = performance.now();
  progress("Finding particles", 0.08);
  const analysis = await analyseVideo(gpu, blob, info, from, to, (share) => progress("Finding particles", 0.08 + 0.87 * share), signal);
  const detectSeconds = (performance.now() - mark) / 1000;
  progress("Following particles", 0.95);
  await new Promise((r) => setTimeout(r, 0));
  const tracks = track(analysis.frames, { ...DEFAULT_TRACKER, accept: particleDetection });
  const [rx, ry, rw, rh] = analysis.options.region;
  const center: [number, number] = focusOfExpansion(tracks.filter((t) => t.points.length >= 12)) ?? [rx + rw / 2, ry + rh / 2];
  const shake = measureShake(shakeTrack(analysis.motions, info.frameRate), info.frameRate);
  const dataset = encodeDataset({ name, from, to, analysis, tracks, center, features, shake });
  return { info, from, to, analysis, tracks, center, features, shake, dataset, soundSeconds, detectSeconds };
}

/** The analysis of [from, to) of a video as the trainer reads it (dataset.ts). */
export async function exportDataset(blob: Blob, name: string, from: number, to: number): Promise<Uint8Array<ArrayBuffer>> {
  const gpu = createGpu();
  try {
    const window = await analyseForTraining(gpu, blob, name, { from, to }, () => {});
    gpu.release(window.analysis.background);
    return window.dataset;
  } finally {
    gpu.dispose();
  }
}

/**
 * Share of the measured correction a calibration round applies to the bank's velocities and weights: both
 * move the outward speeds (as brightening does, by showing more of the slow, distant particles), so full
 * steps of each overshoot.
 */
const SPEED_STEP = 0.5;

const logOff = (a: number, b: number) => (a > 0 && b > 0 ? Math.abs(Math.log(a / b)) : 10);

/**
 * Calibration by synthesis over a few short stretches of the window: rounds of rendering the model over the
 * window's background and scaling its birth rate, light, size and velocities and reweighting its bank by
 * what the detector finds and by the sprites its crops look like. Keeps the round that came closest to the
 * reference and returns what it found.
 */
async function calibrateModel(gpu: Gpu, window: TrainingWindow, model: ParticleWorldModel, rounds: number, onRound: (round: number) => void): Promise<Record<string, number>> {
  const { analysis, tracks, center, features, from, to } = window;
  const { frames, options: opts } = analysis;
  const fps = window.info.frameRate;
  const stretch = Math.min(3, (to - from) / 3);
  const ranges = [1 / 6, 1 / 2, 5 / 6].map((share) => {
    const start = Math.max(from, from + share * (to - from) - stretch / 2);
    return [Math.round(start * fps), Math.round((start + stretch) * fps)] as const;
  });
  const inRanges = (frame: number) => ranges.some(([a, b]) => frame >= a && frame < b);
  const reference = detectionStats(frames.filter((f) => inRanges(f.index)));
  const tracker = { ...DEFAULT_TRACKER, accept: particleDetection };
  const referenceSteps = measure(frames, tracks, center).steps.filter((s) => inRanges(s.frame));
  const bins = stepBins(referenceSteps);
  const referenceHistogram = stepHistogram(bins, referenceSteps);
  const quarters = radiusQuarters(referenceSteps);
  const referenceSpeeds = quarterSpeeds(referenceSteps, quarters);
  const referenceShares = classShares(model.sprites, analysis.crops);
  const occupancyView = { x: center[0], y: center[1], scale: window.info.height, region: opts.region, frameRate: fps };
  const pairs = (model.report.bankPairs ?? 1) === 1;
  const view = referenceView(model);
  const gains = { rate: 1, light: 1, size: 1, speed: 1, approach: 1 };
  interface Round {
    round: number;
    error: number;
    prototypes: Float32Array;
    weights: Float32Array;
    rate: number;
    gains: typeof gains;
    ours: DetectionStats;
    speeds: number[];
    distance: number;
    shareDistance: number;
  }
  let best: Round | undefined;
  let firstDistance = NaN;
  let firstShareDistance = NaN;
  for (let round = 0; round <= rounds; round++) {
    onRound(round);
    const clock = new Clock(model.dynamics, features, model.preRun, { reactivity: 1, speed: 1 });
    const synthesis = await synthesize(gpu, analysis, prepare(model), clock, view, ranges, true);
    const ours = detectionStats(synthesis.frames);
    const ourSteps = measure(synthesis.frames, track(synthesis.frames, tracker), center).steps;
    const ourHistogram = stepHistogram(bins, ourSteps);
    const ourSpeeds = quarterSpeeds(ourSteps, quarters);
    const ourShares = classShares(model.sprites, synthesis.crops);
    const distance = 0.5 * ourHistogram.reduce((s, v, b) => s + Math.abs(v - referenceHistogram[b]), 0);
    const shareDistance = 0.5 * referenceShares.reduce((s, v, k) => s + Math.abs(v - ourShares[k]), 0);
    if (round === 0) {
      firstDistance = distance;
      firstShareDistance = shareDistance;
    }
    const error =
      distance +
      shareDistance +
      logOff(ours.count, reference.count) +
      logOff(ours.peak, reference.peak) +
      logOff(ours.spread, reference.spread) +
      ourSpeeds.reduce((s, v, q) => s + logOff(v, referenceSpeeds[q]), 0) / ourSpeeds.length;
    if (!best || error < best.error) {
      best = { round, error, prototypes: model.prototypes.slice(), weights: model.weights.slice(), rate: model.rate, gains: { ...gains }, ours, speeds: ourSpeeds, distance, shareDistance };
    }
    if (round === rounds) break;
    const lightStep = ours.peak > 0 ? Math.max(0.5, Math.min(2, reference.peak / ours.peak)) : 2;
    const sizeStep = ours.spread > 0 ? Math.max(0.5, Math.min(2, reference.spread / ours.spread)) : 1;
    const velocity = velocitySteps(referenceSpeeds, ourSpeeds);
    const speedStep = velocity.speed ** SPEED_STEP;
    const approachStep = velocity.approach ** SPEED_STEP;
    // Reweighting, brightening and speeding up change how long the drawn particles stay visible: the rate
    // makes up for it, so that the count it is stepped to is the count the next round finds.
    const occupancies = occupancy(model, occupancyView, bins, MIN_PEAK);
    const visible = (o: Float32Array[]) => o.reduce((s, counts, i) => s + model.weights[i] * counts.reduce((a, b) => a + b, 0), 0);
    const before = visible(occupancies);
    reweight(model, occupancies, referenceHistogram, ourHistogram, pairs, SPEED_STEP);
    reweightSprites(model, referenceShares, ourShares);
    scalePrototypes(model.prototypes, sizeStep, lightStep);
    scaleVelocities(model.prototypes, speedStep, approachStep);
    const after = visible(occupancy(model, occupancyView, bins, MIN_PEAK));
    const rateStep = (ours.count > 0 ? Math.max(0.25, Math.min(4, reference.count / ours.count)) : 4) * (after > 0 && before > 0 ? before / after : 1);
    model.rate *= rateStep;
    gains.rate *= rateStep;
    gains.light *= lightStep;
    gains.size *= sizeStep;
    gains.speed *= speedStep;
    gains.approach *= approachStep;
  }
  const kept = best!;
  model.prototypes.set(kept.prototypes);
  model.weights.set(kept.weights);
  model.rate = kept.rate;
  return {
    calibrationRound: kept.round,
    rateGain: kept.gains.rate,
    lightGain: kept.gains.light,
    sizeGain: kept.gains.size,
    speedGain: kept.gains.speed,
    approachGain: kept.gains.approach,
    outerSpeedRatio: kept.speeds[3] / referenceSpeeds[3],
    innerSpeedRatio: kept.speeds[0] / referenceSpeeds[0],
    countReference: reference.count,
    countModel: kept.ours.count,
    peakReference: reference.peak,
    peakModel: kept.ours.peak,
    spreadReference: reference.spread,
    spreadModel: kept.ours.spread,
    stepDistanceFirst: firstDistance,
    stepDistance: kept.distance,
    spriteShareDistanceFirst: firstShareDistance,
    spriteShareDistance: kept.shareDistance,
  };
}

export async function trainModel(blob: Blob, name: string, options: TrainOptions): Promise<TrainResult> {
  const started = performance.now();
  const progress = (stage: string, share: number) => options.onProgress?.({ stage, share: Math.max(0, Math.min(1, share)) });
  const check = () => {
    if (options.signal?.aborted) throw new DOMException("Training was cancelled.", "AbortError");
  };
  const gpu = createGpu();
  try {
    const window = await analyseForTraining(gpu, blob, name, options, (stage, share) => progress(stage, 0.5 * share), options.signal);
    check();
    let mark = performance.now();
    progress("Training the PyTorch model", 0.5);
    const raw = await options.trainer(window.dataset, (stage, share) => progress(stage, 0.5 + 0.25 * share), options.signal);
    const model = decodeModel(raw);
    const torchSeconds = (performance.now() - mark) / 1000;
    check();
    mark = performance.now();
    const rounds = options.calibration ?? 3;
    const calibration = await calibrateModel(gpu, window, model, rounds, (round) => {
      check();
      progress("Calibrating", 0.75 + (0.25 * round) / (rounds + 1));
    });
    gpu.release(window.analysis.background);
    model.report = {
      ...model.report,
      ...calibration,
      seconds: (performance.now() - started) / 1000,
      soundSeconds: window.soundSeconds,
      detectSeconds: window.detectSeconds,
      torchSeconds,
      calibrateSeconds: (performance.now() - mark) / 1000,
      frames: window.analysis.frames.length,
    };
    progress("Done", 1);
    return { model, tracks: window.tracks, features: window.features };
  } finally {
    gpu.dispose();
  }
}
