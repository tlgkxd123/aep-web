// Trains a Particle Match world model from a reference video in the browser:
// decode a window of the video and find particles in every frame on the GPU (only
// detections, tile masks and a few hundred sprite crops come back), link them into
// tracks, fit the clock and how it follows the music, the particle population and
// the sprites, then calibrate by synthesis: render the model over the video's own
// background, find its particles with the same detector through the same masks,
// and scale birth rate, light and size until what is found matches the video.
import { audioFeatures, channelReader, type AudioFeatures } from "./audio.ts";
import { detectionStats, occupancy, reweight, stepBins, stepHistogram, type DetectionStats } from "./calibrate.ts";
import { DEFAULT_DETECTOR, Detector, DETECTION_FLOATS, D_PEAK, D_X, D_Y, HISTORY, type DetectorOptions } from "./detect.ts";
import { drawParticles } from "./draw.ts";
import { Clock } from "./dynamics.ts";
import { buildPopulation, DEFAULT_POPULATION, depthExponents, fitClock, fitDynamics, scalePrototypes, stitchTracks, type PopulationOptions, type Visibility } from "./fit.ts";
import { decodeWindow, videoInfo, type VideoInfo } from "./frames.ts";
import { createGpu, frameTexture, readFloats, uploadFrame, type Gpu, type Surface } from "./gpu.ts";
import { measure } from "./metrics.ts";
import { MODEL_VERSION, type ParticleWorldModel } from "./model.ts";
import { INSTANCE_FLOATS, particlesAt, prepare, type Instances, type Prepared, type View } from "./sample.ts";
import { fitShake, ShakeMeter, shakeTrack, type FrameMotion } from "./shake.ts";
import { CropGatherer, learnSprites, type Crop } from "./sprites.ts";
import { DEFAULT_TRACKER, focusOfExpansion, MIN_PEAK, particleDetection, track, type FrameDetections, type Track } from "./track.ts";

export interface TrainProgress {
  stage: string;
  /** 0..1 over the whole training. */
  share: number;
}

export interface TrainOptions {
  /** Training window, seconds of the video. */
  from: number;
  to: number;
  onProgress?: (p: TrainProgress) => void;
  signal?: AbortSignal;
  /** Calibration rounds (each renders and analyses a few seconds of the model). */
  calibration?: number;
  population?: Partial<PopulationOptions>;
}

const BACKGROUND_SAMPLES = HISTORY;
/** Frames between crops, crops per frame and in all. */
const CROP_EVERY = 4;
const CROPS_PER_FRAME = 16;
const MAX_CROPS = 1500;
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

