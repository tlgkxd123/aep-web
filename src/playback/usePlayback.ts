import { useEffect, useRef } from "react";
import type { CompItem } from "../aep/model.ts";
import { frameDuration, frameIndex, lookAhead, PlaybackClock, workAreaFrames } from "./clock.ts";
import { playbackStats } from "./ramCache.ts";
import { getViewer } from "./viewer.ts";

/** Share of a frame slot that may go to rendering frames ahead of the playhead. */
const LOOK_AHEAD_SHARE = 0.75;

/**
 * Plays `comp` in real time while `playing`: loops over the work area at the comp frame rate, shows each due
 * frame in the comp's viewer (from the RAM cache when it is there), drops frames that miss their slot, spends
 * spare slot time rendering upcoming frames into the cache, and reports the current time through `onTime`.
 */
export function usePlayback(comp: CompItem | undefined, playing: boolean, time: number, onTime: (compId: number, time: number) => void): void {
  const startTime = useRef(time);
  startTime.current = playing ? startTime.current : time;
  const report = useRef(onTime);
  report.current = onTime;

  useEffect(() => {
    if (!playing || !comp || typeof requestAnimationFrame === "undefined") return;
    const span = workAreaFrames(comp);
    const current = frameIndex(comp, startTime.current);
    const clock = new PlaybackClock(comp.frameRate || 1 / frameDuration(comp), span, current >= span.start && current < span.end ? current : span.start, performance.now());
    const slotMs = 1000 / clock.fps;
    let renderMs = 0;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const viewer = getViewer(comp.id);
      if (clock.due(now)) {
        const frame = clock.frameAt(now);
        try {
          const ms = viewer?.show(frame) ?? 0;
          if (ms) renderMs = ms;
        } catch {
          // The viewer reports render errors when it next draws on its own.
        }
        const shown = performance.now();
        clock.present(now, shown);
        report.current(comp.id, frame * frameDuration(comp));
        playbackStats.set({
          playing: true,
          fps: Math.round(clock.measuredFps(shown) * 10) / 10,
          realTime: clock.realTime(shown),
          renderMs: Math.round(renderMs),
          dropped: clock.dropped,
        });
      }
      if (viewer) {
        for (const f of lookAhead(clock.frameAt(now), span, 4, (f) => viewer.cached(f))) {
          const estimate = viewer.lastRenderMs || slotMs;
          if (performance.now() - now + estimate > slotMs * LOOK_AHEAD_SHARE) break;
          try {
            viewer.prefetch(f);
          } catch {
            break;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    playbackStats.set({ playing: true, fps: 0, realTime: true, dropped: 0 });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      playbackStats.set({ playing: false });
    };
  }, [playing, comp]);
}
