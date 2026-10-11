// Frame-accurate video decoding: WebCodecs VideoDecoder over the MP4/MOV
// demuxer, with an HTMLVideoElement seek fallback for what WebCodecs or the
// demuxer cannot handle.
import type { FootageFrame } from "./frames.ts";
import { demuxVideo, type VideoTrack } from "./mp4.ts";

/** Decoded frames are delivered by presentation index. */
export type FrameSink = (index: number, frame: FootageFrame) => void;

export interface VideoReader {
  /** Presentation index of the sample shown at `time` seconds. */
  indexAt(time: number): number;
  /** Number of presentation indices (Infinity when unknown). */
  readonly frameCount: number;
  /**
   * Decodes the sample at presentation index `index` (and usually its neighbours) into `sink`. Requests queue
   * behind each other; one whose `needed` returns false by its turn (an earlier run delivered it) does nothing.
   */
  decode(index: number, sink: FrameSink, needed?: () => boolean): Promise<void>;
  close(): void;
}

/** Samples decoded past the requested one in a single run, so playback does not restart from the key frame every frame. */
const LOOKAHEAD = 12;
/**
 * Pictures a reader keeps as decoded, unread, for the requests that follow: only requested ones are read out
 * (a copy of their planes), which matters when time remapping shows every few frames of a movie.
 */
const RAW_KEEP = 16;

/** Decoder work counters, for profiling playback and exports. */
export const videoStats = { resets: 0, fed: 0, frames: 0, convertMs: 0, waitMs: 0 };

/**
 * Planar frames keep their Y'CbCr samples: the footage shader converts them the way After Effects does (the
 * browser's own conversion picks another matrix and upsamples chroma differently). Reading the planes back
 * costs ~14 ms per 1080p frame, which is why decoding runs in a worker (src/media/videoWorker.ts).
 */
