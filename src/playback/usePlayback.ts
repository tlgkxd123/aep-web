import { useEffect, useRef } from "react";
import type { CompItem, Project } from "../aep/model.ts";
import { audioPreview } from "../media/audioPreview.ts";
import { footageStore } from "../media/store.ts";
import { frameDuration } from "./clock.ts";
import { playhead } from "./playhead.ts";
import { playbackStats } from "./ramCache.ts";
import { getViewer } from "./viewer.ts";

/** The Preview panel's playback options. */
export interface PreviewSettings {
  /** Work area, work area extended by the current time, or the whole comp. */
  range: "workArea" | "extended" | "comp";
  playFrom: "start" | "current";
  loop: boolean;
  audio: boolean;
  /** Frames per second shown; 0 = the comp's rate (Auto). */
  frameRate: number;
  /** Frames skipped between shown frames. */
  skip: number;
}

export const DEFAULT_PREVIEW: PreviewSettings = { range: "extended", playFrom: "start", loop: true, audio: true, frameRate: 0, skip: 0 };

/** The comp times playback shows: from `begin`, one every `step` seconds, over [start, end). */
export interface PlaybackSpan {
  start: number;
  end: number;
  begin: number;
  step: number;
  loop: boolean;
}

/** The span the Preview panel's Range, Play From, Frame Rate and Skip describe, with the playhead at `current`. */
export function playbackSpan(comp: CompItem, current: number, settings: PreviewSettings): PlaybackSpan {
  const frame = frameDuration(comp);
  let start = comp.workAreaStart;
  let end = Math.min(comp.duration, start + comp.workAreaDuration);
  if (settings.range === "comp") [start, end] = [0, comp.duration];
  else if (settings.range === "extended") [start, end] = [Math.min(start, current), Math.max(end, Math.min(comp.duration, current + frame))];
  end = Math.max(end, start + frame);
  const begin = settings.playFrom === "current" && current >= start && current < end ? current : start;
  const rate = settings.frameRate || comp.frameRate || 24;
  return { start, end, begin, step: (settings.skip + 1) / rate, loop: settings.loop };
}

/** The comp time of shown frame `k` and the pass over the range it is in; null past the end when not looping. */
export function slotTime(span: PlaybackSpan, k: number): { time: number; pass: number } | null {
  const length = span.end - span.start;
  const offset = span.begin - span.start + k * span.step;
  const pass = Math.floor(offset / length + 1e-9);
  if (!span.loop && pass > 0) return null;
  return { time: span.start + Math.max(0, offset - pass * length), pass };
}

/** Time per animation frame that showing and rendering ahead may take, leaving the rest to the browser. */
const FRAME_BUDGET_MS = 11;
/** Frames rendered into the RAM cache ahead of the playhead at most. */
const AHEAD = 30;
/**
 * Frames rendered ahead per animation frame at most. The time budget only sees the CPU side of a render; the GPU
 * works through it later, so rendering ahead without a cap can queue more GPU work than a frame has.
 */
const AHEAD_PER_FRAME = 2;
/** Smooth playback needed after waiting for footage before the audio comes back. */
const AUDIO_RESUME_MS = 500;
/** How often the playback figures in the Info panel update. */
const STATS_MS = 250;

/**
 * Plays `comp` from `time` while `playing`, as the Preview panel's settings say, in the comp's viewer:
 *
 * - each shown frame comes from the RAM cache or is rendered when its slot comes; frames whose slots passed
 *   while rendering are dropped, so playback keeps real time with its audio;
 * - a frame whose footage is still decoding is never shown: playback holds the frame on screen, stops the clock
 *   and the audio, and goes on from that frame once it is complete;
 * - time left in each animation frame renders the next frames into the RAM cache.
 *
 * The playhead moves through `playhead`, not React state; `onEnd` gets the last frame's time when a
 * non-looping preview ends.
 */
