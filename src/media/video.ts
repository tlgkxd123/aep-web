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
  /** Decodes the sample at presentation index `index` (and usually its neighbours) into `sink`. */
  decode(index: number, sink: FrameSink): Promise<void>;
  close(): void;
}

/** Samples decoded past the requested one in a single run, so playback does not restart from the key frame every frame. */
const LOOKAHEAD = 12;

async function toFootageFrame(frame: VideoFrame): Promise<FootageFrame> {
  try {
    const format = frame.format;
    const width = frame.visibleRect?.width ?? frame.codedWidth;
    const height = frame.visibleRect?.height ?? frame.codedHeight;
    const limitedRange = !(frame.colorSpace?.fullRange ?? false);
    if (format === "I420" || format === "I420A" || format === "I422" || format === "I444" || format === "NV12") {
      const buffer = new Uint8Array(frame.allocationSize());
      const layout = await frame.copyTo(buffer);
      const xShift = format === "I444" ? 0 : 1;
      const yShift = format === "I420" || format === "I420A" || format === "NV12" ? 1 : 0;
      const chromaWidth = (width + xShift) >> xShift;
      const chromaHeight = (height + yShift) >> yShift;
      const plane = (index: number, w: number, h: number) => {
        const { offset, stride } = layout[index];
        const out = new Uint8Array(w * h);
        for (let r = 0; r < h; r++) out.set(buffer.subarray(offset + r * stride, offset + r * stride + w), r * w);
        return out;
      };
      const y = plane(0, width, height);
      let u: Uint8Array;
      let v: Uint8Array;
      if (format === "NV12") {
        const { offset, stride } = layout[1];
        u = new Uint8Array(chromaWidth * chromaHeight);
        v = new Uint8Array(chromaWidth * chromaHeight);
        for (let r = 0; r < chromaHeight; r++) {
          for (let c = 0; c < chromaWidth; c++) {
            u[r * chromaWidth + c] = buffer[offset + r * stride + c * 2];
            v[r * chromaWidth + c] = buffer[offset + r * stride + c * 2 + 1];
          }
        }
      } else {
        u = plane(1, chromaWidth, chromaHeight);
        v = plane(2, chromaWidth, chromaHeight);
      }
      return { kind: "yuv", y, u, v, width, height, chromaWidth, chromaHeight, limitedRange };
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

/**
 * Keeps one decoder per video and feeds it forward: playing or scrubbing ahead
 * continues from the last fed sample instead of restarting at the key frame.
 * It is reset only for a jump backwards or into a later GOP, and flushed only
 * at the end of the file or when a frame does not come out (after a flush the
 * next chunk must be a key frame, so feeding restarts from one).
 */
class WebCodecsReader implements VideoReader {
  private decoder: VideoDecoder | undefined;
  private readonly order: number[];
  private readonly times: number[];
  private readonly presentationIndex: Map<number, number>;
  private queue: Promise<void> = Promise.resolve();
  private readonly blob: Blob;
  private readonly track: VideoTrack;
  private readonly config: VideoDecoderConfig;
  /** Next sample (decode order) to feed; -1 when the decoder needs a key frame. */
  private fed = -1;
  private sink: FrameSink | undefined;
  private failure: Error | undefined;
  private readonly waiting = new Map<number, () => void>();
  private conversions: Promise<void>[] = [];

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
  }

  private ensureDecoder(): VideoDecoder {
    if (this.decoder && this.decoder.state !== "closed") return this.decoder;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const p = frame.timestamp;
        const sink = this.sink;
        this.conversions.push(
          toFootageFrame(frame).then((f) => {
            sink?.(p, f);
            this.waiting.get(p)?.();
          }),
        );
      },
      error: (e) => {
        this.failure = e instanceof Error ? e : new Error(String(e));
        this.fed = -1;
        for (const done of this.waiting.values()) done();
      },
    });
    this.decoder.configure(this.config);
    this.fed = -1;
    return this.decoder;
  }

  indexAt(time: number): number {
    // Tolerates timestamps rounded to the media timescale.
    const t = time + 1e-4;
    let lo = 0;
    let hi = this.times.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  decode(index: number, sink: FrameSink): Promise<void> {
    const run = this.queue.then(() => this.run(index, sink));
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
    let decoder = this.ensureDecoder();
    // Continue feeding when the target's GOP has already started and the target is still ahead.
    const continues = this.fed >= 0 && start <= this.fed && this.fed <= target;
    if (!continues) {
      decoder.reset();
      decoder.configure(this.config);
      this.fed = start;
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
            type: (i === from && !continues) || s.isSync ? "key" : "delta",
            timestamp: this.presentationIndex.get(i) ?? -1,
            data: bytes.subarray(s.offset - first, s.offset - first + s.size),
          }),
        );
      }
      this.fed = end;
    }
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), OUTPUT_TIMEOUT_MS));
    const atEnd = end >= samples.length;
    if (atEnd || (await Promise.race([arrived, timeout])) === "timeout") {
      decoder = this.ensureDecoder();
      await decoder.flush();
      this.fed = -1;
    }
    this.waiting.delete(wanted);
    const conversions = this.conversions;
    this.conversions = [];
    await Promise.all(conversions);
    if (this.failure) throw this.failure;
  }

  close(): void {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined;
  }
}

/** Seeks an HTMLVideoElement and captures the frame; only as frame-accurate as the browser's seeking. */
class ElementReader implements VideoReader {
  private queue: Promise<void> = Promise.resolve();
  private readonly video: HTMLVideoElement;
  private readonly url: string;
  private readonly frameRate: number;

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

  decode(index: number, sink: FrameSink): Promise<void> {
    const run = this.queue.then(async () => {
      const video = this.video;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = Math.min(video.duration || Infinity, (index + 0.5) / this.frameRate);
      });
      const image = await createImageBitmap(video, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      sink(index, { kind: "bitmap", image, width: image.width, height: image.height });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.video.removeAttribute("src");
    URL.revokeObjectURL(this.url);
  }
}

/** Opens a video file: WebCodecs when the browser has it and supports the codec, else a video element. */
export async function openVideo(blob: Blob, frameRate: number): Promise<VideoReader> {
  let reason = "";
  if (typeof VideoDecoder !== "undefined") {
    try {
      const track = await demuxVideo(blob);
      const config: VideoDecoderConfig = { codec: track.codec, codedWidth: track.width, codedHeight: track.height, description: track.description };
      if ((await VideoDecoder.isConfigSupported(config)).supported) return new WebCodecsReader(blob, track, config);
      reason = `codec ${track.codec} is not supported by this browser`;
    } catch (e) {
      reason = (e as Error).message;
    }
  }
  if (typeof document === "undefined") throw new Error(reason || "video decoding needs WebCodecs");
  try {
    return await ElementReader.open(blob, frameRate);
  } catch (e) {
    throw new Error(reason || (e as Error).message);
  }
}
