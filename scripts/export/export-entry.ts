// Browser entry for scripts/export-report.ts. It renders reference frames with
// a fresh Renderer, runs real Render Queue items into memory, decodes the
// encoded samples that the Node side demuxed (VideoDecoder), and plays the
// files in a <video> element. Large results go back to Node as POST uploads.
import type { CompItem, Project } from "../../src/aep/model.ts";
import { parseProject } from "../../src/aep/parse.ts";
import { codecCandidates } from "../../src/export/codecs.ts";
import { memorySink } from "../../src/export/pipeline.ts";
import { RenderQueue, type ItemStatus } from "../../src/export/queue.ts";
import { framePlan, type OutputModule, type RenderSettings } from "../../src/export/settings.ts";
import { audioLevelsDb } from "../../src/media/audioPreview.ts";
import { footageStore } from "../../src/media/store.ts";
import { Renderer } from "../../src/render/renderer.ts";

let project: Project | undefined;
const outputs = new Map<string, Uint8Array>();

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function upload(key: string, bytes: Uint8Array): Promise<void> {
  const response = await fetch(`/upload/${encodeURIComponent(key)}`, { method: "POST", body: bytes as Uint8Array<ArrayBuffer> });
  if (!response.ok) throw new Error(`upload ${key} failed: ${response.status}`);
}

function compNamed(name: string): CompItem {
  if (!project) throw new Error("load a project first");
  const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name);
  if (!comp) throw new Error(`no composition named ${name}`);
  return comp;
}

interface Sample {
  offset: number;
  size: number;
  timestamp: number;
  duration: number;
  key: boolean;
}

