import { Zip, ZipPassThrough } from "fflate";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type { CompItem, Project } from "../aep/model.ts";
import { collectPending, pendingDone } from "../media/pending.ts";
import { footageStore } from "../media/store.ts";
import type { Target } from "../render/gl.ts";
import type { Renderer } from "../render/renderer.ts";
import { audioSupported, encodeAudio, type EncodedAudio, type MixedAudio } from "./audio.ts";
import { chooseEncoder } from "./codecs.ts";
import { encodePng } from "./png.ts";
import { autoBitrate, framePlan, outputChannels, outputSize, type FramePlan, type OutputModule, type RenderSettings } from "./settings.ts";
import { SoftwareH264, softwareH264Supported } from "./softwareH264.ts";
import { StreamEncoder, type PictureEncoder } from "./video.ts";
import { WebmMuxer } from "./webm.ts";
import { alphaToI420, BT709_CODES, rgbToI420 } from "./yuv.ts";

/** Where encoded bytes go: a file on disk, or memory for a download. */
export interface Sink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface RenderHooks {
  signal?: AbortSignal;
  onFrame?: (done: number, total: number) => void;
  /** Awaited before each frame; resolves when a paused render may continue. */
  resume?: () => Promise<void>;
  /** GPU frames for opaque video at "fast" and "good" quality. */
  gpuFrames?: GpuFrameSource;
  stats?: RenderStats;
}

export interface RenderSummary {
  frames: number;
  width: number;
  height: number;
  fps: number;
  codec?: string;
  audioCodec?: string;
  bytes: number;
}

/** Straight RGBA of a comp frame, rows top to bottom, at the plan's size. */
export type FrameSource = (time: number) => Uint8Array | Promise<Uint8Array>;

/** Frames after the one rendering whose movie frames are asked for, so decoding keeps ahead of rendering. */
const FOOTAGE_AHEAD = 6;
/** Renders of one frame at most while something it needs keeps loading. */
const MAX_RENDERS = 8;

/** Resolves at the footage store's next change, or after a while in case none comes. */
function footageChange(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, 250);
    const off = footageStore.subscribe(done);
  });
}

/**
 * The comp rendered at `time` once what it shows has loaded, so no frame is written with footage missing. Its movie
 * frames are asked for and waited on before it renders (and the next frames' asked for meanwhile, so decoding runs
 * ahead): the frame renders once, instead of again for every decode that lands while it waits. Caller releases.
 */
async function renderReady(renderer: Renderer, project: Project, comp: CompItem, plan: FramePlan, time: number, stats?: RenderStats): Promise<Target> {
  const step = plan.duration / plan.frames;
  const end = plan.start + plan.duration;
  let t0 = performance.now();
  for (let wait = 0; wait < 40; wait++) {
    const { result: ready, waiting } = collectPending(() => renderer.requestFootage(project, comp, time));
    for (let k = 1; k <= FOOTAGE_AHEAD && time + k * step < end - 1e-9; k++) renderer.requestFootage(project, comp, time + k * step);
    if (ready) break;
    if (waiting) while (!pendingDone(waiting)) await footageChange();
    else await footageStore.idle();
  }
  if (stats) stats.footageWaitMs += performance.now() - t0;
  for (let attempt = 1; ; attempt++) {
    t0 = performance.now();
    const target = renderer.render(project, comp, time, { scale: plan.scale });
    if (stats) {
      stats.renders++;
      stats.renderMs += performance.now() - t0;
    }
    if (renderer.lastComplete || attempt >= MAX_RENDERS) return target;
    // Something else it needs is still loading (audio, an image a layer refers to).
    renderer.release(target);
    t0 = performance.now();
    await footageStore.idle();
    if (stats) stats.footageWaitMs += performance.now() - t0;
  }
}

/** Straight RGBA of each frame once what it shows has loaded (see renderReady). */
export function rendererSource(renderer: Renderer, project: Project, comp: CompItem, plan: FramePlan, warnings?: Set<string>): FrameSource {
  return async (time) => {
    const target = await renderReady(renderer, project, comp, plan, time);
    try {
      for (const w of renderer.lastWarnings) warnings?.add(w);
      return renderer.readPixels(target, plan.width, plan.height);
    } finally {
      renderer.release(target);
    }
  };
}

/**
 * Comp frames as VideoFrames taken straight from the renderer's canvas (matted over
 * the comp's background colour), skipping the read back and CPU colour conversion.
 */
export type GpuFrameSource = (time: number, width: number, height: number, timestamp: number, duration: number) => Promise<VideoFrame>;

/** Where an export's time goes, in milliseconds summed over frames. */
export interface RenderStats {
  frames: number;
  renders: number;
  renderMs: number;
  footageWaitMs: number;
  captureMs: number;
  encodeWaitMs: number;
}

export const newStats = (): RenderStats => ({ frames: 0, renders: 0, renderMs: 0, footageWaitMs: 0, captureMs: 0, encodeWaitMs: 0 });

