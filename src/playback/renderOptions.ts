// Renderer options shared by the app's viewers and its Render Queue, so a preview and its export render
// alike. Set from the View menu and kept between sessions. The pixel harness keeps the renderer's own
// defaults: After Effects as on the reference machine, without third-party plugins.
import { useSyncExternalStore } from "react";
import type { RendererOptions } from "../render/registry.ts";
import { invalidate } from "./ramCache.ts";

const SAPPHIRE_KEY = "aep-web.sapphireLookalikes";

function stored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export const appRenderOptions: RendererOptions = {
  approximateMissingPlugins: false,
  sapphireLookalikes: stored(SAPPHIRE_KEY) !== "off",
};

let version = 0;
const listeners = new Set<() => void>();

export function setSapphireLookalikes(on: boolean): void {
  if (appRenderOptions.sapphireLookalikes === on) return;
  appRenderOptions.sapphireLookalikes = on;
  try {
    globalThis.localStorage?.setItem(SAPPHIRE_KEY, on ? "on" : "off");
  } catch {
    // Not kept between sessions where storage is unavailable.
  }
  version++;
  invalidate();
  for (const l of listeners) l();
}

/** Changes whenever an option changes, for views to render again. */
export function useRenderOptionsVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}
