// The browser's stand-in for the disk: files the user picked (or the harness
// added), matched to footage items the way After Effects relinks — the most
// trailing path components in common, the file name at least — and decoded on
// demand. Decoding is asynchronous; the renderer asks for frames synchronously,
// gets "pending" the first time and is told to render again when they arrive.
import type { FootageItem } from "../aep/model.ts";
import { sequenceFrameName } from "../aep/footage.ts";
import { deviceBudgets } from "../device.ts";
import { decodeAudio, registeredAudio, type AudioData } from "./audio.ts";
import { frameBytes, releaseFrame, type FootageFrame } from "./frames.ts";
import { audioTrackRate } from "./mp4.ts";
import { decodePsd, isPsd } from "./psd.ts";
import { decodeTiff, isTiff } from "./tiff.ts";
import { openVideo } from "./openVideo.ts";
import { notePending, registerPendingSource } from "./pending.ts";
import { videoStats, type VideoReader } from "./video.ts";

export type FrameState =
  | { status: "ready"; frame: FootageFrame }
  /** Decoding; `fallback` is the item's nearest decoded frame, to hold on screen meanwhile. */
  | { status: "pending"; fallback?: FootageFrame }
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
  /** The first decoder opened; its sample table serves every decoder of the file. */
  video?: VideoReader;
  /** Open decoders, with the sample each was last asked for (-1: none yet) and the requests renders wait on. */
  decoders: Decoder[];
  /** How many decoders the browser allowed, once it refused one more. */
  decoderLimit?: number;
  /** Decoding-ahead runs not yet waited on, by the sample each was started for. */
  readAheads: Map<number, Promise<unknown>>;
  opening?: boolean;
  error?: string;
  /** Sequence frames located so far, by frame index. */
  frames: Map<number, Blob | null>;
  requested: Set<number>;
  failed: Map<number, string>;
  audio?: AudioData;
  audioDecoding?: boolean;
  audioError?: string;
  /** Whether the movie file has a sound track (read from its header). */
  soundTrack?: boolean;
  soundScan?: boolean;
  /** The movie sample asked for last and how far apart forward requests have been lately (time remapping). */
  lastSample: number;
  stride: number;
}

interface Decoder {
  reader: VideoReader;
  at: number;
  used: number;
  busy: number;
}

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "qt", "3gp", "webm", "mkv", "avi", "mxf"]);
/**
 * Requested frames are kept out of eviction until the renderer takes them, so a video's lookahead cannot push
 * out the frame it was decoded for. Bounded, oldest first, for requests nobody comes back for.
 */
const MAX_PINNED = 16;
/** Movie frames kept decoded ahead of the one shown. */
const READ_AHEAD = 8;
/** How quickly the expected spacing of a movie's requests follows the latest one. */
const STRIDE_FOLLOW = 0.3;
/** Decoders per movie, for layers showing it at different times. */
const MAX_DECODERS = 3;
/** How far ahead of its last sample a decoder still takes a request rather than another one starting fresh. */
const NEAR_SAMPLES = 90;
/** How far behind its last sample (where decoding ahead left it) a decoder still takes a request. */
const BEHIND_SAMPLES = 2 * READ_AHEAD;

/** Frames of a sequence listed at most, against frame ranges a damaged project reports. */
const MAX_SEQUENCE = 1_000_000;