async function toFootageFrame(frame: VideoFrame): Promise<FootageFrame> {
  try {
    const format = frame.format;
    const width = frame.visibleRect?.width ?? frame.codedWidth;
    const height = frame.visibleRect?.height ?? frame.codedHeight;
    const limitedRange = !(frame.colorSpace?.fullRange ?? false);
    if (format === "I420" || format === "I420A" || format === "I422" || format === "I444" || format === "NV12") {
      // The planes stay as the decoder lays them out: no per-pixel work on the CPU, the footage shader reads them.
      const data = new Uint8Array(frame.allocationSize());
      const layout = await frame.copyTo(data);
      const xShift = format === "I444" ? 0 : 1;
      const yShift = format === "I420" || format === "I420A" || format === "NV12" ? 1 : 0;
      const planes = layout.slice(0, format === "NV12" ? 2 : 3).map(({ offset, stride }) => ({ offset, stride }));
      return {
        kind: "yuv",
        data,
        planes,
        interleaved: format === "NV12",
        width,
        height,
        chromaWidth: (width + xShift) >> xShift,
        chromaHeight: (height + yShift) >> yShift,
        limitedRange,
      };
    }
    if (format === "RGBA" || format === "RGBX" || format === "BGRA" || format === "BGRX") {
      const data = new Uint8Array(width * height * 4);
      await frame.copyTo(data, { layout: [{ offset: 0, stride: width * 4 }] });
      if (format.startsWith("BGR")) for (let i = 0; i < data.length; i += 4) [data[i], data[i + 2]] = [data[i + 2], data[i]];
      if (format.endsWith("X")) for (let i = 3; i < data.length; i += 4) data[i] = 255;
      return { kind: "rgba", data, width, height };
    }
    const image = await createImageBitmap(frame, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    return { kind: "bitmap", image, width: image.width, height: image.height };
  } finally {
    frame.close();
  }
}

/** How long to wait for a fed frame before flushing the decoder to force it out. */
const OUTPUT_TIMEOUT_MS = 1500;

/** What requests to a closed reader fail with. */
export const CLOSED = "the video was closed";

/**
 * Keeps one decoder per video and feeds it forward: playing or scrubbing ahead
 * continues from the last fed sample instead of restarting at the key frame, and
 * a sample already fed whose picture has not come out yet is waited for. It is
 * reset only for a jump backwards, into a later GOP or to a picture it already
 * delivered, and flushed only at the end of the file or when a frame does not
 * come out (after a flush the next chunk must be a key frame, so feeding
 * restarts from one).
 */
export class WebCodecsReader implements VideoReader {
  private decoder: VideoDecoder | undefined;
  private readonly order: number[];
  /** Presentation times of the shown samples, in order. */
  readonly times: number[];
  private readonly presentationIndex: Map<number, number>;
  private queue: Promise<void> = Promise.resolve();
  private readonly blob: Blob;
  private readonly track: VideoTrack;
  private readonly config: VideoDecoderConfig;
  /** Next sample (decode order) to feed; -1 when the decoder needs a key frame. */
  private fed = -1;
  /** Key frame (decode order) the decoder has been fed from since its last reset. */
  private began = -1;
  /** Presentation indices delivered since the last reset, with the number of requests finished at the time. */
  private readonly delivered = new Map<number, number>();
  /** Presentation indices that came out of the decoder since its last reset, delivered or not. */
  private readonly seen = new Set<number>();
  /** Pictures decoded on the way to a requested one, not read out yet. */
  private readonly raw = new Map<number, VideoFrame>();
  /** No picture is shown before the key frame of its GOP: decoding can skip ahead to any key frame. */
  private readonly closedGops: boolean;
  private completed = 0;
  private sink: FrameSink | undefined;
  private failure: Error | undefined;
  private readonly waiting = new Map<number, () => void>();
  private conversions: Promise<void>[] = [];
  private closed = false;

  constructor(blob: Blob, track: VideoTrack, config: VideoDecoderConfig) {
    this.blob = blob;
    this.track = track;
    this.config = config;
    // Presentation order: sample indices (decode order) sorted by time; samples before the first edit are not shown.
    this.order = track.samples
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.time >= -1e-9)
      .sort((a, b) => a.s.time - b.s.time)
      .map(({ i }) => i);
    this.times = this.order.map((i) => track.samples[i].time);
    this.presentationIndex = new Map(this.order.map((sample, p) => [sample, p]));
    let key = -1;
    this.closedGops = track.samples.every((s, i) => {
      if (s.isSync) key = i;
      return key >= 0 && s.time >= track.samples[key].time - 1e-9;
    });
  }

  /** Reads the picture's samples out and hands them to the current request's sink. */
  private deliver(p: number, frame: VideoFrame): void {
    const sink = this.sink;
    const started = performance.now();
    this.conversions.push(
      toFootageFrame(frame).then((f) => {
        videoStats.frames++;
        videoStats.convertMs += performance.now() - started;
        this.delivered.set(p, this.completed);
        sink?.(p, f);
        this.waiting.get(p)?.();
      }),
    );
  }

  /**
   * Keeps a picture nobody waits for as it came out, the earliest ones closed beyond RAW_KEEP. A hardware
   * decoder stalls when its few output pictures are held, so its pictures are read out at once instead.
   */
  private keep(p: number, frame: VideoFrame): void {
    if (this.config.hardwareAcceleration !== "prefer-software") {
      this.deliver(p, frame);
      return;
    }
    this.raw.get(p)?.close();
    this.raw.set(p, frame);
    while (this.raw.size > RAW_KEEP) {
      const oldest = Math.min(...this.raw.keys());
      this.raw.get(oldest)!.close();
      this.raw.delete(oldest);
    }
  }

  private forgetDecoded(): void {
    for (const frame of this.raw.values()) frame.close();
    this.raw.clear();
    this.seen.clear();
    this.delivered.clear();
  }

  private ensureDecoder(): VideoDecoder {
    if (this.closed) throw new Error(CLOSED);
    if (this.decoder && this.decoder.state !== "closed") return this.decoder;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const p = frame.timestamp;
        this.seen.add(p);
        if (this.waiting.has(p)) this.deliver(p, frame);
        else this.keep(p, frame);
      },
      error: (e) => {
        this.failure = e instanceof Error ? e : new Error(String(e));
        this.fed = -1;
        for (const done of this.waiting.values()) done();
      },
    });
    this.decoder.configure(this.config);
    this.fed = -1;
    this.began = -1;
    return this.decoder;
  }

  indexAt(time: number): number {
    return indexAtTimes(this.times, time);
  }

  get frameCount(): number {
    return this.times.length;
  }

  decode(index: number, sink: FrameSink, needed?: () => boolean): Promise<void> {
    const run = this.queue.then(() => (needed && !needed() ? undefined : this.run(index, sink).finally(() => this.completed++)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(index: number, sink: FrameSink): Promise<void> {
    const samples = this.track.samples;
    const target = this.order[Math.max(0, Math.min(this.order.length - 1, index))];
    if (target === undefined) throw new Error("the video has no frames");
    let start = target;
    while (start > 0 && !samples[start].isSync) start--;
    // A leading picture of an open GOP is shown before its key frame and needs the previous GOP.
    if (samples[target].time < samples[start].time && start > 0) {
      start--;
      while (start > 0 && !samples[start].isSync) start--;
    }
    const end = Math.min(samples.length, target + 1 + LOOKAHEAD);
    const wanted = this.presentationIndex.get(target) ?? -1;

    this.sink = sink;
    this.failure = undefined;
    const kept = this.raw.get(wanted);
    if (kept) {
      // Decoded on the way to an earlier request.
      this.raw.delete(wanted);
      this.deliver(wanted, kept);
      await this.settle();
      return;
    }
    let decoder = this.ensureDecoder();
    // Continue when the decoder has been fed through the target's GOP from its key frame on and the target's
    // picture is still to come: either not fed yet, or fed and on its way out.
    const live = this.fed >= 0 && this.began >= 0 && this.began <= start && start <= this.fed;
    const continues = live && (this.fed <= target || !this.seen.has(wanted));
    // Delivered after the previous request finished: the caller decided it was missing before the frame reached
    // it (from a worker, frames still coming out of the decoder arrive after the reply), so it is on its way.
    if (live && this.delivered.get(wanted) === this.completed) return;
    // Ahead of everything fed, in a later GOP: feeding goes on from its key frame without restarting the decoder
    // (a restart costs tens of milliseconds), skipping the samples between, which a request for them restarts.
    const skips = !continues && this.closedGops && this.fed >= 0 && this.began >= 0 && start > this.fed;
    if (skips) {
      this.fed = start;
      this.began = start;
    } else if (!continues) {
      videoStats.resets++;
      decoder.reset();
      decoder.configure(this.config);
      this.fed = start;
      this.began = start;
      this.forgetDecoded();
    }
    const from = this.fed;
    const arrived = new Promise<void>((resolve) => this.waiting.set(wanted, resolve));
    if (from < end) {
      const first = samples[from].offset;
      const last = samples[end - 1].offset + samples[end - 1].size;
      const bytes = new Uint8Array(await this.blob.slice(first, last).arrayBuffer());
      for (let i = from; i < end; i++) {
        const s = samples[i];
        decoder.decode(
          new EncodedVideoChunk({
            type: (i === from && !continues && !skips) || s.isSync ? "key" : "delta",
            timestamp: this.presentationIndex.get(i) ?? -1,
            data: bytes.subarray(s.offset - first, s.offset - first + s.size),
          }),
        );
      }
      videoStats.fed += end - from;
      this.fed = end;
    }
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), OUTPUT_TIMEOUT_MS));
    const atEnd = end >= samples.length;
    const waiting = performance.now();
    const outcome = atEnd ? "end" : await Promise.race([arrived, timeout]);
    videoStats.waitMs += performance.now() - waiting;
    if (outcome !== undefined) {
      decoder = this.ensureDecoder();
      await decoder.flush();
      this.fed = -1;
    }
    this.waiting.delete(wanted);
    await this.settle();
  }

  /** Waits for the pictures being read out; throws the decoder's error, if any. */
  private async settle(): Promise<void> {
    const conversions = this.conversions;
    this.conversions = [];
    await Promise.all(conversions);
    if (this.failure) throw this.failure;
  }

  /** Final: a run waiting for a picture fails at once (not after OUTPUT_TIMEOUT_MS) and no decoder opens again. */
  close(): void {
    this.closed = true;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined;
    this.forgetDecoded();
    this.failure = new Error(CLOSED);
    for (const done of this.waiting.values()) done();
  }
}

