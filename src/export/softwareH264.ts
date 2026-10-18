// H.264 encoded in WebAssembly (minih264 through h264-mp4-encoder, MIT / public domain / MPL 1.1 libmp4v2), for
// browsers whose WebCodecs has no H.264 encoder, such as Android's WebView. It encodes in a worker, so a frame encodes
// while the next one renders. The encoder writes an MP4 of its own; its samples are read back so the export's muxer
// writes them with the audio track and the colour signalling.
import type { H264MP4Encoder } from "h264-mp4-encoder";
import type { Quality } from "./settings.ts";
import type { EncodedFrame, PictureEncoder } from "./video.ts";
import { BT709, type I420 } from "./yuv.ts";

let source: Promise<string> | undefined;

/** The encoder's web build: a classic script declaring a global `HME`. */
function encoderSource(): Promise<string> {
  source ??= import("h264-mp4-encoder/embuild/dist/h264-mp4-encoder.web.js?raw").then((m) => m.default);
  return source;
}

export const softwareH264Supported = (): boolean => typeof WebAssembly !== "undefined" && typeof Worker !== "undefined";

const SPEED: Record<Quality, number> = { fast: 10, good: 5, high: 0 };

/** Pictures handed to the worker and not yet encoded, at most: the rendering keeps this far ahead of the encoding. */
const MAX_QUEUED = 2;

interface EncoderSettings {
  width: number;
  height: number;
  frameRate: number;
  kbps: number;
  speed: number;
  groupOfPictures: number;
}

type ToWorker = ({ type: "init" } & EncoderSettings) | { type: "frame"; data: ArrayBuffer; offset: number; length: number } | { type: "finish" };
type FromWorker = { type: "ready" } | { type: "encoded"; ms: number } | { type: "finished"; mp4: Uint8Array } | { type: "error"; message: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
}

/**
 * The worker's code, after the encoder's script: one encoder fed pictures in order. Its source becomes the worker's,
 * so it uses nothing but its arguments.
 */
function encoderWorker(hme: { createH264MP4Encoder(): Promise<H264MP4Encoder> }, scope: WorkerScope): void {
  let encoder: H264MP4Encoder | null = null;
  const fail = (e: unknown) => scope.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
  scope.onmessage = (event) => {
    const message = event.data;
    try {
      if (message.type === "init") {
        hme.createH264MP4Encoder().then((created) => {
          encoder = created;
          encoder.width = message.width;
          encoder.height = message.height;
          encoder.frameRate = message.frameRate;
          encoder.kbps = message.kbps;
          encoder.speed = message.speed;
          encoder.groupOfPictures = message.groupOfPictures;
          encoder.outputFilename = "export.mp4";
          encoder.initialize();
          scope.postMessage({ type: "ready" });
        }, fail);
      } else if (message.type === "frame") {
        const started = performance.now();
        encoder!.addFrameYuv(new Uint8Array(message.data, message.offset, message.length));
        scope.postMessage({ type: "encoded", ms: performance.now() - started });
      } else {
        encoder!.finalize();
        const mp4 = encoder!.FS.readFile(encoder!.outputFilename);
        encoder!.FS.unlink(encoder!.outputFilename);
        encoder!.delete();
        encoder = null;
        scope.postMessage({ type: "finished", mp4 }, [mp4.buffer]);
      }
    } catch (e) {
      fail(e);
    }
  };
}

interface Box {
  type: string;
  body: number;
  end: number;
}

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Box[] = [];
  for (let p = start; p + 8 <= end; ) {
    let size = view.getUint32(p);
    let body = p + 8;
    if (size === 1) {
      size = Number(view.getBigUint64(p + 8));
      body += 8;
    } else if (size === 0) size = end - p;
    if (size < 8 || p + size > end) break;
    out.push({ type: String.fromCharCode(...bytes.subarray(p + 4, p + 8)), body, end: p + size });
    p += size;
  }
  return out;
}

function child(bytes: Uint8Array, parent: Box | undefined, path: string[]): Box | undefined {
  let at = parent;
  for (const type of path) at = at && boxes(bytes, at.body, at.end).find((b) => b.type === type);
  return at;
}