export function statsSummary(s: RenderStats): string {
  const per = (ms: number) => (s.frames ? (ms / s.frames).toFixed(1) : "0");
  return `per frame: render ${per(s.renderMs)} ms (${(s.renders / Math.max(1, s.frames)).toFixed(2)} renders), footage wait ${per(s.footageWaitMs)} ms, capture ${per(s.captureMs)} ms, encoder wait ${per(s.encodeWaitMs)} ms`;
}

export function rendererFrames(renderer: Renderer, project: Project, comp: CompItem, plan: FramePlan, warnings?: Set<string>, stats?: RenderStats): GpuFrameSource | undefined {
  if (typeof VideoFrame === "undefined" || typeof OffscreenCanvas === "undefined" || !(renderer.gl.canvas instanceof OffscreenCanvas)) return undefined;
  return async (time, width, height, timestamp, duration) => {
    const target = await renderReady(renderer, project, comp, plan, time, stats);
    try {
      for (const w of renderer.lastWarnings) warnings?.add(w);
      const t0 = performance.now();
      renderer.presentFrame(target, width, height, comp.bgColor);
      const frame = new VideoFrame(renderer.gl.canvas as OffscreenCanvas, { timestamp, duration, alpha: "discard" });
      if (stats) {
        stats.captureMs += performance.now() - t0;
        stats.frames++;
      }
      return frame;
    } finally {
      renderer.release(target);
    }
  };
}

/** Lets input, paint and encoder callbacks run between frames; MessageChannel is not throttled in background tabs. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Straight RGBA composited over an opaque background colour (0-1 RGB), as AE writes RGB-only output. */
export function matte(rgba: Uint8Array, background: readonly number[]): Uint8Array {
  const out = new Uint8Array(rgba.length);
  const bg = [0, 1, 2].map((c) => Math.round(Math.min(1, Math.max(0, background[c])) * 255));
  for (let p = 0; p < rgba.length; p += 4) {
    const a = rgba[p + 3];
    for (let c = 0; c < 3; c++) out[p + c] = Math.round((rgba[p + c] * a + bg[c] * (255 - a)) / 255);
    out[p + 3] = 255;
  }
  return out;
}

/** The top-left `width` x `height` of an RGBA image. */
export function crop(rgba: Uint8Array, stride: number, width: number, height: number): Uint8Array {
  if (stride === width && rgba.length === width * height * 4) return rgba;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) out.set(rgba.subarray(y * stride * 4, (y * stride + width) * 4), y * width * 4);
  return out;
}

/**
 * An integer track timescale in which one frame lasts a whole number of ticks: 24 for 24 fps,
 * 30000 for 29.97 (1001 ticks a frame), 90000 when no small multiple fits.
 */
export function mp4Timescale(fps: number): number {
  for (let k = 1; k <= 1001; k++) {
    const ticks = Math.round(fps * k);
    if (ticks > 0 && Math.abs(ticks / fps - k) < 1e-4) return ticks;
  }
  return 90000;
}

export function sequenceFileName(stem: string, frameNumber: number): string {
  return `${stem}_${String(frameNumber).padStart(5, "0")}.png`;
}

function stopped(): DOMException {
  return new DOMException("Render stopped", "AbortError");
}

