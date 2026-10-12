// The Android app's native Vulkan engine (native/, android/.../NativeEnginePlugin.java) from the page. With Composition
// > Preview Renderer > Vulkan, playback renders the RAM preview frames whose plan it supports (src/native/plan.ts)
// natively, as pending work (media/pending.ts) playback waits on as it waits on footage; the frames it cannot render
// yet, and every frame shown outside playback, stay the WebGL renderer's.
//
// Plans and frames cross as array buffers over the plugin's message channel (the aevkFrames object the app injects);
// in WebViews without one, plans go through the plugin bridge as base64 and frames come back as files.
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { CompItem, Project } from "../aep/model.ts";
import { registerPendingSource } from "../media/pending.ts";
import { buildFramePlan } from "./plan.ts";
import { encodePlan } from "./wire.ts";

/** What the app found out about the device's Vulkan engine. */
export interface NativeDevice {
  available: boolean;
  /** The GPU, as Vulkan names it. */
  device?: string;
  /** The Vulkan version the GPU supports. */
  vulkan?: string;
  /** A CPU implementation (SwiftShader, lavapipe), slower than the WebGL renderer. */
  software?: boolean;
  /** Why there is no engine. */
  reason?: string;
}

interface NativeEnginePlugin {
  probe(): Promise<NativeDevice>;
  render(options: { plan: string }): Promise<{ path: string; width: number; height: number }>;
}

/** Renders frame plans; the app's is the Android plugin. */
export interface NativeBackend {
  probe(): Promise<NativeDevice>;
  /** The frame of an encoded plan (wire.ts). */
  render(plan: Uint8Array): Promise<ImageBitmap>;
}

