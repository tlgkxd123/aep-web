// The playhead while a composition plays. Playback moves it every frame without touching React state, so
// only the views that show the current time (time displays, the CTI) follow it; the app takes the time
// into its state when playback stops.
import { useSyncExternalStore } from "react";

interface Live {
  compId: number;
  time: number;
}

let live: Live | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export const playhead = {
  /** The playing comp and its time, or null when nothing plays. */
  get: (): Live | null => live,
  start(compId: number, time: number): void {
    live = { compId, time };
    notify();
  },
  set(time: number): void {
    if (!live || live.time === time) return;
    live = { compId: live.compId, time };
    notify();
  },
  /** Ends playback; returns where it was. */
  stop(): Live | null {
    const was = live;
    if (!was) return null;
    live = null;
    notify();
    return was;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** `time`, or the playhead's time while `compId` plays. */
export function useLiveTime(compId: number, time: number): number {
  return useSyncExternalStore(playhead.subscribe, () => (live?.compId === compId ? live.time : time));
}

/** Whether `compId` is playing. */
export function usePlaying(compId: number): boolean {
  return useSyncExternalStore(playhead.subscribe, () => live?.compId === compId);
}
