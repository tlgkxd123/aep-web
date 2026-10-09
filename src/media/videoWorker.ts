// Decodes one video file off the main thread: the WebCodecs reader of video.ts,
// driven by WorkerReader (openVideo.ts). Reading a decoded frame's planes back
// from the GPU blocks for ~14 ms per 1080p frame; here it no longer holds up
// rendering, and frames reach the page as transferred buffers.
import { openWebCodecs, transferables, videoStats, type WebCodecsReader, type WorkerReply, type WorkerRequest } from "./video.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
};

let reader: WebCodecsReader | undefined;
let queue: Promise<void> = Promise.resolve();

async function handle(message: WorkerRequest): Promise<void> {
  if (message.type === "open") {
    try {
      reader = await openWebCodecs(message.blob, true);
      scope.postMessage({ type: "opened", times: reader.times });
    } catch (e) {
      scope.postMessage({ type: "failed", message: (e as Error).message || "cannot decode the video" });
    }
    return;
  }
  try {
    if (!reader) throw new Error("the video is not open");
    await reader.decode(message.index, (index, frame) => scope.postMessage({ type: "frame", index, frame }, transferables(frame)));
    scope.postMessage({ type: "done", id: message.id, stats: { ...videoStats } });
  } catch (e) {
    scope.postMessage({ type: "done", id: message.id, error: (e as Error).message || "cannot decode the video", stats: { ...videoStats } });
  }
}

scope.onmessage = (event) => {
  queue = queue.then(() => handle(event.data));
};
