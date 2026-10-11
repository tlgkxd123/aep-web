import { BT709, type I420 } from "./yuv.ts";

export interface EncodedFrame {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number;
  meta?: EncodedVideoChunkMetadata;
}

/** An encoder of I420 pictures whose frames are complete after `flush`. */
export interface PictureEncoder {
  readonly frames: EncodedFrame[];
  encode(picture: I420, timestamp: number, duration: number, key: boolean): Promise<void>;
  flush(): Promise<void>;
  close(): void;
}

/** A VideoEncoder fed with I420 pictures, collecting chunks in output order with backpressure and error propagation. */
export class StreamEncoder implements PictureEncoder {
  private readonly encoder: VideoEncoder;
  private failure: Error | null = null;
  private readonly waiters: (() => void)[] = [];
  readonly frames: EncodedFrame[] = [];
  decoderConfig?: VideoDecoderConfig;

  constructor(config: VideoEncoderConfig) {
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        if (meta?.decoderConfig) this.decoderConfig = { ...meta.decoderConfig, colorSpace: { ...BT709 } };
        this.frames.push({ data, type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? 0, meta: meta?.decoderConfig ? { ...meta, decoderConfig: this.decoderConfig } : meta });
      },
      error: (e) => {
        this.failure = e instanceof Error ? e : new Error(String(e));
        this.wake();
      },
    });
    this.encoder.addEventListener("dequeue", () => this.wake());
    this.encoder.configure(config);
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private check(): void {
    if (this.failure) throw new Error(`Video encoder failed: ${this.failure.message}`);
  }

  async encode(picture: I420, timestamp: number, duration: number, key: boolean): Promise<void> {
    this.check();
    while (this.encoder.encodeQueueSize > 3 && !this.failure) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.check();
    const frame = new VideoFrame(picture.data, {
      format: "I420",
      codedWidth: picture.width,
      codedHeight: picture.height,
      timestamp,
      duration,
      layout: picture.layout,
      colorSpace: { ...BT709 },
    });
    try {
      this.encoder.encode(frame, { keyFrame: key });
    } finally {
      frame.close();
    }
  }

  /** Encodes a frame the caller made (e.g. straight from a canvas); the frame is closed here. */
  async encodeFrame(frame: VideoFrame, key: boolean): Promise<void> {
    try {
      this.check();
      while (this.encoder.encodeQueueSize > 3 && !this.failure) await new Promise<void>((resolve) => this.waiters.push(resolve));
      this.check();
      this.encoder.encode(frame, { keyFrame: key });
    } finally {
      frame.close();
    }
  }

  async flush(): Promise<void> {
    this.check();
    await this.encoder.flush();
    this.check();
  }

  close(): void {
    if (this.encoder.state !== "closed") this.encoder.close();
  }
}
