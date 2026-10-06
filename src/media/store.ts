// The browser's stand-in for the disk: files the user picked (or the harness
// added), matched to footage items the way After Effects relinks — the most
// trailing path components in common, the file name at least — and decoded on
// demand. Decoding is asynchronous; the renderer asks for frames synchronously,
// gets "pending" the first time and is told to render again when they arrive.
import type { FootageItem } from "../aep/model.ts";
import { sequenceFrameName } from "../aep/footage.ts";
import { decodeAudio, registeredAudio, type AudioData } from "./audio.ts";
import { frameBytes, releaseFrame, type FootageFrame } from "./frames.ts";
import { decodePsd, isPsd } from "./psd.ts";
import { decodeTiff, isTiff } from "./tiff.ts";
import { openVideo, type VideoReader } from "./video.ts";

export type FrameState =
  | { status: "ready"; frame: FootageFrame }
  | { status: "pending" }
  /** No file for it among the located files. */
  | { status: "missing"; path: string }
  | { status: "error"; message: string };

export type AudioState =
  | { status: "ready"; audio: AudioData }
  | { status: "pending" }
  | { status: "missing"; path: string }
  | { status: "error"; message: string };

interface StoredFile {
  parts: string[];
  blob: Blob;
}

interface ItemMedia {
  id: number;
  /** Store generation it was resolved in; unresolved media is re-resolved after files are added. */
  generation: number;
  kind: "image" | "sequence" | "video";
  /** Main file (the first frame of a sequence), when located. */
  blob?: Blob;
  path: string;
  video?: VideoReader;
  opening?: boolean;
  error?: string;
  /** Sequence frames located so far, by frame index. */
  frames: Map<number, Blob | null>;
  requested: Set<number>;
  failed: Map<number, string>;
  audio?: AudioData;
  audioDecoding?: boolean;
  audioError?: string;
}

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "qt", "3gp", "webm", "mkv", "avi", "mxf"]);
const CACHE_BYTES = 384 * 1024 * 1024;

const split = (path: string) => path.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());

export async function decodeImage(blob: Blob): Promise<FootageFrame> {
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  if (isTiff(head)) return decodeTiff(new Uint8Array(await blob.arrayBuffer()));
  if (isPsd(head)) return decodePsd(new Uint8Array(await blob.arrayBuffer()));
  const image = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  return { kind: "bitmap", image, width: image.width, height: image.height };
}

export class FootageStore {
  private readonly byName = new Map<string, StoredFile[]>();
  private media = new WeakMap<FootageItem, ItemMedia>();
  private readonly cache = new Map<string, { frame: FootageFrame; bytes: number }>();
  private cacheBytes = 0;
  private readonly listeners = new Set<() => void>();
  private readonly inflight = new Set<Promise<unknown>>();
  private nextId = 1;
  private generation = 0;
  private fileCount = 0;
  private notifyScheduled = false;
  private changes = 0;

  /** Number of files located so far. */
  get size(): number {
    return this.fileCount;
  }

  /** Increments whenever files are added or decoded frames arrive. */
  get version(): number {
    return this.changes;
  }

  /** Adds files by path (relative paths from a picked folder, or bare names). Returns how many were added. */
  addFiles(files: Iterable<{ path: string; blob: Blob }>): number {
    let added = 0;
    for (const { path, blob } of files) {
      const parts = split(path);
      const name = parts[parts.length - 1];
      if (!name) continue;
      const list = this.byName.get(name) ?? [];
      const existing = list.findIndex((f) => f.parts.join("/") === parts.join("/"));
      if (existing >= 0) list[existing] = { parts, blob };
      else {
        list.push({ parts, blob });
        this.fileCount++;
      }
      this.byName.set(name, list);
      added++;
    }
    if (added) {
      this.generation++;
      this.notify();
    }
    return added;
  }

  /** Forgets every located file and decoded frame. */
  clear(): void {
    this.byName.clear();
    this.fileCount = 0;
    this.media = new WeakMap();
    for (const entry of this.cache.values()) releaseFrame(entry.frame);
    this.cache.clear();
    this.cacheBytes = 0;
    this.generation++;
    this.notify();
  }

  /** The located file best matching `path`, if any. */
  locate(path: string): Blob | undefined {
    const parts = split(path);
    const candidates = this.byName.get(parts[parts.length - 1] ?? "");
    if (!candidates) return undefined;
    let best: StoredFile | undefined;
    let bestScore = 0;
    for (const file of candidates) {
      let score = 0;
      while (score < file.parts.length && score < parts.length && file.parts[file.parts.length - 1 - score] === parts[parts.length - 1 - score]) score++;
      if (score > bestScore) {
        best = file;
        bestScore = score;
      }
    }
    return best?.blob;
  }

  /** Whether the item's file has been located (always true for solids, never for placeholders). */
  isLocated(item: FootageItem): boolean {
    const source = item.mainSource;
    if (source.sourceType === "SolidSource") return true;
    if (source.sourceType === "PlaceholderSource") return false;
    return !!this.mediaOf(item)?.blob;
  }

