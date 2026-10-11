// window.pmatch: Particle Match entry points for the headless checks in
// scripts/pmatch-*.ts. Files come from the page's server; bulky results are
// POSTed back to it (/upload/<key>) instead of going through evaluate(), and
// analyses are POSTed to its PyTorch trainer (/train).
import { DEFAULT_DETECTOR, DETECTION_FLOATS, Detector, type DetectorOptions } from "./detect.ts";
import { Clock } from "./dynamics.ts";
import { evaluateModel } from "./evaluate.ts";
import { decodeWindow, videoInfo } from "./frames.ts";
import { createGpu, frameTexture, uploadFrame, type Gpu } from "./gpu.ts";
import { decodeModel, encodeModel } from "./model.ts";
import { analyseVideo, exportDataset, findMirror, referenceView, synthesize, Synthesizer, trainModel, videoAudioFeatures, type Trainer } from "./pipeline.ts";
import { ModelPreview } from "./preview.ts";
import { particlesAt, prepare } from "./sample.ts";
import { DEFAULT_TRACKER, particleDetection, track } from "./track.ts";
import { measureShake, ShakeMeter, shakeTrack, type FrameMotion } from "./shake.ts";
import { streamTraining } from "./trainer.ts";

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
   * x, y and tilt. Returns the S_Shake settings measured from it and the time spent per frame.
   */
  async shake(url: string, from: number, to: number, key: string) {
    const blob = await fetchBlob(url);
    const info = await videoInfo(blob);
    const gpu = createGpu();
    const texture = frameTexture(gpu.gl, info.width, info.height);
    const meter = new ShakeMeter(gpu, info.width, info.height);
    let first = -1;
    let ms = 0;
    await decodeWindow(blob, info, from, to, (frame, index) => {
      if (first < 0) first = index;
      const started = performance.now();
      uploadFrame(gpu.gl, texture, frame);
      meter.capture(texture);
      ms += performance.now() - started;
    });
    const motions: (FrameMotion | null)[] = await meter.finish();
    meter.dispose();
    gpu.dispose();
    const track = shakeTrack(motions, info.frameRate);
    const measured = measureShake(track, info.frameRate);
    const out = new Float32Array(motions.length * 8);
    motions.forEach((m, k) => {
      out.set(m ? [m.dx, m.dy, m.angle, m.logScale, m.agreement] : [NaN, NaN, NaN, NaN, NaN], k * 8);
      out.set([track.x[k], track.y[k], track.tilt[k]], k * 8 + 5);
    });
    await upload(key, out);
    return { frames: motions.length, first, frameRate: info.frameRate, msPerFrame: ms / Math.max(1, motions.length), shake: measured.shake, report: measured.report };
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

  /**
   * Trains a model on [from, to) of the video (PyTorch through the server's /train, or the trained model
   * served at `rawUrl` when given, so that only calibration runs) and uploads it (encoded) as `key`;
   * returns its report, what trained it and the stages it went through.
   */
  async train(url: string, from: number, to: number, key: string, rawUrl?: string, calibration?: number) {
    const blob = await fetchBlob(url);
    const stages: string[] = [];
    const trainer: Trainer = rawUrl
      ? async () => new Uint8Array(await (await fetchBlob(rawUrl)).arrayBuffer())
      : (dataset, onProgress, signal) => streamTraining("/train", dataset, onProgress, signal);
    const { model } = await trainModel(blob, url.split("/").pop() ?? "reference", {
      from,
      to,
      trainer,
      calibration,
      onProgress: (p) => {
        if (stages[stages.length - 1] !== p.stage) stages.push(p.stage);
      },
    });
    await upload(key, encodeModel(model) as Uint8Array<ArrayBuffer>);
    return { report: model.report, trainer: model.trainer, stages };
  },

  /** Uploads as `key` the analysis of [from, to) of the video that the PyTorch trainer learns from. */
  async dataset(url: string, from: number, to: number, key: string) {
    const blob = await fetchBlob(url);
    const started = performance.now();
    const dataset = await exportDataset(blob, url.split("/").pop() ?? "reference", from, to);
    await upload(key, dataset);
    return { bytes: dataset.length, seconds: (performance.now() - started) / 1000 };
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

  /**
   * Seconds per frame of the analysis' parts over [from, to): decoding alone, then with the upload, the shake
   * meter, the detector's passes (synchronised by a one-pixel read at the end) and its per-frame read, and the
   * whole analysis.
   */
  async profile(url: string, from: number, to: number) {
    const blob = await fetchBlob(url);
    const info = await videoInfo(blob);
    const gpu = createGpu();
    const gl = gpu.gl;
    const texture = frameTexture(gl, info.width, info.height);
    const sync = () => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    };
    const timed = async (each: (frame: VideoFrame) => void) => {
      const started = performance.now();
      const frames = await decodeWindow(blob, info, from, to, each);
      sync();
      return { frames, ms: (performance.now() - started) / Math.max(1, frames) };
    };
    const decode = await timed(() => {});
    const upload = await timed((frame) => uploadFrame(gl, texture, frame));
    const meter = new ShakeMeter(gpu, info.width, info.height);
    const shakeStarted = performance.now();
    const captured = await timed((frame) => {
      uploadFrame(gl, texture, frame);
      meter.capture(texture);
    });
    await meter.finish();
    const shake = { frames: captured.frames, ms: (performance.now() - shakeStarted) / Math.max(1, captured.frames) };
    meter.dispose();
    const detector = new Detector(gpu, { ...DEFAULT_DETECTOR, region: [0, 0, info.width, info.height] });
    const passes = await timed((frame) => {
      uploadFrame(gl, texture, frame);
      detector.process(texture, info.width, info.height);
    });
    const reads = await timed((frame) => {
      uploadFrame(gl, texture, frame);
      detector.process(texture, info.width, info.height);
      detector.read();
    });
    const later = await timed((frame) => {
      uploadFrame(gl, texture, frame);
      detector.process(texture, info.width, info.height);
      detector.readLater(0);
      detector.collect();
    });
    detector.drain();
    detector.dispose();
    const started = performance.now();
    const analysis = await analyseVideo(gpu, blob, info, from, to);
    const whole = (performance.now() - started) / analysis.frames.length;
    gpu.release(analysis.background);
    gpu.dispose();
    return { decode, upload, shake, passes, reads, later, analysis: { frames: analysis.frames.length, ms: whole } };
  },

  /**
   * Milliseconds per frame of calibration's parts for a model (served at `modelUrl`) over `seconds` from the
   * middle of [from, to): sampling its particles, rendering them over the background, rendering and detecting,
   * the whole synthesis, and the tracker on what it found.
   */
  async profileSynthesis(url: string, modelUrl: string, from: number, to: number, seconds = 3) {
    const blob = await fetchBlob(url);
    const info = await videoInfo(blob);
    const model = decodeModel(new Uint8Array(await (await fetchBlob(modelUrl)).arrayBuffer()));
    const gpu = createGpu();
    const gl = gpu.gl;
    const sync = () => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    };
    try {
      const analysis = await analyseVideo(gpu, blob, info, from, to);
      const prepared = prepare(model);
      const clock = new Clock(model.dynamics, await videoAudioFeatures(blob), model.preRun, { reactivity: 1, speed: 1 });
      const view = referenceView(model);
      const a = Math.round(((from + to) / 2) * info.frameRate);
      const b = a + Math.round(seconds * info.frameRate);
      const frames = b - a;
      const time = (run: () => void) => {
        const started = performance.now();
        run();
        sync();
        return (performance.now() - started) / frames;
      };
      let particles = 0;
      const sampling = time(() => {
        for (let k = a; k < b; k++) particles += particlesAt(prepared, clock.timeAt(k / info.frameRate), 1, view).count;
      });
      const synth = new Synthesizer(gpu, info.width, info.height);
      const render = time(() => {
        for (let k = a; k < b; k++) synth.render(prepared, clock, k / info.frameRate, view, analysis.background.texture);
      });
      const detector = new Detector(gpu, analysis.options);
      const detect = time(() => {
        for (let k = a; k < b; k++) {
          detector.process(synth.render(prepared, clock, k / info.frameRate, view, analysis.background.texture), info.width, info.height);
          detector.readLater(k);
          detector.collect();
        }
        detector.drain();
      });
      detector.dispose();
      synth.dispose();
      let started = performance.now();
      const synthesis = await synthesize(gpu, analysis, prepared, clock, view, [[a, b]]);
      const whole = (performance.now() - started) / frames;
      started = performance.now();
      track(synthesis.frames, { ...DEFAULT_TRACKER, accept: particleDetection });
      const tracking = (performance.now() - started) / frames;
      gpu.release(analysis.background);
      return { particles: particles / frames, sampling, render, detect, synthesis: whole, tracking };
    } finally {
      gpu.dispose();
    }
  },

  /**
   * Milliseconds per frame of the dialog's learned-particles preview (preview.ts) at the reference's full
   * resolution, playing `frames` frames from `from` seconds; each frame is waited for on the GPU.
   */
  async inference(url: string, modelUrl: string, from: number, frames = 120) {
    const blob = await fetchBlob(url);
    const info = await videoInfo(blob);
    const model = decodeModel(new Uint8Array(await (await fetchBlob(modelUrl)).arrayBuffer()));
    const canvas = document.createElement("canvas");
    canvas.width = info.width;
    canvas.height = info.height;
    const preview = new ModelPreview(canvas, model, await videoAudioFeatures(blob));
    const gl = preview.gpu.gl;
    const sync = () => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    };
    try {
      const warmup = 10;
      for (let k = 0; k < warmup; k++) preview.draw(from + k / info.frameRate);
      sync();
      const times: number[] = [];
      for (let k = 0; k < frames; k++) {
        const started = performance.now();
        preview.draw(from + (warmup + k) / info.frameRate);
        sync();
        times.push(performance.now() - started);
      }
      const sorted = times.slice().sort((a, b) => a - b);
      return {
        width: canvas.width,
        height: canvas.height,
        frames,
        median: sorted[Math.floor((sorted.length - 1) / 2)],
        p95: sorted[Math.floor(0.95 * (sorted.length - 1))],
        mean: times.reduce((s, v) => s + v, 0) / times.length,
      };
    } finally {
      preview.dispose();
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