export function usePlayback(
  project: Project | undefined,
  comp: CompItem | undefined,
  playing: boolean,
  time: number,
  settings: PreviewSettings,
  onEnd: (time: number) => void,
): void {
  const from = useRef(time);
  if (!playing) from.current = time;
  const ended = useRef(onEnd);
  ended.current = onEnd;

  useEffect(() => {
    if (!playing || !project || !comp || typeof requestAnimationFrame === "undefined") return;
    const fd = frameDuration(comp);
    const lastFrame = Math.max(0, Math.round(comp.duration / fd) - 1);
    const frameOf = (t: number) => Math.min(lastFrame, Math.max(0, Math.floor(t / fd + 1e-6)));
    // Restarted by an edit or a settings change while playing: go on from where the playhead is.
    const live = playhead.get();
    const startAt = live?.compId === comp.id ? live.time : from.current;
    const span = playbackSpan(comp, startAt, settings);
    const slotMs = span.step * 1000;
    playhead.start(comp.id, startAt);

    let anchorWall = performance.now();
    let anchorSlot = 0;
    /** First slot not shown yet. */
    let next = 0;
    let pass = -1;
    /** Footage store version when the frame due (or the next one to render ahead) could not complete. */
    let waitingFor = -1;
    let aheadBlocked = -1;
    let audioOn = false;
    let smoothSince = -Infinity;
    let renderMs = 0;
    let dropped = 0;
    let statsAt = 0;
    const shownTimes: number[] = [];
    let raf = 0;

    const stopAudio = () => {
      if (!audioOn) return;
      audioPreview.stop();
      audioOn = false;
    };

    const publish = (now: number) => {
      if (now - statsAt < STATS_MS) return;
      statsAt = now;
      while (shownTimes.length && shownTimes[0] < now - 1000) shownTimes.shift();
      const fps = shownTimes.length > 1 ? ((shownTimes.length - 1) * 1000) / (shownTimes[shownTimes.length - 1] - shownTimes[0]) : 0;
      playbackStats.set({ playing: true, fps: Math.round(fps * 10) / 10, realTime: dropped === 0 && waitingFor < 0, renderMs: Math.round(renderMs), dropped, waiting: waitingFor >= 0 });
      dropped = 0;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const viewer = getViewer(comp.id);
      viewer?.attach(project, comp);
      const due = anchorSlot + Math.floor((now - anchorWall) / slotMs + 1e-6);
      if (due >= next) {
        // After a wait, the frame waited for comes next; otherwise frames whose slots passed are dropped.
        const k = waitingFor >= 0 ? next : due;
        const slot = slotTime(span, k);
        if (!slot) {
          cancelAnimationFrame(raf);
          ended.current(frameOf(span.end - fd) * fd);
          return;
        }
        const frame = frameOf(slot.time);
        let ready = true;
        if (viewer) {
          if (waitingFor >= 0 && footageStore.version === waitingFor) ready = false;
          else {
            const shown = viewer.show(frame);
            if (shown === "rendered") renderMs = viewer.lastRenderMs;
            if (shown === "waiting") {
              // With nothing decoding, nothing will complete it.
              if (footageStore.busy) ready = false;
              else viewer.show(frame, true);
            }
          }
        }
        if (!ready) {
          waitingFor = footageStore.version;
          next = k;
          anchorWall = now;
          anchorSlot = k;
          smoothSince = Infinity;
          stopAudio();
        } else {
          if (waitingFor >= 0) smoothSince = now;
          waitingFor = -1;
          dropped += k - next;
          next = k + 1;
          shownTimes.push(now);
          playhead.set(frame * fd);
          // Each pass over the range restarts the audio from where it is, as does smooth playback after a wait.
          if (settings.audio && (slot.pass !== pass || (!audioOn && now - smoothSince >= AUDIO_RESUME_MS))) {
            audioPreview.play(project, comp, frame * fd, span.end);
            audioOn = true;
          }
          pass = slot.pass;
        }
      }
      if (viewer && waitingFor < 0 && footageStore.version !== aheadBlocked) {
        aheadBlocked = -1;
        let rendered = 0;
        for (let j = next; j < next + AHEAD && rendered < AHEAD_PER_FRAME; j++) {
          const slot = slotTime(span, j);
          if (!slot) break;
          const frame = frameOf(slot.time);
          if (viewer.cached(frame)) continue;
          if (performance.now() - now + (viewer.lastRenderMs || slotMs) > FRAME_BUDGET_MS) break;
          rendered++;
          if (!viewer.prefetch(frame)) {
            aheadBlocked = footageStore.version;
            break;
          }
        }
      }
      publish(now);
    };
    playbackStats.set({ playing: true, fps: 0, realTime: true, dropped: 0, waiting: false });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      stopAudio();
      from.current = playhead.get()?.time ?? from.current;
      playhead.stop();
      playbackStats.set({ playing: false, waiting: false });
    };
  }, [playing, project, comp, settings]);
}
