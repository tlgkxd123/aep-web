// Opening video files: WebCodecs in a worker per file where the browser has workers
// (videoWorker.ts), WebCodecs on this thread otherwise, and an HTMLVideoElement
// for what WebCodecs or the demuxer cannot handle.
import { ElementReader, indexAtTimes, openWebCodecs, videoStats, type FrameSink, type VideoReader, type WorkerReply, type WorkerRequest } from "./video.ts";

/** Proxies a WebCodecsReader running in a worker; requests queue as they do on the reader itself. */
class WorkerReader implements VideoReader {
  private readonly worker: Worker;
  private readonly times: number[];
  private queue: Promise<void> = Promise.resolve();
  private sink: FrameSink | undefined;
  private readonly pending = new Map<number, (error?: string) => void>();
  private nextId = 1;
  private reported = { resets: 0, fed: 0, frames: 0, convertMs: 0, waitMs: 0 };

  private constructor(worker: Worker, times: number[]) {
    this.worker = worker;
    this.times = times;
    worker.onmessage = (event: MessageEvent<WorkerReply>) => this.receive(event.data);
    worker.onerror = (event) => {
      for (const done of this.pending.values()) done(event.message || "the video worker stopped");
      this.pending.clear();
    };
  }

  static async open(blob: Blob): Promise<WorkerReader> {
    const { default: VideoWorker } = await import("./videoWorker.ts?worker&inline");
    const worker = new VideoWorker();
    try {
      const times = await new Promise<number[]>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<WorkerReply>) => {
          if (event.data.type === "opened") resolve(event.data.times);
          else if (event.data.type === "failed") reject(new Error(event.data.message));
        };
        worker.onerror = (event) => reject(new Error(event.message || "the video worker failed to start"));
        worker.postMessage({ type: "open", blob } satisfies WorkerRequest);
      });
      return new WorkerReader(worker, times);
    } catch (e) {
      worker.terminate();
      throw e;
    }
  }

  private receive(message: WorkerReply): void {
    if (message.type === "frame") this.sink?.(message.index, message.frame);
    else if (message.type === "done") {
      // Fold the worker's counters into this thread's.
      for (const key of Object.keys(this.reported) as (keyof typeof videoStats)[]) {
        videoStats[key] += message.stats[key] - this.reported[key];
        this.reported[key] = message.stats[key];
      }
      this.pending.get(message.id)?.(message.error);
      this.pending.delete(message.id);
    }
  }

  indexAt(time: number): number {
    return indexAtTimes(this.times, time);
  }

  get frameCount(): number {
    return this.times.length;
  }

  decode(index: number, sink: FrameSink, needed?: () => boolean): Promise<void> {
    const run = this.queue.then(() => (needed && !needed() ? undefined : this.request(index, sink)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private request(index: number, sink: FrameSink): Promise<void> {
    this.sink = sink;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (error) => (error ? reject(new Error(error)) : resolve()));
      this.worker.postMessage({ type: "decode", id, index } satisfies WorkerRequest);
    });
  }

  close(): void {
    this.worker.terminate();
    for (const done of this.pending.values()) done("the video was closed");
    this.pending.clear();
  }
}

/** Opens a video file: WebCodecs (in a worker when possible) when the browser supports the codec, else a video element. */
export async function openVideo(blob: Blob, frameRate: number): Promise<VideoReader> {
  let reason = "";
  if (typeof VideoDecoder !== "undefined") {
    if (typeof Worker !== "undefined") {
      try {
        return await WorkerReader.open(blob);
      } catch (e) {
        reason = (e as Error).message;
      }
    }
    try {
      return await openWebCodecs(blob);
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