/** Bright, isolated detections on analysed tiles: the ones worth cropping for sprites. */
function cropCentres(frame: number, detections: Float32Array, mask: Uint8Array, options: DetectorOptions, columns: number, width: number, height: number): { frame: number; x: number; y: number }[] {
  const centres: { frame: number; x: number; y: number }[] = [];
  const n = detections.length / DETECTION_FLOATS;
  for (let i = 0; i < n && centres.length < CROPS_PER_FRAME; i++) {
    const at = i * DETECTION_FLOATS;
    const x = detections[at + D_X];
    const y = detections[at + D_Y];
    if (detections[at + D_PEAK] < 30 / 255 || x < 13 || y < 13 || x > width - 13 || y > height - 13) continue;
    let isolated = true;
    for (let j = 0; j < n && isolated; j++) {
      if (j !== i && Math.hypot(detections[j * DETECTION_FLOATS + D_X] - x, detections[j * DETECTION_FLOATS + D_Y] - y) < 14) isolated = false;
    }
    const tx = Math.floor((x - options.region[0]) / options.tile);
    const ty = Math.floor((y - options.region[1]) / options.tile);
    let clear = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!mask[(ty + dy) * columns + tx + dx]) clear = false;
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

/** Runs the detector over [from, to) of a video (the first frame decides the mirror and region). */
export async function analyseVideo(gpu: Gpu, blob: Blob, info: VideoInfo, from: number, to: number, onShare?: (share: number) => void, signal?: AbortSignal): Promise<VideoAnalysis> {
  const gl = gpu.gl;
  const W = info.width;
  const H = info.height;
  const texture = frameTexture(gl, W, H);
  // Set from the first decoded frame (the mirror decides the region).
  let detector = null as Detector | null;
  let gatherer = null as CropGatherer | null;
  let meter = null as ShakeMeter | null;
  let mirror = null as Mirror | null;
  let mirrorScore = 0;
  let options = null as DetectorOptions | null;
  const frames: FrameDetections[] = [];
  const masks: Uint8Array[] = [];
  const motions: (FrameMotion | null)[] = [];
  const crops: Crop[] = [];
  const backgrounds: Surface[] = [];
  const sampleTimes = Array.from({ length: BACKGROUND_SAMPLES }, (_, k) => from + ((k + 0.5) * (to - from)) / BACKGROUND_SAMPLES);
  const copy = () => {
    const s = gpu.surface(W, H, gl.RGBA8);
    gpu.pass(gpu.program(COPY_FS), s, [texture], (u) => gl.uniform1i(u("u_src"), 0));
    backgrounds.push(s);
  };
  let recorded = 0;
  const expected = Math.max(1, Math.round((to - from) * info.frameRate));
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
          meter = new ShakeMeter(gpu, W, H);
        }
        const motion = meter!.measure(texture);
        detector.process(texture, W, H);
        if (backgrounds.length < BACKGROUND_SAMPLES && time >= sampleTimes[backgrounds.length]) copy();
        if (time < from - 1e-6 || !detector.warm) return;
        const { detections, mask } = detector.read();
        frames.push({ index, data: detections });
        masks.push(mask);
        motions.push(motion);
        if (recorded++ % CROP_EVERY === 0 && crops.length < MAX_CROPS) {
          const [rx, ry, rw, rh] = options!.region;
          const centres = cropCentres(index, detections, mask, options!, detector.grid[0], W, H);
          crops.push(...gatherer!.gather(texture, [W, H], detector.openingTexture, [rx, ry], [rw, rh], centres));
        }
        if (recorded % 30 === 0) onShare?.(Math.min(1, recorded / expected));
      },
      signal,
    );
    if (!detector || !options || frames.length < 30) throw new Error("The window has too few frames to analyse.");
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
  const frames: FrameDetections[] = [];
  const crops: Crop[] = [];
  try {
    for (const [a, b] of ranges) {
      const detector = new Detector(gpu, options);
      let recorded = 0;
      for (let index = a - WARMUP; index < b; index++) {
        const texture = synth.render(model, clock, index / info.frameRate, view, analysis.background.texture);
        detector.process(texture, info.width, info.height);
        const mask = analysis.masks[index - first];
        if (index < a || !detector.warm || !mask) continue;
        const detections = maskDetections(detector.read().detections, mask, options, columns);
        frames.push({ index, data: detections });
        if (gatherer && recorded++ % CROP_EVERY === 0 && crops.length < MAX_CROPS) {
          const [rx, ry, rw, rh] = options.region;
          const centres = cropCentres(index, detections, mask, options, columns, info.width, info.height);
          crops.push(...gatherer.gather(texture, [info.width, info.height], detector.openingTexture, [rx, ry], [rw, rh], centres));
        }
      }
      detector.dispose();
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    synth.dispose();
    gatherer?.dispose();
  }
  return { frames, crops };
}

