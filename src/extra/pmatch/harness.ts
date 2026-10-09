// window.pmatch: Particle Match entry points for the headless checks in
// scripts/pmatch-*.ts. Files come from the page's server; bulky results are
// POSTed back to it (/upload/<key>) instead of going through evaluate().
import { DEFAULT_DETECTOR, DETECTION_FLOATS, Detector, type DetectorOptions } from "./detect.ts";
import { Clock } from "./dynamics.ts";
import { evaluateModel } from "./evaluate.ts";
import type { PopulationOptions } from "./fit.ts";
import { decodeWindow, videoInfo } from "./frames.ts";
import { createGpu, frameTexture, uploadFrame, type Gpu } from "./gpu.ts";
import { decodeModel, encodeModel } from "./model.ts";
import { analyseVideo, findMirror, referenceView, Synthesizer, trainModel, videoAudioFeatures } from "./pipeline.ts";
import { prepare } from "./sample.ts";
import { fitShake, ShakeMeter, shakeTrack, type FrameMotion } from "./shake.ts";

async function upload(key: string, data: BlobPart): Promise<void> {
  const response = await fetch(`/upload/${encodeURIComponent(key)}`, { method: "POST", body: new Blob([data]) });
  if (!response.ok) throw new Error(`upload of ${key} failed`);
}

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.blob();
}

