// Which workspace the window gets. Phones and small tablets (narrow, or short in landscape) get the compact one: the
// viewer over one panel at a time, menus as bottom sheets. Larger screens keep the docked desktop frames.
import { useSyncExternalStore } from "react";

export const COMPACT_QUERY = "(max-width: 900px), (max-height: 560px)";
/** Compact screens wider than tall put the panel beside the viewer instead of under it. */
export const LANDSCAPE_QUERY = "(orientation: landscape)";

const media = (query: string): MediaQueryList | undefined =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : undefined;

/** Whether the media query matches, following changes (rotation, resizing). False where there is no matchMedia. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = media(query);
      list?.addEventListener("change", onChange);
      return () => list?.removeEventListener("change", onChange);
    },
    () => media(query)?.matches ?? false,
    () => false,
  );
}

export const useCompact = (): boolean => useMedia(COMPACT_QUERY);

export { isMobileOS } from "../device.ts";