  /**
   * Frame `index` of the item: a sequence's frame number counted from its first
   * file, a video's frame at its native rate, 0 for a still.
   */
  frame(item: FootageItem, index: number): FrameState {
    const media = this.mediaOf(item);
    if (!media || !media.blob) return { status: "missing", path: media?.path ?? item.name };
    if (media.error) return { status: "error", message: media.error };
    if (media.kind === "video") return this.videoFrame(item, media, index);
    if (media.kind === "image") index = 0;
    const key = `${media.id}:${index}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.touch(key, cached);
      return { status: "ready", frame: cached.frame };
    }
    const failure = media.failed.get(index);
    if (failure) return { status: "error", message: failure };
    let blob: Blob | null | undefined = media.blob;
    if (media.kind === "sequence") {
      blob = media.frames.get(index);
      if (blob === undefined) {
        const source = item.mainSource;
        const sequence = source.sourceType === "FileSource" ? source.sequence : undefined;
        const folder = media.path.replace(/[\\/][^\\/]*$/, "");
        const name = sequence ? sequenceFrameName(sequence, sequence.startFrame + index) : "";
        blob = name ? (this.locate(`${folder}/${name}`) ?? null) : null;
        media.frames.set(index, blob);
      }
      if (!blob) return { status: "missing", path: media.path };
    }
    if (!media.requested.has(index)) {
      media.requested.add(index);
      const file = blob;
      this.track(
        decodeImage(file).then(
          (frame) => this.put(key, frame),
          (e: Error) => media.failed.set(index, e.message || "cannot decode the file"),
        ).finally(() => media.requested.delete(index)),
      );
    }
    return { status: "pending" };
  }

  /** The item's decoded audio; the first call starts decoding and reports "pending". */
  audio(item: FootageItem): AudioState {
    const registered = registeredAudio(item.id);
    if (registered) return { status: "ready", audio: registered };
    const media = this.mediaOf(item);
    if (!media || !media.blob) return { status: "missing", path: media?.path ?? item.name };
    if (media.audio) return { status: "ready", audio: media.audio };
    if (media.audioError) return { status: "error", message: media.audioError };
    if (!media.audioDecoding) {
      media.audioDecoding = true;
      const blob = media.blob;
      this.track(
        blob
          .arrayBuffer()
          .then((bytes) => decodeAudio(new Uint8Array(bytes)))
          .then(
            (audio) => (media.audio = audio),
            (e: Error) => (media.audioError = e.message || "cannot decode the audio"),
          )
          .finally(() => (media.audioDecoding = false)),
      );
    }
    return { status: "pending" };
  }

  /** Calls `listener` (debounced to a microtask) whenever files are added or frames arrive. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once no decoding is in flight. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** Whether decoding is in flight. */
  get busy(): boolean {
    return this.inflight.size > 0;
  }

  private mediaOf(item: FootageItem): ItemMedia | undefined {
    const source = item.mainSource;
    if (source.sourceType !== "FileSource") return undefined;
    let media = this.media.get(item);
    if (media && !media.blob && media.generation !== this.generation) media = undefined;
    if (media?.kind === "sequence" && media.generation !== this.generation) {
      for (const [index, blob] of media.frames) if (!blob) media.frames.delete(index);
      media.generation = this.generation;
    }
    if (!media) {
      const path = source.file || source.relativePath || source.fileName;
      const extension = (source.fileName.split(".").pop() ?? "").toLowerCase();
      const kind = source.sequence ? "sequence" : !source.isStill && VIDEO_EXTENSIONS.has(extension) ? "video" : "image";
      media = {
        id: this.nextId++,
        generation: this.generation,
        kind,
        path,
        blob: this.locate(path) ?? (source.relativePath ? this.locate(source.relativePath) : undefined),
        frames: new Map(),
        requested: new Set(),
        failed: new Map(),
      };
      if (media.blob && kind === "sequence") media.frames.set(0, media.blob);
      this.media.set(item, media);
    }
    return media;
  }

  private videoFrame(item: FootageItem, media: ItemMedia, index: number): FrameState {
    if (!media.video) {
      if (!media.opening) {
        media.opening = true;
        const source = item.mainSource;
        const rate = (source.sourceType === "FileSource" && source.nativeFrameRate) || item.frameRate || 30;
        this.track(
          openVideo(media.blob!, rate).then(
            (reader) => (media.video = reader),
            (e: Error) => (media.error = e.message || "cannot decode the video"),
          ).finally(() => {
            media.opening = false;
            this.notify();
          }),
        );
      }
      return { status: "pending" };
    }
    const source = item.mainSource;
    const rate = (source.sourceType === "FileSource" && source.nativeFrameRate) || item.frameRate || 30;
    const sample = media.video.indexAt(index / rate);
    const key = `${media.id}:${sample}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.touch(key, cached);
      return { status: "ready", frame: cached.frame };
    }
    const failure = media.failed.get(sample);
    if (failure) return { status: "error", message: failure };
    if (!media.requested.has(sample)) {
      media.requested.add(sample);
      this.track(
        media.video
          .decode(sample, (p, frame) => this.put(`${media.id}:${p}`, frame))
          .then(
            () => {
              if (!this.cache.has(key)) media.failed.set(sample, "the decoder returned no picture for this frame");
            },
            (e: Error) => media.failed.set(sample, e.message || "cannot decode the video"),
          )
          .finally(() => media.requested.delete(sample)),
      );
    }
    return { status: "pending" };
  }

  private put(key: string, frame: FootageFrame): void {
    const old = this.cache.get(key);
    if (old) {
      this.cache.delete(key);
      this.cacheBytes -= old.bytes;
      if (old.frame !== frame) releaseFrame(old.frame);
    }
    const bytes = frameBytes(frame);
    this.cache.set(key, { frame, bytes });
    this.cacheBytes += bytes;
    for (const [k, entry] of this.cache) {
      if (this.cacheBytes <= CACHE_BYTES || k === key) break;
      this.cache.delete(k);
      this.cacheBytes -= entry.bytes;
      releaseFrame(entry.frame);
    }
  }

  private touch(key: string, entry: { frame: FootageFrame; bytes: number }): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.finally(() => {
      this.inflight.delete(tracked);
      this.notify();
    });
    this.inflight.add(tracked);
  }

  private notify(): void {
    this.changes++;
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const listener of [...this.listeners]) listener();
    });
  }
}

export const footageStore = new FootageStore();