/** Audio features of a video's sound track (null when it has none the browser can decode). */
export async function videoAudioFeatures(blob: Blob): Promise<AudioFeatures | null> {
  try {
    const context = new OfflineAudioContext(1, 1, 48000);
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
    return audioFeatures(channelReader(channels), audio.sampleRate, audio.length / audio.sampleRate);
  } catch {
    return null;
  }
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

export async function trainModel(blob: Blob, name: string, options: TrainOptions): Promise<TrainResult> {
  const started = performance.now();
  const progress = (stage: string, share: number) => options.onProgress?.({ stage, share: Math.max(0, Math.min(1, share)) });
  const check = () => {
    if (options.signal?.aborted) throw new DOMException("Training was cancelled.", "AbortError");
  };
  progress("Reading the video", 0);
  const info = await videoInfo(blob);
  const from = Math.max(0, Math.min(options.from, info.duration - 1));
  const to = Math.max(from + 1, Math.min(options.to, info.duration));
  const fps = info.frameRate;
  const W = info.width;
  const H = info.height;
  progress("Reading the sound", 0.02);
  const features = await videoAudioFeatures(blob);
  const timing = { sound: performance.now() - started, detect: 0, fit: 0, calibrate: 0 };
  let mark = performance.now();
  check();
  const gpu = createGpu();
  try {
    progress("Finding particles", 0.05);
    const analysis = await analyseVideo(gpu, blob, info, from, to, (share) => progress("Finding particles", 0.05 + 0.55 * share), options.signal);
    check();
    const { frames, masks, crops, mirror, options: opts, columns, rows } = analysis;
    timing.detect = performance.now() - mark;
    mark = performance.now();

    progress("Following particles", 0.6);
    await new Promise((r) => setTimeout(r, 0));
    const tracks = track(frames, { ...DEFAULT_TRACKER, accept: particleDetection });
    const long = tracks.filter((t) => t.points.length >= 12);
    const [rx, ry, rw, rh] = opts.region;
    const center: [number, number] = focusOfExpansion(long) ?? [rx + rw / 2, ry + rh / 2];
    check();
    progress("Learning the motion", 0.64);
    await new Promise((r) => setTimeout(r, 0));
    const first = frames[0].index;
    const count = frames[frames.length - 1].index - first + 1;
    const clock = fitClock(tracks, first, count, center, fps);
    const fitted = fitDynamics(features, clock.speed, first / fps, fps);
    const shaking = fitShake(shakeTrack(analysis.motions, fps), fps, first / fps, features);
    const stitched = stitchTracks(tracks, clock, center);
    check();
    progress("Learning the sprites", 0.68);
    await new Promise((r) => setTimeout(r, 0));
    const sprites = learnSprites(crops);
    // Sprite class per track: its own crop's, else the nearest cropped track's by size and light.
    const byPoint = new Map<string, Track>();
    for (const t of stitched.tracks) for (const p of t.points) byPoint.set(`${p.frame}:${p.x}:${p.y}`, t);
    const classOf = new Map<Track, number>();
    crops.forEach((c, i) => {
      const t = byPoint.get(`${c.frame}:${c.x}:${c.y}`);
      if (t && sprites.labels[i] >= 0 && !classOf.has(t)) classOf.set(t, sprites.labels[i]);
    });
    const signature = (t: Track) => {
      const spreads = t.points.map((p) => p.spread).sort((a, b) => a - b);
      const peaks = t.points.map((p) => p.peak).sort((a, b) => a - b);
      return [Math.log(Math.max(0.3, spreads[spreads.length >> 1])), Math.log(Math.max(1e-3, peaks[peaks.length >> 1]))];
    };
    const labelled = [...classOf.entries()].map(([t, c]) => [signature(t), c] as const);
    const spriteOf = (t: Track) => {
      const known = classOf.get(t);
      if (known !== undefined) return known;
      if (!labelled.length) return 0;
      const [a, b] = signature(t);
      let best = 0;
      let bestD = Infinity;
      for (const [[x, y], c] of labelled) {
        const d = (x - a) ** 2 + (y - b) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    };
    const visibility: Visibility = { width: W, height: H, region: opts.region, tile: opts.tile, columns, rows, first, masks };
    const population = buildPopulation(stitched.tracks, clock, center, visibility, spriteOf, { ...DEFAULT_POPULATION, ...options.population });
    const depth = depthExponents(stitched.tracks, population.fits, clock);
    const model: ParticleWorldModel = {
      version: MODEL_VERSION,
      rate: population.rate,
      preRun: population.maxLife,
      sizeDepth: depth.size,
      lightDepth: depth.light,
      prototypes: population.prototypes,
      weights: population.weights,
      jitter: Float32Array.of(0.08, 0.05, 0.1, 0.1, 0.1),
      opacityOverLife: population.opacityOverLife,
      sprites: sprites.bank,
      dynamics: fitted.dynamics,
      shake: shaking.shake,
      source: { name, width: W, height: H, frameRate: fps, mirrorAxis: mirror?.axis ?? null, center, train: [from, to] },
      report: {},
    };
    check();
    timing.fit = performance.now() - mark;
    mark = performance.now();

    // Calibration by synthesis over a few short stretches of the window.
    const rounds = options.calibration ?? 6;
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
    const occupancyView = { x: center[0], y: center[1], scale: H, region: opts.region, frameRate: fps };
    const mirroredPopulation = options.population?.mirror ?? DEFAULT_POPULATION.mirror;
    const view = referenceView(model);
    const gains = { rate: 1, light: 1, size: 1 };
    let ours: DetectionStats = { frames: 0, count: 0, peak: 0, spread: 0 };
    const stepDistance: number[] = [];
    for (let round = 0; round <= rounds; round++) {
      check();
      progress("Calibrating", 0.7 + (0.3 * round) / (rounds + 1));
      const modelClock = new Clock(model.dynamics, features, model.preRun, { reactivity: 1, speed: 1 });
      const synthesis = await synthesize(gpu, analysis, prepare(model), modelClock, view, ranges);
      ours = detectionStats(synthesis.frames);
      const ourHistogram = stepHistogram(bins, measure(synthesis.frames, track(synthesis.frames, tracker), center).steps);
      stepDistance.push(0.5 * ourHistogram.reduce((s, v, b) => s + Math.abs(v - referenceHistogram[b]), 0));
      if (round === rounds) break;
      const rateStep = ours.count > 0 ? Math.max(0.25, Math.min(4, reference.count / ours.count)) : 4;
      const lightStep = ours.peak > 0 ? Math.max(0.5, Math.min(2, reference.peak / ours.peak)) : 2;
      const sizeStep = ours.spread > 0 ? Math.max(0.5, Math.min(2, reference.spread / ours.spread)) : 1;
      model.rate *= rateStep;
      gains.rate *= rateStep;
      gains.light *= lightStep;
      gains.size *= sizeStep;
      reweight(model, occupancy(model, occupancyView, bins, MIN_PEAK), referenceHistogram, ourHistogram, mirroredPopulation);
      scalePrototypes(model.prototypes, sizeStep, lightStep);
    }
    gpu.release(analysis.background);
    timing.calibrate = performance.now() - mark;
    model.report = {
      seconds: (performance.now() - started) / 1000,
      soundSeconds: timing.sound / 1000,
      detectSeconds: timing.detect / 1000,
      fitSeconds: timing.fit / 1000,
      calibrateSeconds: timing.calibrate / 1000,
      frames: frames.length,
      tracks: tracks.length,
      links: stitched.links,
      used: population.stats.used,
      emerged: population.stats.emerged,
      censored: population.stats.censored,
      prototypes: model.weights.length,
      sprites: model.sprites.count,
      mirrored: mirror ? 1 : 0,
      mirrorAxis: mirror?.axis ?? -1,
      mirrorScore: mirror?.score ?? 0,
      emitterX: center[0],
      emitterY: center[1],
      clockLag: fitted.report.lag,
      clockR2: fitted.report.r2Valid,
      audio: features ? 1 : 0,
      shaken: shaking.shake ? 1 : 0,
      shakeRms: shaking.report.rms,
      shakeTiltRms: shaking.report.tiltRms,
      shakeR2: shaking.report.r2,
      shakeFrequency: shaking.shake?.frequency ?? 0,
      rateGain: gains.rate,
      lightGain: gains.light,
      sizeGain: gains.size,
      countReference: reference.count,
      countModel: ours.count,
      peakReference: reference.peak,
      peakModel: ours.peak,
      spreadReference: reference.spread,
      spreadModel: ours.spread,
      sizeDepth: model.sizeDepth,
      lightDepth: model.lightDepth,
      depthTracks: depth.tracks,
      stepDistanceFirst: stepDistance[0],
      stepDistance: stepDistance[stepDistance.length - 1],
    };
    progress("Done", 1);
    return { model, tracks, features };
  } finally {
    gpu.dispose();
  }
}