function concat(parts: Float32Array[]): Float32Array<ArrayBuffer> {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A tile mask as a PNG, one pixel per tile: white analysed, black masked. */
function maskPng(mask: Uint8Array, columns: number, rows: number): Promise<Blob> {
  const image = new ImageData(columns, rows);
  for (let i = 0; i < mask.length; i++) {
    image.data.fill(mask[i] ? 255 : 0, i * 4, i * 4 + 3);
    image.data[i * 4 + 3] = 255;
  }
  const canvas = new OffscreenCanvas(columns, rows);
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

/** A float texture's RGBA (rows bottom first) as an 8-bit PNG, `gain` times brighter, rows top first. */
async function surfacePng(gpu: Gpu, texture: WebGLTexture, width: number, height: number, gain: number, flip: boolean): Promise<Blob> {
  const gl = gpu.gl;
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.UNSIGNED_BYTE ? gl.UNSIGNED_BYTE : gl.FLOAT;
  const pixels = type === gl.FLOAT ? new Float32Array(width * height * 4) : new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, type, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  const image = new ImageData(width, height);
  const scale = type === gl.FLOAT ? 255 : 1;
  for (let y = 0; y < height; y++) {
    const row = flip ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const i = (row * width + x) * 4;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) image.data[o + c] = Math.max(0, Math.min(255, pixels[i + c] * scale * gain));
      image.data[o + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

const api = {
  async info(url: string) {
    const info = await videoInfo(await fetchBlob(url));
    return { width: info.width, height: info.height, frameRate: info.frameRate, duration: info.duration, frames: info.times.length };
  },

  /**
   * Detects particles in every frame of [from, to) and uploads them as `key`: per frame its index, its
   * detection count, then the detections. With `masks`, also uploads the tile masks as `key`-mask (one
   * byte per tile per frame). With `dumpAt`, also uploads `key`-frame.png, `key`-residual.png and
   * `key`-mask.png for the first frame at or after it.
   */
  async detect(url: string, from: number, to: number, key: string, options: Partial<DetectorOptions> = {}, extra: { dumpAt?: number; masks?: boolean } = {}) {
    const blob = await fetchBlob(url);
    const info = await videoInfo(blob);
    const gpu = createGpu();
    const gl = gpu.gl;
    const texture = frameTexture(gl, info.width, info.height);
    const region = options.region ?? [0, 0, info.width, info.height];
    const detector = new Detector(gpu, { ...DEFAULT_DETECTOR, ...options, region });
    const [columns, rows] = detector.grid;
    const parts: Float32Array[] = [];
    const masks: Uint8Array[] = [];
    const started = performance.now();
    let gpuMs = 0;
    let dumped: Promise<void> | null = null;
    const lead = detector.warmup / info.frameRate;
    let frames = 0;
    await decodeWindow(blob, info, Math.max(0, from - lead), to, (frame, index, time) => {
      const t = performance.now();
      uploadFrame(gl, texture, frame);
      detector.process(texture, info.width, info.height);
      if (time < from - 1e-6 || !detector.warm) return;
      const { detections, mask } = detector.read();
      gpuMs += performance.now() - t;
      frames++;
      parts.push(Float32Array.of(index, detections.length / DETECTION_FLOATS), detections);
      if (extra.masks) masks.push(mask);
      if (extra.dumpAt !== undefined && !dumped && time >= extra.dumpAt) {
        dumped = (async () => {
          await upload(`${key}-frame.png`, await surfacePng(gpu, texture, info.width, info.height, 1, false));
          await upload(`${key}-residual.png`, await surfacePng(gpu, detector.residualTexture, region[2], region[3], 4, false));
          await upload(`${key}-mask.png`, await maskPng(mask, columns, rows));
        })();
      }
    });
    await dumped;
    await upload(key, concat(parts));
    if (extra.masks) await upload(`${key}-mask`, concatBytes(masks));
    detector.dispose();
    gpu.dispose();
    return { frames, ms: performance.now() - started, gpuMs, width: info.width, height: info.height, frameRate: info.frameRate, grid: [columns, rows] };
  },

  /**
   * Measures how the picture moves over [from, to) and uploads it as `key`: per frame dx, dy (frame
   * pixels), angle (radians), log scale and agreement (NaN for unmeasured frames), then the shake track's
   * x, y and tilt. Returns the S_Shake settings fitted to it and the time spent per frame.
   */
  async shake(url: string, from: number, to: number, key: string) {
    const blob = await fetchBlob(url);
    const info = await videoInfo(blob);
    const features = await videoAudioFeatures(blob);
    const gpu = createGpu();
    const texture = frameTexture(gpu.gl, info.width, info.height);
    const meter = new ShakeMeter(gpu, info.width, info.height);
    const motions: (FrameMotion | null)[] = [];
    let first = -1;
    let ms = 0;
    await decodeWindow(blob, info, from, to, (frame, index) => {
      if (first < 0) first = index;
      const started = performance.now();
      uploadFrame(gpu.gl, texture, frame);
      motions.push(meter.measure(texture));
      ms += performance.now() - started;
    });
    meter.dispose();
    gpu.dispose();
    const track = shakeTrack(motions, info.frameRate);
    const fit = fitShake(track, info.frameRate, first / info.frameRate, features);
    const out = new Float32Array(motions.length * 8);
    motions.forEach((m, k) => {
      out.set(m ? [m.dx, m.dy, m.angle, m.logScale, m.agreement] : [NaN, NaN, NaN, NaN, NaN], k * 8);
      out.set([track.x[k], track.y[k], track.tilt[k]], k * 8 + 5);
    });
    await upload(key, out);
    return { frames: motions.length, first, frameRate: info.frameRate, msPerFrame: ms / Math.max(1, motions.length), ...fit };
  },

  /** Uploads `key`-<i>.png, the video's first frame at or after each of `times`. */
  async stills(url: string, times: number[], key: string) {
    const blob = await fetchBlob(url);
    const info = await videoInfo(blob);
    const gpu = createGpu();
    const texture = frameTexture(gpu.gl, info.width, info.height);
    const step = 1 / info.frameRate;
    for (const [i, time] of times.entries()) {
      let done: Promise<void> | null = null;
      await decodeWindow(blob, info, time, time + step, (frame) => {
        if (done) return;
        uploadFrame(gpu.gl, texture, frame);
        done = surfacePng(gpu, texture, info.width, info.height, 1, false).then((png) => upload(`${key}-${i}.png`, png));
      });
      await done;
    }
    gpu.dispose();
    return { width: info.width, height: info.height };
  },

  /** The mirror axis and score of the first frame at or after `time`. */
  async mirror(url: string, time: number) {
    const blob = await fetchBlob(url);
    const info = await videoInfo(blob);
    const gpu = createGpu();
    const texture = frameTexture(gpu.gl, info.width, info.height);
    let result: { axis: number; score: number } | null = null;
    await decodeWindow(blob, info, time, time + 0.1, (frame) => {
      if (result) return;
      uploadFrame(gpu.gl, texture, frame);
      result = findMirror(gpu, texture, info.width, info.height);
    });
    gpu.dispose();
    return result;
  },

  /** Trains a model on [from, to) of the video and uploads it (encoded) as `key`; returns its report. */
  async train(url: string, from: number, to: number, key: string, population: Partial<PopulationOptions> = {}) {
    const blob = await fetchBlob(url);
    const stages: string[] = [];
    const { model } = await trainModel(blob, url.split("/").pop() ?? "reference", {
      from,
      to,
      population,
      onProgress: (p) => {
        if (stages[stages.length - 1] !== p.stage) stages.push(p.stage);
      },
    });
    await upload(key, encodeModel(model) as Uint8Array<ArrayBuffer>);
    return { report: model.report, stages };
  },

  /**
   * Uploads `key`-reference.png, the video's frame at `time`, and `key`-model.png, the model rendered at
   * `time` over the video's background around it (from analysing `time` − 2 .. `time` + 0.5 s).
   */
  async frames(url: string, modelUrl: string, time: number, key: string) {
    const blob = await fetchBlob(url);
    const model = decodeModel(new Uint8Array(await (await fetchBlob(modelUrl)).arrayBuffer()));
    const info = await videoInfo(blob);
    const features = await videoAudioFeatures(blob);
    const gpu = createGpu();
    try {
      const analysis = await analyseVideo(gpu, blob, info, time - 2, time + 0.5);
      const texture = frameTexture(gpu.gl, info.width, info.height);
      let uploaded: Promise<void> | null = null;
      await decodeWindow(blob, info, time, time + 0.5 / info.frameRate, async (frame) => {
        if (uploaded) return;
        uploadFrame(gpu.gl, texture, frame);
        uploaded = surfacePng(gpu, texture, info.width, info.height, 1, false).then((png) => upload(`${key}-reference.png`, png));
      });
      await uploaded;
      const synth = new Synthesizer(gpu, info.width, info.height);
      const clock = new Clock(model.dynamics, features, model.preRun, { reactivity: 1, speed: 1 });
      const rendered = synth.render(prepare(model), clock, time, referenceView(model), analysis.background.texture);
      await upload(`${key}-model.png`, await surfacePng(gpu, rendered, info.width, info.height, 1, false));
      synth.dispose();
      gpu.release(analysis.background);
      gpu.gl.deleteTexture(texture);
    } finally {
      gpu.dispose();
    }
  },

  /** Compares a model (encoded, served at `modelUrl`) with [from, to) of its reference video. */
  async evaluate(url: string, modelUrl: string, from: number, to: number) {
    const blob = await fetchBlob(url);
    const model = decodeModel(new Uint8Array(await (await fetchBlob(modelUrl)).arrayBuffer()));
    return evaluateModel(blob, model, from, to);
  },
};

export type PmatchApi = typeof api;
(globalThis as unknown as { pmatch: PmatchApi }).pmatch = api;