/** The footage store's prefix among the sources of work renders wait for (pending.ts). */
const PENDING = "footage";

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
  /** Bytes of decoded frames kept at most, beyond the pinned ones. */
  private budget: number;
  private readonly pinned = new Set<string>();
  /** Every open video reader, to close them (and their workers) with the files. */
  private readonly readers = new Set<VideoReader>();
  private uses = 0;
  /** Work counters, for profiling exports. */
  readonly stats = { imageDecodes: 0, imageMs: 0, videoRuns: 0, videoMs: 0, evictions: 0, decoder: videoStats };
  private readonly listeners = new Set<() => void>();
  private readonly inflight = new Set<Promise<unknown>>();
  private nextId = 1;
  private generation = 0;
  /** Frames that failed to decode, which renders need not wait for. */
  private readonly failedKeys = new Set<string>();
  private fileCount = 0;
  private notifyScheduled = false;
  private changes = 0;

  constructor(budget = deviceBudgets().footage) {
    this.budget = budget;
  }

  /** Changes how many bytes of decoded frames are kept, dropping the least recently used beyond it. */
  setBudget(bytes: number): void {
    this.budget = bytes;
    this.evict();
  }

  /**
   * Drops the decoded frames no render waits for; with `decoders`, also closes every open video decoder (and its
   * worker) and forgets decoded audio, which all come back when footage is asked for again. Located files stay.
   */
  releaseMemory(decoders: boolean): void {
    this.evict(0);
    if (decoders) {
      for (const reader of this.readers) reader.close();
      this.readers.clear();
      this.media = new WeakMap();
    }
    this.notify();
  }

  /** Number of files located so far. */
  get size(): number {
    return this.fileCount;
  }

  /** Increments whenever files are added or decoded frames arrive. */
  get version(): number {
    return this.changes;
  }

  /** Increments whenever files are added or forgotten, which changes what footage renders. */
  get filesVersion(): number {
    return this.generation;
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
    for (const reader of this.readers) reader.close();
    this.readers.clear();
    for (const entry of this.cache.values()) releaseFrame(entry.frame);
    this.cache.clear();
    this.pinned.clear();
    this.failedKeys.clear();
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

  /**
   * The located files of a file footage item, named as the item expects them: its file, or the located frames of a
   * sequence. Undefined when its file is not located.
   */
  sourceFiles(item: FootageItem): { name: string; blob: Blob }[] | undefined {
    const media = this.mediaOf(item);
    const source = item.mainSource;
    if (!media?.blob || source.sourceType !== "FileSource") return undefined;
    const sequence = source.sequence;
    if (media.kind !== "sequence" || !sequence) return [{ name: source.fileName || (split(media.path).pop() ?? item.name), blob: media.blob }];
    const folder = media.path.replace(/[\\/][^\\/]*$/, "");
    const files: { name: string; blob: Blob }[] = [];
    const last = sequence.endFrame >= sequence.startFrame && sequence.endFrame - sequence.startFrame < MAX_SEQUENCE ? sequence.endFrame : sequence.startFrame;
    for (let n = sequence.startFrame; n <= last; n++) {
      const name = sequenceFrameName(sequence, n);
      const blob = n === sequence.startFrame ? media.blob : this.locate(`${folder}/${name}`);
      if (blob) files.push({ name, blob });
    }
    return files;
  }

  /**
   * Swaps located files read from one Blob for another holding the same bytes, as when the file they were read from
   * has been written again (its old Blobs can no longer be read). Open decoders start again on the new Blobs.
   */
  rebind(blobs: ReadonlyMap<Blob, Blob>): void {
    let changed = false;
    for (const list of this.byName.values()) {
      for (const file of list) {
        const blob = blobs.get(file.blob);
        if (blob) {
          file.blob = blob;
          changed = true;
        }
      }
    }
    if (!changed) return;
    this.generation++;
    this.releaseMemory(true);
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
    if (cached) return this.ready(key, cached);
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
      this.pin(key);
      const file = blob;
      const started = performance.now();
      this.stats.imageDecodes++;
      this.track(
        decodeImage(file).then(
          (frame) => {
            this.stats.imageMs += performance.now() - started;
            this.put(key, frame);
          },
          (e: Error) => {
            this.pinned.delete(key);
            this.failedKeys.add(key);
            media.failed.set(index, e.message || "cannot decode the file");
          },
        ).finally(() => media.requested.delete(index)),
      );
    }
    return this.pending(media, index);
  }

  /** The item's decoded audio; the first call starts decoding and reports "pending". */
  /**
   * Whether footage has sound: its stored flag, or, for a movie saved with the
   * flag off (as earlier versions of this app replaced footage), a sound track in
   * the file itself. "pending" while the movie header is read.
   */
  hasAudio(item: FootageItem): boolean | "pending" {
    if (item.hasAudio) return true;
    const media = this.mediaOf(item);
    if (!media || media.kind !== "video" || !media.blob) return false;
    if (media.soundTrack !== undefined) return media.soundTrack;
    if (!media.soundScan) {
      media.soundScan = true;
      this.track(audioTrackRate(media.blob).then((rate) => (media.soundTrack = rate > 0), () => (media.soundTrack = false)));
    }
    notePending(PENDING);
    return "pending";
  }

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
    notePending(PENDING);
    return { status: "pending" };
  }

  /** Calls `listener` (debounced to a microtask) whenever files are added or frames arrive. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether a frame a render found decoding (see pending.ts) has decoded, or failed. */
  decoded(key: string): boolean {
    return this.cache.has(key) || this.failedKeys.has(key);
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
        decoders: [],
        readAheads: new Map(),
        requested: new Set(),
        failed: new Map(),
        lastSample: -1,
        stride: 1,
      };
      if (media.blob && kind === "sequence") media.frames.set(0, media.blob);
      this.media.set(item, media);
    }
    return media;
  }

  private videoFrame(item: FootageItem, media: ItemMedia, index: number): FrameState {
    const source = item.mainSource;
    const rate = (source.sourceType === "FileSource" && source.nativeFrameRate) || item.frameRate || 30;
    if (!media.video) {
      if (!media.opening) this.openDecoder(media, rate);
      notePending(PENDING);
      return { status: "pending" };
    }
    const sample = media.video.indexAt(index / rate);
    const gap = sample - media.lastSample;
    if (media.lastSample >= 0 && gap > 0 && gap <= NEAR_SAMPLES) media.stride += (gap - media.stride) * STRIDE_FOLLOW;
    if (gap !== 0) media.lastSample = sample;
    const key = `${media.id}:${sample}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.readAhead(media, sample, rate);
      return this.ready(key, cached);
    }
    const failure = media.failed.get(sample);
    if (failure) return { status: "error", message: failure };
    // Decoding ahead already asked for this frame: wait for it like any request, so the views render again and
    // exports hold the frame back until it is there.
    const ahead = media.readAheads.get(sample);
    if (ahead) {
      media.readAheads.delete(sample);
      this.track(ahead);
    }
    if (!media.requested.has(sample)) {
      const decoder = this.decoderFor(media, sample, rate);
      if (!decoder) return this.pending(media, sample);
      media.requested.add(sample);
      this.pin(key);
      const started = performance.now();
      this.stats.videoRuns++;
      let delivered = false;
      decoder.busy++;
      this.track(
        decoder.reader
          .decode(
            sample,
            (p, frame) => {
              if (p === sample) delivered = true;
              this.put(`${media.id}:${p}`, frame);
            },
            () => !this.cache.has(key),
          )
          .then(
            () => {
              this.stats.videoMs += performance.now() - started;
              if (!delivered && !this.cache.has(key)) {
                this.pinned.delete(key);
                this.failedKeys.add(key);
                media.failed.set(sample, "the decoder returned no picture for this frame");
              }
            },
            (e: Error) => {
              this.pinned.delete(key);
              this.failedKeys.add(key);
              media.failed.set(sample, e.message || "cannot decode the video");
            },
          )
          .finally(() => {
            decoder.busy--;
            media.requested.delete(sample);
          }),
      );
    }
    return this.pending(media, sample);
  }

  /**
   * Keeps decoding ahead of a movie frame being shown: when one of the next READ_AHEAD samples playback will
   * ask for is neither decoded nor requested, it is decoded now, so playback does not reach the end of what is
   * decoded and stall. A time-remapped movie shows every few samples: the ones expected are spaced by how far
   * apart the requests have been. Nothing waits on them until a render asks for that very frame (see
   * videoFrame); a request for a frame decoded on the way is skipped by the reader.
   */
  private readAhead(media: ItemMedia, sample: number, rate: number): void {
    const count = media.video!.frameCount;
    const step = Math.max(1, media.stride);
    for (let k = 1; k <= READ_AHEAD; k++) {
      const p = sample + Math.round(k * step);
      if (p >= count) return;
      const key = `${media.id}:${p}`;
      if (this.cache.has(key)) continue;
      if (media.requested.has(p)) return;
      const decoder = this.decoderFor(media, p, rate, true);
      if (!decoder) return;
      media.requested.add(p);
      const run = decoder.reader
        .decode(p, (q, frame) => this.put(`${media.id}:${q}`, frame), () => !this.cache.has(key))
        .catch(() => undefined)
        .finally(() => {
          media.requested.delete(p);
          media.readAheads.delete(p);
        });
      media.readAheads.set(p, run);
      return;
    }
  }

  private openDecoder(media: ItemMedia, rate: number): void {
    media.opening = true;
    this.track(
      openVideo(media.blob!, rate)
        .then(
          (reader) => {
            this.readers.add(reader);
            media.video ??= reader;
            media.decoders.push({ reader, at: -1, used: 0, busy: 0 });
          },
          (e: Error) => {
            if (!media.video) media.error = e.message || "cannot decode the video";
            // The browser would not open one more decoder: make do with the ones open instead of retrying.
            else media.decoderLimit = media.decoders.length;
          },
        )
        .finally(() => {
          media.opening = false;
          this.notify();
        }),
    );
  }

  /**
   * The decoder for a sample: the one positioned near it (up to NEAR_SAMPLES before it, or a little past it
   * after decoding ahead), else an unused one, else one no render is waiting on, which restarts there at once
   * (a jump of the playhead). Layers showing one movie at different times keep each other's decoders busy, so
   * each gets its own, up to MAX_DECODERS, instead of one decoder jumping between them and restarting from a
   * key frame each time. Undefined while that decoder opens. Decoding ahead never opens or takes over a
   * decoder and only moves a decoder's position forwards.
   */
  private decoderFor(media: ItemMedia, sample: number, rate: number, ahead = false): Decoder | undefined {
    const gap = (d: { at: number }) => sample - d.at;
    let pick: Decoder | undefined = media.decoders
      .filter((d) => d.at >= 0 && gap(d) >= -BEHIND_SAMPLES && gap(d) <= NEAR_SAMPLES)
      .sort((a, b) => Math.abs(gap(a)) - Math.abs(gap(b)))[0];
    pick ??= media.decoders.find((d) => d.at < 0);
    if (!pick && ahead) return undefined;
    pick ??= media.decoders.filter((d) => !d.busy).reduce<Decoder | undefined>((a, b) => (a && a.used <= b.used ? a : b), undefined);
    if (!pick && media.decoders.length < Math.min(MAX_DECODERS, media.decoderLimit ?? MAX_DECODERS)) {
      if (!media.opening) this.openDecoder(media, rate);
      return undefined;
    }
    pick ??= media.decoders.reduce((a, b) => (a.used <= b.used ? a : b));
    pick.at = ahead ? Math.max(pick.at, sample) : sample;
    pick.used = ++this.uses;
    return pick;
  }

  private ready(key: string, entry: { frame: FootageFrame; bytes: number }): FrameState {
    this.touch(key, entry);
    this.pinned.delete(key);
    return { status: "ready", frame: entry.frame };
  }

  /**
   * Pending, with the decoded frame of the same item nearest before `index` (else after it) to hold meanwhile.
   * Nearest by index rather than last shown: layers showing one movie at different times each keep their own.
   */
  private pending(media: ItemMedia, index: number): FrameState {
    const prefix = `${media.id}:`;
    notePending(PENDING, `${prefix}${index}`);
    let best: { distance: number; frame: FootageFrame } | undefined;
    for (const [key, entry] of this.cache) {
      if (!key.startsWith(prefix)) continue;
      const at = Number(key.slice(prefix.length));
      // Earlier frames first: playback moves forwards, so the previous frame is what was just on screen.
      const distance = at <= index ? index - at : at - index + 1e6;
      if (!best || distance < best.distance) best = { distance, frame: entry.frame };
    }
    return best ? { status: "pending", fallback: best.frame } : { status: "pending" };
  }

  private pin(key: string): void {
    this.pinned.delete(key);
    this.pinned.add(key);
    for (const k of this.pinned) {
      if (this.pinned.size <= MAX_PINNED) break;
      this.pinned.delete(k);
    }
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
    this.evict(this.budget, key);
  }

  /** Drops the least recently used frames, but the pinned ones and `keep`, until at most `budget` bytes stay. */
  private evict(budget = this.budget, keep?: string): void {
    for (const [k, entry] of this.cache) {
      if (this.cacheBytes <= budget) break;
      if (k === keep || this.pinned.has(k)) continue;
      this.stats.evictions++;
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
registerPendingSource(PENDING, { done: (key) => footageStore.decoded(key), busy: () => footageStore.busy });