/** Renders the comp's frames for the settings and writes the encoded file to `sink`. */
export async function renderToSink(
  comp: CompItem,
  settings: RenderSettings,
  output: OutputModule,
  source: FrameSource,
  sink: Sink,
  fileName: string,
  hooks: RenderHooks = {},
  /** The comp's mixed audio over the plan's span; PNG sequences carry none. */
  audio: MixedAudio | null = null,
): Promise<RenderSummary> {
  const plan = framePlan(comp, settings);
  const { width, height } = outputSize(plan, output.format);
  const channels = outputChannels(output);
  let written = 0;
  const write = async (bytes: Uint8Array) => {
    written += bytes.length;
    await sink.write(bytes);
  };
  const frameAt = async (index: number): Promise<Uint8Array> => {
    await hooks.resume?.();
    if (hooks.signal?.aborted) throw stopped();
    const rgba = crop(await source(plan.time(index)), plan.width, width, height);
    return channels === "rgb" ? matte(rgba, comp.bgColor) : rgba;
  };
  const done = async (index: number) => {
    hooks.onFrame?.(index + 1, plan.frames);
    await yieldToEventLoop();
  };

  if (output.format === "png") {
    const stem = fileName.replace(/\.[^.]+$/, "") || "frame";
    let failure: Error | null = null;
    let pending = Promise.resolve();
    const zip = new Zip((err, data) => {
      if (err) failure = err;
      else pending = pending.then(() => write(data));
    });
    for (let i = 0; i < plan.frames; i++) {
      const rgba = await frameAt(i);
      const file = new ZipPassThrough(sequenceFileName(stem, Math.round(plan.time(i) * plan.fps)));
      zip.add(file);
      file.push(encodePng(width, height, rgba, channels), true);
      await pending;
      if (failure) throw failure;
      await done(i);
    }
    zip.end();
    await pending;
    if (failure) throw failure;
    await sink.close();
    return { frames: plan.frames, width, height, fps: plan.fps, bytes: written };
  }

  const quality = output.quality ?? "good";
  const bitrate = output.bitrate ?? autoBitrate(width, height, plan.fps, quality);
  const choice = await chooseEncoder(output.format, width, height, plan.fps, bitrate, quality);
  const stepUs = (plan.duration / plan.frames) * 1e6;
  const keyInterval = Math.max(1, Math.round(plan.fps * 2));
  const stream = choice.config ? new StreamEncoder(choice.config) : null;
  let main: PictureEncoder;
  if (stream) main = stream;
  else if (output.format === "h264" && softwareH264Supported()) main = await SoftwareH264.create(width, height, plan.fps, bitrate, keyInterval, quality);
  else throw new Error(choice.error);
  const alpha = channels === "rgba" && choice.config ? new StreamEncoder({ ...choice.config, bitrate: Math.round(bitrate / 2) }) : null;
  const gpu = stream && !alpha && quality !== "high" ? hooks.gpuFrames : undefined;
  try {
    for (let i = 0; i < plan.frames; i++) {
      const timestamp = Math.round(i * stepUs);
      const duration = Math.round((i + 1) * stepUs) - timestamp;
      const key = i % keyInterval === 0;
      if (gpu && stream) {
        await hooks.resume?.();
        if (hooks.signal?.aborted) throw stopped();
        const frame = await gpu(plan.time(i), width, height, timestamp, duration);
        const t0 = performance.now();
        await stream.encodeFrame(frame, key);
        if (hooks.stats) hooks.stats.encodeWaitMs += performance.now() - t0;
      } else {
        const rgba = await frameAt(i);
        await main.encode(rgbToI420(rgba, width, height), timestamp, duration, key);
        if (alpha) await alpha.encode(alphaToI420(rgba, width, height), timestamp, duration, key);
      }
      await done(i);
    }
    await main.flush();
    await alpha?.flush();
  } finally {
    main.close();
    alpha?.close();
  }
  if (main.frames.length !== plan.frames || (alpha && alpha.frames.length !== plan.frames)) {
    throw new Error(`The encoder returned ${main.frames.length} of ${plan.frames} frames.`);
  }
  const durationUs = plan.duration * 1e6;
  let sound: EncodedAudio | null = null;
  if (audio) {
    // MP4 carries AAC, or Opus where the browser has no AAC encoder (Android, Linux).
    const codec = output.format === "h264" && (await audioSupported("aac")) ? "aac" : "opus";
    sound = await encodeAudio(audio, codec, hooks.signal);
    if (!sound.description) throw new Error("The audio encoder did not report its stream header.");
  }

  if (output.format === "h264") {
    // mp4-muxer uses `frameRate` as the track timescale and rounds timestamps to it.
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: "avc", width, height, frameRate: mp4Timescale(plan.fps) },
      ...(sound ? { audio: { codec: sound.codec, numberOfChannels: sound.numberOfChannels, sampleRate: sound.sampleRate } } : {}),
      fastStart: "in-memory",
    });
    for (const f of main.frames) muxer.addVideoChunkRaw(f.data, f.type, f.timestamp, f.duration, f.meta);
    // Blocks that start at or after the video's end are not heard.
    for (const a of sound?.chunks ?? []) if (a.chunk.timestamp < durationUs) muxer.addAudioChunk(a.chunk, a.meta);
    muxer.finalize();
    await write(new Uint8Array(muxer.target.buffer));
  } else {
    const muxer = new WebmMuxer({
      codec: "V_VP9",
      width,
      height,
      frameDuration: stepUs,
      alpha: !!alpha,
      colour: BT709_CODES,
      ...(sound?.description
        ? { audio: { sampleRate: sound.sampleRate, channels: sound.numberOfChannels, codecPrivate: sound.description, preSkip: sound.preSkip, endUs: durationUs } }
        : {}),
    });
    main.frames.forEach((f, i) => {
      const a = alpha?.frames[i];
      muxer.add({ data: f.data, alpha: a?.data, key: f.type === "key" && (!a || a.type === "key"), timestamp: f.timestamp });
    });
    for (const a of sound?.chunks ?? []) muxer.addAudio({ data: a.data, timestamp: a.chunk.timestamp, duration: a.chunk.duration ?? 20000 });
    await write(muxer.finish());
  }
  await sink.close();
  return { frames: plan.frames, width, height, fps: plan.fps, codec: choice.config?.codec ?? main.frames[0]?.meta?.decoderConfig?.codec, audioCodec: sound ? (sound.codec === "aac" ? "mp4a.40.2" : "opus") : undefined, bytes: written };
}

export function memorySink(): Sink & { bytes(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    async write(bytes) {
      parts.push(bytes);
    },
    async close() {},
    async abort() {
      parts.length = 0;
    },
    bytes() {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
      }
      return out;
    },
  };
}