/** The video samples and the avcC of a single-track MP4. */
export function readMp4Video(bytes: Uint8Array): { description: Uint8Array; samples: Uint8Array[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = boxes(bytes, 0, bytes.length).find((b) => b.type === "moov");
  const stbl = child(bytes, moov, ["trak", "mdia", "minf", "stbl"]);
  const stsd = child(bytes, stbl, ["stsd"]);
  const stsz = child(bytes, stbl, ["stsz"]);
  const stsc = child(bytes, stbl, ["stsc"]);
  const stco = child(bytes, stbl, ["stco"]) ?? child(bytes, stbl, ["co64"]);
  if (!stsd || !stsz || !stsc || !stco) throw new Error("The H.264 encoder wrote an MP4 without a sample table.");
  // stsd: version/flags, entry count, then the avc1 entry whose children follow its 78 bytes of fields.
  const avc1 = boxes(bytes, stsd.body + 8, stsd.end)[0];
  const avcC = avc1 && boxes(bytes, avc1.body + 78, avc1.end).find((b) => b.type === "avcC");
  if (!avcC) throw new Error("The H.264 encoder wrote no avcC.");
  const fixed = view.getUint32(stsz.body + 4);
  const count = view.getUint32(stsz.body + 8);
  const sizes = Array.from({ length: count }, (_, i) => fixed || view.getUint32(stsz.body + 12 + i * 4));
  const chunks = view.getUint32(stco.body + 4);
  const offsets = Array.from({ length: chunks }, (_, i) =>
    stco.type === "co64" ? Number(view.getBigUint64(stco.body + 8 + i * 8)) : view.getUint32(stco.body + 8 + i * 4),
  );
  const runs = Array.from({ length: view.getUint32(stsc.body + 4) }, (_, i) => ({
    first: view.getUint32(stsc.body + 8 + i * 12) - 1,
    perChunk: view.getUint32(stsc.body + 12 + i * 12),
  }));
  const samples: Uint8Array[] = [];
  for (let c = 0, s = 0; c < chunks && s < count; c++) {
    const run = runs.filter((r) => r.first <= c).pop();
    let p = offsets[c];
    for (let k = 0; k < (run?.perChunk ?? 1) && s < count; k++, s++) {
      samples.push(bytes.subarray(p, p + sizes[s]));
      p += sizes[s];
    }
  }
  return { description: bytes.slice(avcC.body, avcC.end), samples };
}

/** Whether a sample of 4-byte length-prefixed NAL units holds an IDR slice (the encoder's MP4 marks every sample sync). */
function isIdr(sample: Uint8Array): boolean {
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
  for (let p = 0; p + 4 < sample.length; p += 4 + view.getUint32(p)) if ((sample[p + 4] & 31) === 5) return true;
  return false;
}

const hex = (n: number) => n.toString(16).padStart(2, "0");

export class SoftwareH264 implements PictureEncoder {
  readonly frames: EncodedFrame[] = [];
  busyMs = 0;
  private readonly times: { timestamp: number; duration: number }[] = [];
  private worker: Worker | null;
  private readonly width: number;
  private readonly height: number;
  private started = false;
  private queued = 0;
  private mp4: Uint8Array | null = null;
  private failure: Error | null = null;
  private readonly waiters: (() => void)[] = [];

  private constructor(worker: Worker, width: number, height: number) {
    this.worker = worker;
    this.width = width;
    this.height = height;
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(event.message || "its worker stopped");
    };
  }

  static async create(width: number, height: number, fps: number, bitrate: number, keyInterval: number, quality: Quality): Promise<SoftwareH264> {
    const script = `${await encoderSource()}\n(${encoderWorker.toString()})(HME, self);`;
    const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
    const encoder = new SoftwareH264(new Worker(url), width, height);
    const settings: EncoderSettings = {
      width,
      height,
      frameRate: Math.max(1, Math.round(fps)),
      kbps: Math.max(1, Math.round(bitrate / 1000)),
      speed: SPEED[quality],
      groupOfPictures: keyInterval,
    };
    encoder.worker!.postMessage({ type: "init", ...settings } satisfies ToWorker);
    try {
      await encoder.until(() => encoder.started);
    } catch (e) {
      encoder.close();
      throw e;
    } finally {
      URL.revokeObjectURL(url);
    }
    return encoder;
  }

  private receive(message: FromWorker): void {
    if (message.type === "ready") this.started = true;
    else if (message.type === "encoded") {
      this.queued--;
      this.busyMs += message.ms;
    } else if (message.type === "finished") this.mp4 = message.mp4;
    else return this.fail(message.message);
    this.wake();
  }

  private fail(message: string): void {
    this.failure ??= new Error(`The H.264 encoder failed: ${message}`);
    this.wake();
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private async until(done: () => boolean): Promise<void> {
    for (;;) {
      if (this.failure) throw this.failure;
      if (!this.worker) throw new Error("The H.264 encoder is closed.");
      if (done()) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  async encode(picture: I420, timestamp: number, duration: number): Promise<void> {
    await this.until(() => this.queued < MAX_QUEUED);
    const { buffer, byteOffset, byteLength } = picture.data;
    this.worker!.postMessage({ type: "frame", data: buffer as ArrayBuffer, offset: byteOffset, length: byteLength } satisfies ToWorker, [buffer as ArrayBuffer]);
    this.queued++;
    this.times.push({ timestamp, duration });
  }

  async flush(): Promise<void> {
    if (!this.worker) return;
    this.worker.postMessage({ type: "finish" } satisfies ToWorker);
    await this.until(() => this.mp4 !== null);
    const mp4 = this.mp4!;
    this.close();
    const { description, samples } = readMp4Video(mp4);
    const codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
    samples.forEach((data, i) => {
      const time = this.times[i] ?? { timestamp: 0, duration: 0 };
      this.frames.push({
        data,
        type: i === 0 || isIdr(data) ? "key" : "delta",
        ...time,
        meta: i === 0 ? { decoderConfig: { codec, codedWidth: this.width, codedHeight: this.height, description, colorSpace: { ...BT709 } } } : undefined,
      });
    });
  }

  close(): void {
    this.worker?.terminate();
    this.worker = null;
    this.wake();
  }
}
