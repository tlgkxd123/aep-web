// Decodes a time window of a video file in presentation order with WebCodecs on
// this thread, handing each picture to a callback as a VideoFrame (closed after
// it returns), so analysis uploads pictures to the GPU without copying them out.
import { demuxVideo, type VideoTrack } from "../../media/mp4.ts";

export interface VideoInfo {
  track: VideoTrack;
  width: number;
  height: number;
  /** Presentation times of the samples, in order. */
  times: number[];
  frameRate: number;
  duration: number;
}

export async function videoInfo(blob: Blob): Promise<VideoInfo> {
  const track = await demuxVideo(blob);
  const times = track.samples.map((s) => s.time).filter((t) => t >= -1e-9).sort((a, b) => a - b);
  if (times.length < 2) throw new Error("The video has fewer than two frames.");
  const steps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const step = steps[steps.length >> 1];
  return { track, width: track.width, height: track.height, times, frameRate: 1 / step, duration: times[times.length - 1] + step };
}

/** Chunks waiting in the decoder before feeding pauses. */
const QUEUE = 6;

/**
 * Calls `each` for every picture shown in [from, to) seconds, in presentation order. `each` may be async;
 * decoding waits for it. Stops early when `signal` aborts.
 */
export async function decodeWindow(
  blob: Blob,
  info: VideoInfo,
  from: number,
  to: number,
  each: (frame: VideoFrame, index: number, time: number) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<number> {
  const { track } = info;
  const samples = track.samples;
  const config: VideoDecoderConfig = { codec: track.codec, codedWidth: track.width, codedHeight: track.height, description: track.description };
  if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`This browser cannot decode ${track.codec}.`);
  // Decode order: from the last key frame at or before `from` to past the last sample shown before `to`.
  let first = samples.findIndex((s) => s.time >= from - 1e-6);
  if (first < 0) return 0;
  while (first > 0 && !samples[first].isSync) first--;
  let last = samples.length - 1;
  for (let i = first; i < samples.length; i++) {
    if (samples[i].isSync && samples[i].time >= to) {
      last = i - 1;
      break;
    }
  }
  // The decoder hands pictures out in presentation order; each is used and closed at once, since hardware
  // decoders stall when the pictures they handed out are kept.
  const ready: VideoFrame[] = [];
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      ready.push(frame);
      wake?.();
    },
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
      wake?.();
    },
  });
  decoder.configure(config);
  let delivered = 0;
  let lastTime = -Infinity;
  const step = 1 / info.frameRate;
  const drain = async () => {
    while (ready.length) {
      const frame = ready.shift()!;
      const time = frame.timestamp / 1e6;
      try {
        if (time > lastTime && time >= from - 1e-6 && time < to - 1e-6 && !signal?.aborted) {
          lastTime = time;
          await each(frame, Math.round(time / step), time);
          delivered++;
        }
      } finally {
        frame.close();
      }
    }
  };
  try {
    const chunkBytes = 8 << 20;
    for (let i = first; i <= last && !signal?.aborted; ) {
      // Read a run of samples at once.
      let j = i;
      while (j <= last && samples[j].offset + samples[j].size - samples[i].offset < chunkBytes) j++;
      j = Math.max(j, i + 1);
      const start = samples[i].offset;
      const bytes = new Uint8Array(await blob.slice(start, samples[j - 1].offset + samples[j - 1].size).arrayBuffer());
      for (let k = i; k < j && !signal?.aborted; k++) {
        const s = samples[k];
        decoder.decode(new EncodedVideoChunk({ type: k === first || s.isSync ? "key" : "delta", timestamp: Math.round(s.time * 1e6), data: bytes.subarray(s.offset - start, s.offset - start + s.size) }));
        await drain();
        while (decoder.decodeQueueSize > QUEUE && !failure) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 10);
          });
          await drain();
        }
        if (failure) throw failure;
      }
      i = j;
    }
    await decoder.flush();
    if (failure) throw failure;
    await drain();
  } finally {
    for (const f of ready) f.close();
    if (decoder.state !== "closed") decoder.close();
  }
  return delivered;
}
