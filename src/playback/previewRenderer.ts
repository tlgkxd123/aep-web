// Composition > Preview Renderer: what renders the frames playback caches ahead, the WebGL renderer or, in the Android
// app, the native Vulkan engine (native/engine.ts) for the comps it can render.
import { Capacitor } from "@capacitor/core";
import { capacitorBackend, NativeFrames, registerNativePending, type NativeBackend } from "../native/engine.ts";
import { contentGeneration, ramCache } from "./ramCache.ts";

const KEY = "aep-web.previewRenderer";

let backend: NativeBackend | undefined;

/** The Vulkan engine's playback frames; switched off outside the Android app. */
export const nativeFrames = new NativeFrames(
  () => (Capacitor.isNativePlatform() ? (backend ??= capacitorBackend()) : undefined),
  ramCache,
  contentGeneration,
);
registerNativePending(nativeFrames);

try {
  if (Capacitor.isNativePlatform() && globalThis.localStorage?.getItem(KEY) === "vulkan") {
    nativeFrames.enabled = true;
    void nativeFrames.probe();
  }
} catch {
  // Starts with WebGL where storage is unavailable.
}

export const previewRenderer = {
  /** Whether Vulkan is chosen (it renders only once the device is found to have an engine). */
  get vulkan(): boolean {
    return nativeFrames.enabled;
  },
  set(vulkan: boolean): void {
    if (vulkan === nativeFrames.enabled) return;
    nativeFrames.enabled = vulkan;
    if (vulkan) void nativeFrames.probe();
    try {
      globalThis.localStorage?.setItem(KEY, vulkan ? "vulkan" : "webgl");
    } catch {
      // Not kept between sessions where storage is unavailable.
    }
    nativeFrames.changed();
  },
  subscribe: (listener: () => void): (() => void) => nativeFrames.subscribe(listener),
};
