import { useSyncExternalStore } from "react";

/** Pointer position over the composition viewer, in comp pixels, with the sampled colour (0–255). */
export interface HoverInfo {
  x: number;
  y: number;
  rgba: [number, number, number, number];
}

let current: HoverInfo | undefined;
const listeners = new Set<() => void>();

export function setHover(info: HoverInfo | undefined) {
  current = info;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useHover = () => useSyncExternalStore(subscribe, () => current);