/** Base64 of bytes, as the plugin bridge carries them. */
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** The object NativeEnginePlugin injects into the page for frame requests (WebViewCompat.addWebMessageListener). */
export interface FrameChannel {
  postMessage(message: ArrayBuffer | string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/** Bytes after a frame's pixels in a channel reply: the request's id, the width and the height (u32, little-endian). */
const TRAILER = 12;
/** A frame not back after this long is given up on, so playback does not wait on it for good. */
const CHANNEL_TIMEOUT_MS = 15000;

/**
 * Renders over the plugin's message channel: a request is its id (u32, little-endian) and the plan; the reply is the
 * frame's straight RGBA, rows top first, and TRAILER, or {id, error} as JSON text.
 */
export function channelBackend(channel: FrameChannel, probe: () => Promise<NativeDevice>): NativeBackend {
  let last = 0;
  const waiting = new Map<number, { resolve: (frame: ArrayBuffer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const settle = (id: number) => {
    const entry = waiting.get(id);
    if (entry) clearTimeout(entry.timer);
    waiting.delete(id);
    return entry;
  };
  channel.addEventListener("message", ({ data }) => {
    if (typeof data === "string") {
      try {
        const { id, error } = JSON.parse(data) as { id: number; error: string };
        settle(id)?.reject(new Error(error));
      } catch {
        // Not a reply of ours.
      }
    } else if (data instanceof ArrayBuffer && data.byteLength >= TRAILER) {
      settle(new DataView(data, data.byteLength - TRAILER).getUint32(0, true))?.resolve(data);
    }
  });
  return {
    probe,
    async render(plan) {
      const id = (last = (last + 1) >>> 0);
      const request = new Uint8Array(4 + plan.length);
      new DataView(request.buffer).setUint32(0, id, true);
      request.set(plan, 4);
      const frame = await new Promise<ArrayBuffer>((resolve, reject) => {
        const timer = setTimeout(() => settle(id)?.reject(new Error("the frame did not come back")), CHANNEL_TIMEOUT_MS);
        waiting.set(id, { resolve, reject, timer });
        channel.postMessage(request.buffer);
      });
      const tail = new DataView(frame, frame.byteLength - TRAILER);
      const width = tail.getUint32(4, true);
      const height = tail.getUint32(8, true);
      if (width * height * 4 + TRAILER !== frame.byteLength) throw new Error(`a frame of ${width}x${height} came with ${frame.byteLength} bytes`);
      return createImageBitmap(new ImageData(new Uint8ClampedArray(frame, 0, width * height * 4), width, height));
    },
  };
}

/** The Android plugin: frames over its message channel where the WebView has one, else as files in the app's cache. */
export function capacitorBackend(): NativeBackend {
  const plugin = registerPlugin<NativeEnginePlugin>("NativeEngine");
  const probe = () => plugin.probe();
  const channel = (globalThis as { aevkFrames?: FrameChannel }).aevkFrames;
  if (channel && typeof channel.postMessage === "function" && typeof channel.addEventListener === "function") return channelBackend(channel, probe);
  return {
    probe,
    async render(plan) {
      const { path, width, height } = await plugin.render({ plan: toBase64(plan) });
      const response = await fetch(Capacitor.convertFileSrc(`file://${path}`));
      if (!response.ok) throw new Error(`the frame could not be read (${response.status})`);
      const rgba = new Uint8ClampedArray(await response.arrayBuffer());
      return createImageBitmap(new ImageData(rgba, width, height));
    },
  };
}

/** Where natively rendered frames go: the RAM preview cache. */
export interface FrameSink {
  put(view: string, frame: number, bitmap: ImageBitmap, bytes: number): void;
}

/** Native renders failing in a row after which the engine is left alone for the session. */
const MAX_FAILURES = 3;
/**
 * Renders handed to the engine at once: one rendering, one on its way back to the page and one waiting, so the engine
 * starts the next frame as soon as it hands one over.
 */
const MAX_IN_FLIGHT = 3;
const PENDING = "native";

/**
 * Renders RAM preview frames natively. A frame in flight is pending work under key `<view>:<frame>:<generation>`;
 * its bitmap goes to the sink unless the content changed meanwhile.
 */
export class NativeFrames {
  private device: Promise<NativeDevice> | undefined;
  private known: NativeDevice | undefined;
  private failures = 0;
  /** Keys of the renders in flight, with when each was handed to the engine. */
  private readonly inFlight = new Map<string, number>();
  /** About how long a frame takes from handing its plan over to having its bitmap, in milliseconds (0 before one). */
  latencyMs = 0;
  /** Views (at a content generation) with content the engine cannot render, and frames it failed on. */
  private readonly refused = new Set<string>();
  private refusedGeneration = -1;
  private readonly listeners = new Set<() => void>();
  /** Why the last frame was left to the WebGL renderer. */
  lastRefusal: string | undefined;
  enabled = false;
  private readonly backend: () => NativeBackend | undefined;
  private readonly sink: FrameSink;
  private readonly generation: () => number;

  /** `backend` is undefined where there is no engine (outside the Android app); `generation` counts content changes. */
  constructor(backend: () => NativeBackend | undefined, sink: FrameSink, generation: () => number) {
    this.backend = backend;
    this.sink = sink;
    this.generation = generation;
  }

  /** The device, probed once (on first use). */
  probe(): Promise<NativeDevice> {
    if (!this.device) {
      const backend = this.backend();
      this.device = (backend ? backend.probe() : Promise.resolve({ available: false, reason: "the Vulkan engine runs in the Android app" })).then(
        (device) => device,
        (e: Error) => ({ available: false, reason: e.message }),
      );
      void this.device.then((device) => {
        this.known = device;
        for (const l of this.listeners) l();
      });
    }
    return this.device;
  }

  /** The device once probed. */
  get status(): NativeDevice | undefined {
    return this.known;
  }

  /** Whether frames go to the engine: switched on, and the device has a working engine. */
  get active(): boolean {
    return this.enabled && !!this.known?.available && this.failures < MAX_FAILURES;
  }

  /** Whether `key` (from `prefetch`) is still rendering. */
  rendering(key: string): boolean {
    return this.inFlight.has(key);
  }

  get busy(): boolean {
    return this.inFlight.size > 0;
  }

  /** Whether frame `frame` of cache view `view` is rendering in the engine for the current content. */
  renderingFrame(view: string, frame: number): boolean {
    return this.inFlight.has(`${view}:${frame}:${this.generation()}`);
  }

  /**
   * Starts rendering `frame` of `comp` (cache view `view`) natively. Returns the pending entry to wait on (media/
   * pending.ts) while it or another frame renders, or undefined when the frame is the WebGL renderer's.
   */
  prefetch(project: Project, comp: CompItem, view: string, frame: number, time: number, scale: number): string | undefined {
    if (!this.active) return undefined;
    const generation = this.generation();
    if (generation !== this.refusedGeneration) {
      this.refused.clear();
      this.refusedGeneration = generation;
    }
    if (this.refused.has(view)) return undefined;
    const key = `${view}:${frame}:${generation}`;
    if (this.refused.has(key)) return undefined;
    if (!this.inFlight.has(key)) {
      if (this.inFlight.size >= MAX_IN_FLIGHT) return `${PENDING}\n${this.inFlight.keys().next().value}`;
      const plan = buildFramePlan(project, comp, time, { scale });
      if (plan.unsupported.length) {
        this.refused.add(view);
        this.lastRefusal = `left to WebGL: ${plan.unsupported.join("; ")}`;
        return undefined;
      }
      const started = performance.now();
      this.inFlight.set(key, started);
      this.backend()!
        .render(encodePlan(plan))
        .then(
          (bitmap) => {
            this.failures = 0;
            const took = performance.now() - started;
            this.latencyMs = this.latencyMs ? this.latencyMs + (took - this.latencyMs) * 0.3 : took;
            if (this.generation() === generation) this.sink.put(view, frame, bitmap, bitmap.width * bitmap.height * 4);
            else bitmap.close();
          },
          (e: Error) => {
            this.failures++;
            this.refused.add(key);
            this.lastRefusal = `the Vulkan engine failed: ${e.message}`;
          },
        )
        .finally(() => this.inFlight.delete(key));
    }
    return `${PENDING}\n${key}`;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lets subscribers know the setting changed. */
  changed(): void {
    for (const l of this.listeners) l();
  }
}

/** Registers `frames` as the source of the pending work its keys name. */
export function registerNativePending(frames: NativeFrames): void {
  registerPendingSource(PENDING, { done: (key) => !frames.rendering(key), busy: () => frames.busy });
}