/**
 * Whether an H.264 sample is a picture no other picture references (nal_ref_idc 0 on its slices): a decoder can
 * leave it out when it is not shown. False for other codecs (HEVC's non-reference pictures may still serve
 * higher temporal layers).
 */
export function isNonReference(track: Pick<VideoTrack, "codec" | "description">, sample: Uint8Array): boolean {
  if (!track.codec.startsWith("avc")) return false;
  const lengthSize = track.description && track.description.length > 4 ? (track.description[4] & 3) + 1 : 4;
  for (let at = 0; at + lengthSize < sample.length; ) {
    let size = 0;
    for (let i = 0; i < lengthSize; i++) size = size * 256 + sample[at + i];
    const header = sample[at + lengthSize];
    const type = header & 0x1f;
    if (type === 1 || type === 5) return (header & 0x60) === 0;
    at += lengthSize + size;
  }
  return false;
}

/** Presentation index of the sample shown at `time`, tolerating timestamps rounded to the media timescale. */
export function indexAtTimes(times: number[], time: number): number {
  const t = time + 1e-4;
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * A WebCodecs reader for the file's video track; fails when the demuxer or the browser cannot handle it.
 * `preferSoftware` asks for a software decoder when there is one: its frames sit in memory, so reading their
 * planes is a copy instead of a GPU readback.
 */
export async function openWebCodecs(blob: Blob, preferSoftware = false): Promise<WebCodecsReader> {
  const track = await demuxVideo(blob);
  const base: VideoDecoderConfig = { codec: track.codec, codedWidth: track.width, codedHeight: track.height, description: track.description };
  const configs: VideoDecoderConfig[] = preferSoftware ? [{ ...base, hardwareAcceleration: "prefer-software" }, base] : [base];
  for (const config of configs) {
    if ((await VideoDecoder.isConfigSupported(config)).supported) return new WebCodecsReader(blob, track, config);
  }
  throw new Error(`codec ${track.codec} is not supported by this browser`);
}

/** Messages to src/media/videoWorker.ts. */
export type WorkerRequest = { type: "open"; blob: Blob } | { type: "decode"; id: number; index: number };

/** Messages from src/media/videoWorker.ts; `stats` is the worker's running videoStats. */
export type WorkerReply =
  | { type: "opened"; times: number[] }
  | { type: "failed"; message: string }
  | { type: "frame"; index: number; frame: FootageFrame }
  | { type: "done"; id: number; error?: string; stats: typeof videoStats };

/** What a frame's postMessage can hand over without copying. */
export function transferables(frame: FootageFrame): Transferable[] {
  return frame.kind === "bitmap" ? [frame.image] : [frame.data.buffer as ArrayBuffer];
}

/** Seeks an HTMLVideoElement and captures the frame; only as frame-accurate as the browser's seeking. */
export class ElementReader implements VideoReader {
  private queue: Promise<void> = Promise.resolve();
  private readonly video: HTMLVideoElement;
  private readonly url: string;
  private readonly frameRate: number;
  private closed = false;
  /** Fails the seek in progress. */
  private abort: (() => void) | undefined;

  private constructor(video: HTMLVideoElement, url: string, frameRate: number) {
    this.video = video;
    this.url = url;
    this.frameRate = frameRate;
  }

  static async open(blob: Blob, frameRate: number): Promise<ElementReader> {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const url = URL.createObjectURL(blob);
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("the browser cannot play this video"));
    });
    return new ElementReader(video, url, frameRate);
  }

  indexAt(time: number): number {
    return Math.max(0, Math.floor(time * this.frameRate + 1e-6));
  }

  get frameCount(): number {
    return Number.isFinite(this.video.duration) ? Math.ceil(this.video.duration * this.frameRate) : Infinity;
  }

  decode(index: number, sink: FrameSink, needed?: () => boolean): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.closed) throw new Error(CLOSED);
      if (needed && !needed()) return;
      const video = this.video;
      await new Promise<void>((resolve, reject) => {
        this.abort = () => reject(new Error(CLOSED));
        video.onseeked = () => resolve();
        video.currentTime = Math.min(video.duration || Infinity, (index + 0.5) / this.frameRate);
      });
      this.abort = undefined;
      const image = await createImageBitmap(video, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      sink(index, { kind: "bitmap", image, width: image.width, height: image.height });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.closed = true;
    this.abort?.();
    this.video.removeAttribute("src");
    URL.revokeObjectURL(this.url);
  }
}