const api = {
  load(base64: string): void {
    project = parseProject(decodeBase64(base64));
  },

  /** Locates a footage file by name, as dropping it on the app does. */
  addFile(name: string, base64: string): void {
    footageStore.addFiles([{ path: name, blob: new Blob([decodeBase64(base64) as Uint8Array<ArrayBuffer>]) }]);
  },

  /** The comp's layers with their timing, switches and source file name. */
  layers(compName: string) {
    return compNamed(compName).layers.map((l) => {
      const source = project!.items.get(l.sourceId);
      return {
        index: l.index,
        name: l.name,
        startTime: l.startTime,
        inPoint: l.inPoint,
        outPoint: l.outPoint,
        stretch: l.stretch,
        audioEnabled: l.audioEnabled,
        solo: l.solo,
        file: source?.kind === "footage" && source.mainSource.sourceType === "FileSource" ? source.mainSource.file : null,
        hasAudio: source?.kind === "footage" ? source.hasAudio : false,
      };
    });
  },

  /** Moves a layer in time (start, in and out points) by `seconds`. */
  shiftLayer(compName: string, index: number, seconds: number): void {
    const layer = compNamed(compName).layers.find((l) => l.index === index);
    if (!layer) throw new Error(`no layer ${index}`);
    layer.startTime += seconds;
    layer.inPoint += seconds;
    layer.outPoint += seconds;
  },

  /** A layer's Audio Levels in dB at the given times. */
  audioLevels(compName: string, index: number, times: number[]): number[] {
    const layer = compNamed(compName).layers.find((l) => l.index === index);
    if (!layer) throw new Error(`no layer ${index}`);
    return times.map((t) => audioLevelsDb(layer, t));
  },

  /** Decodes an exported file's audio track with Web Audio at 48 kHz and uploads each channel as float32. */
  async decodeAudio(key: string) {
    const bytes = outputs.get(key);
    if (!bytes) throw new Error(`no output ${key}`);
    try {
      const buffer = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(bytes.slice().buffer);
      for (let c = 0; c < buffer.numberOfChannels; c++) await upload(`${key}/audio/${c}`, new Uint8Array(buffer.getChannelData(c).slice().buffer));
      return { sampleRate: buffer.sampleRate, length: buffer.length, channels: buffer.numberOfChannels, duration: buffer.duration };
    } catch (e) {
      return { error: (e as Error).message || String(e) };
    }
  },

  /** isConfigSupported for encode (both acceleration preferences) and decode of the codecs worth knowing about. */
  async probe(width: number, height: number, fps: number) {
    const configs: [string, string, Record<string, unknown>][] = [
      ...codecCandidates("h264", width, height, fps).map((c) => [`H.264 ${c}`, c, { avc: { format: "avc" } }] as [string, string, Record<string, unknown>]),
      ...codecCandidates("vp9", width, height, fps).map((c) => [`VP9 ${c}`, c, {}] as [string, string, Record<string, unknown>]),
      ["VP9 with alpha:keep", "vp09.00.10.08", { alpha: "keep" }],
      ["VP8", "vp8", {}],
      ["VP8 with alpha:keep", "vp8", { alpha: "keep" }],
      ["AV1 main 8-bit", "av01.0.08M.08", {}],
      ["HEVC main", "hev1.1.6.L120.90", {}],
    ];
    const rows = [];
    for (const [label, codec, extra] of configs) {
      const row: Record<string, string | boolean> = { label };
      for (const hardwareAcceleration of ["prefer-software", "prefer-hardware"] as const) {
        try {
          const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 4e6, framerate: fps, hardwareAcceleration, ...extra } as VideoEncoderConfig);
          row[`encode ${hardwareAcceleration}`] = !!r.supported;
        } catch (e) {
          row[`encode ${hardwareAcceleration}`] = `error: ${(e as Error).message}`;
        }
      }
      try {
        const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: width, codedHeight: height });
        row.decode = !!r.supported;
      } catch (e) {
        row.decode = `error: ${(e as Error).message}`;
      }
      rows.push(row);
    }
    return { userAgent: navigator.userAgent, secure: isSecureContext, rows };
  },

  /** Renders the frames of a render setting with a fresh renderer and cleared caches per frame; uploads straight RGBA. */
  async reference(key: string, compName: string, settings: RenderSettings) {
    const comp = compNamed(compName);
    const plan = framePlan(comp, settings);
    const renderer = new Renderer(new OffscreenCanvas(1, 1));
    const times: number[] = [];
    for (let i = 0; i < plan.frames; i++) {
      renderer.clearCaches();
      const t = plan.time(i);
      times.push(t);
      const target = renderer.render(project!, comp, t, { scale: plan.scale });
      const rgba = renderer.readPixels(target, plan.width, plan.height);
      renderer.release(target);
      await upload(`${key}/ref/${i}`, rgba);
    }
    (renderer.gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
    return { frames: plan.frames, width: plan.width, height: plan.height, fps: plan.fps, times, bgColor: comp.bgColor, frameRate: comp.frameRate };
  },

  /** Renders one Render Queue item into memory; `stopAfter` presses Stop once that many frames are done. */
  async exportItem(key: string, compName: string, settings: RenderSettings, output: OutputModule, stopAfter?: number) {
    const comp = compNamed(compName);
    const queue = new RenderQueue();
    let sinkClosed = false;
    let sinkAborted = false;
    let written = 0;
    const sink = memorySink();
    queue.openSink = async () => ({
      write: (b) => {
        written += b.length;
        return sink.write(b);
      },
      close: async () => {
        sinkClosed = true;
      },
      abort: async () => {
        sinkAborted = true;
      },
    });
    const item = queue.add(project!, comp);
    queue.setSettings(item.id, settings);
    queue.setOutput(item.id, output);
    const statuses: ItemStatus[] = [queue.getSnapshot().items[0].status];
    let maxFrame = 0;
    let progressEvents = 0;
    queue.subscribe(() => {
      const snap = queue.getSnapshot();
      const it = snap.items[0];
      if (it.status !== statuses[statuses.length - 1]) statuses.push(it.status);
      if (snap.current) {
        progressEvents++;
        maxFrame = Math.max(maxFrame, snap.current.frame);
        if (stopAfter !== undefined && snap.current.frame >= stopAfter) queue.stop();
      }
    });
    const started = performance.now();
    await queue.render();
    const ms = performance.now() - started;
    const final = queue.getSnapshot().items[0];
    const bytes = sink.bytes();
    if (sinkClosed && !sinkAborted) {
      outputs.set(key, bytes);
      await upload(`${key}/out`, bytes);
    }
    return {
      statuses,
      status: final.status,
      error: final.error,
      frame: final.frame,
      frames: final.frames,
      fileName: final.fileName,
      bytes: written,
      sinkClosed,
      sinkAborted,
      maxFrame,
      progressEvents,
      ms,
      log: final.log,
      audioCodec: final.audioCodec ?? null,
      idle: queue.getSnapshot().current === null,
    };
  },

  /** Decodes demuxed samples of an exported file with VideoDecoder and uploads each picture's planes. */
  async decode(key: string, codec: string, description: number[] | null, samples: Sample[], prefix: string) {
    const bytes = outputs.get(key);
    if (!bytes) throw new Error(`no output ${key}`);
    const pictures: { format: string | null; width: number; height: number; timestamp: number; layout: PlaneLayout[]; colorSpace: VideoColorSpaceInit }[] = [];
    const uploads: Promise<void>[] = [];
    let failure: Error | null = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        const width = frame.visibleRect!.width;
        const height = frame.visibleRect!.height;
        const size = frame.allocationSize();
        const data = new Uint8Array(size);
        const index = pictures.length;
        pictures.push({ format: frame.format, width, height, timestamp: frame.timestamp, layout: [], colorSpace: frame.colorSpace.toJSON() });
        uploads.push(
          frame.copyTo(data).then((layout) => {
            pictures[index].layout = layout;
            frame.close();
            return upload(`${prefix}/${index}`, data);
          }),
        );
      },
      error: (e) => {
        failure = e instanceof Error ? e : new Error(String(e));
      },
    });
    const config: VideoDecoderConfig = { codec, hardwareAcceleration: "prefer-software", ...(description ? { description: Uint8Array.from(description) } : {}) };
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error(`decoder does not support ${codec}`);
    decoder.configure(config);
    for (const s of samples) {
      decoder.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: s.timestamp, duration: s.duration, data: bytes.subarray(s.offset, s.offset + s.size) }));
    }
    await decoder.flush();
    decoder.close();
    await Promise.all(uploads);
    if (failure) throw failure;
    return pictures;
  },

  /** Plays an exported file in a <video> element and uploads the RGBA of each frame, seeking to frame centres. */
  async video(key: string, mime: string, frames: number, fps: number) {
    const bytes = outputs.get(key);
    if (!bytes) throw new Error(`no output ${key}`);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
    const event = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const ok = () => {
          video.removeEventListener("error", bad);
          resolve();
        };
        const bad = () => {
          video.removeEventListener(name, ok);
          reject(new Error(`video error ${video.error?.code}: ${video.error?.message}`));
        };
        video.addEventListener(name, ok, { once: true });
        video.addEventListener("error", bad, { once: true });
      });
    try {
      const loaded = event("loadeddata");
      video.src = url;
      await loaded;
      const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
      const ctx = canvas.getContext("2d")!;
      for (let i = 0; i < frames; i++) {
        const seeked = event("seeked");
        video.currentTime = (i + 0.5) / fps;
        await seeked;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0);
        await upload(`${key}/video/${i}`, new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer));
      }
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    } catch (e) {
      return { error: (e as Error).message };
    } finally {
      URL.revokeObjectURL(url);
    }
  },
};

(globalThis as unknown as { aepExport: typeof api }).aepExport = api;
