import { useEffect, useRef } from "react";
import type { CompItem, Project } from "../aep/model.ts";
import { audioPreview } from "../media/audioPreview.ts";
import { pendingDone, workInFlight } from "../media/pending.ts";
import { footageStore } from "../media/store.ts";
import { spectraOffThread } from "../render/effects/spectrumPrefetch.ts";
import { frameDuration } from "./clock.ts";
import { playhead } from "./playhead.ts";
import { contentGeneration, playbackStats } from "./ramCache.ts";
import { autoFactor, fastPreviews, getViewer, viewerFactors, viewerStats, viewerZooms } from "./viewer.ts";

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

/**
 * The slot due `elapsed` seconds after slot `origin` was shown. Slots count from `begin`, so seconds map to slots
 * by the step alone, across passes.
 */
export function dueSlot(span: PlaybackSpan, origin: number, elapsed: number): number {
  return origin + Math.max(0, Math.floor(elapsed / span.step + 1e-6));
}

/** Time per animation frame that showing and rendering ahead may take, leaving the rest to the browser. */
const FRAME_BUDGET_MS = 11;
/** Frames rendered into the RAM cache ahead of the playhead at most. */
const AHEAD = 30;
/** Frames rendered ahead per animation frame at most. */
const AHEAD_PER_FRAME = 2;
/**
 * Renders the GPU may have queued at once. The time budget only sees the CPU side of a render; without this cap
 * playback queues more GPU work than the GPU gets through, the browser's own drawing waits behind it and the page
 * stops getting animation frames. Two keep the GPU busy between animation frames.
 */
const GPU_QUEUE = 2;
/**
 * Fast Previews: GPU time per frame above which playback lowers its resolution, so it keeps 30 frames per second
 * with room for decoding and the page; and the lowest resolution it goes to (Quarter).
 */
const ADAPTIVE_MS = 26;
const ADAPTIVE_LIMIT = 4;
/** Renders measured at a resolution before Fast Previews judges it (the first ones fill the layer caches). */
const ADAPTIVE_SAMPLES = 6;
/** The same before the clock starts, when a wrong guess costs nothing but the wait (the first is left out). */
const PREROLL_SAMPLES = 4;
/** Frames after the one rendering next whose movie frames are asked for. */
const FOOTAGE_AHEAD = 4;
/** Seconds from drawing a frame to the display showing it (a refresh at 60 Hz). */
const SCREEN_DELAY_S = 1 / 60;

/** The resolution divisor Fast Previews settled on per comp, kept for the next playback while nothing changes. */
const adapted = new Map<number, { factor: number; generation: number }>();
/** Frames rendered ahead before the clock starts, so playback does not open by dropping frames. */
const PREROLL = 4;
/** Longest the preroll waits for those frames before starting anyway. */
const PREROLL_MS = 400;
/** Longest the audio clock may take to start running before playback goes on by the wall clock. */
const AUDIO_START_MS = 300;
/**
 * Time without a new frame after which playback stops the clock and the audio to wait for footage. Shorter
 * holds (a movie decoding a little late, a slow frame) keep the sound going and drop frames instead.
 */
const STALL_MS = 600;
/** How often the playback figures in the Info panel update. */
const STATS_MS = 250;

/**
 * What a frame that rendered incomplete waits for: the work it found in progress (footage decoding, spectra
 * computing), or, when that is not known (a movie still opening, audio decoding), any change in the footage store.
 */
type Gate = { keys: string[] } | { version: number };

function gateOf(waiting: string[] | null): Gate {
  return waiting?.length ? { keys: waiting } : { version: footageStore.version };
}

function gateOpen(gate: Gate): boolean {
  return "keys" in gate ? pendingDone(gate.keys) : footageStore.version !== gate.version;
}

/**
 * Plays `comp` from `time` while `playing`, as the Preview panel's settings say, in the comp's viewer:
 *
 * - playback prerolls: the first frame and a few after it are rendered before the clock and the audio start;
 * - the clock is the audio device's while the preview sound plays (the picture follows the sound), else the
 *   wall clock;
 * - each shown frame comes from the RAM cache or is rendered when its slot comes; a frame whose footage is still
 *   decoding is never shown: the newest complete frame up to the slot is shown instead, or the picture holds,
 *   and the sound goes on. Only when no new frame could be shown for STALL_MS do the clock and the audio stop,
 *   to go on together once footage arrives;
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
    playhead.start(comp.id, startAt);
    // The viewer's resolution, or with Fast Previews no finer than the viewer shows the comp nor than it settled on.
    let factor = viewerFactors.get(comp.id);
    if (fastPreviews.adaptive) {
      const kept = adapted.get(comp.id);
      factor = Math.max(factor, autoFactor(viewerZooms.get(comp.id)), kept?.generation === contentGeneration() ? kept.factor : 1);
    }
    getViewer(comp.id)?.resetGpuTiming();

    /** Prerolling (clock stopped), waiting for the audio clock to run, or playing. */
    let phase: "preroll" | "audio" | "running" = "preroll";
    let phaseSince = performance.now();
    /** First slot not shown yet. */
    let next = 0;
    /** The slot shown when the clock started, its wall time, and the comp time the audio started from. */
    let origin = 0;
    let originWall = 0;
    let audioFrom: number | null = null;
    let pass = -1;
    let lastNew = 0;
    /** The frame rendering ahead stopped at, until the footage it waits for has decoded. */
    let blocked: { frame: number; gate: Gate } | null = null;
    /** The furthest slot rendered ahead at the current resolution. */
    let aheadTo = -1;
    /** The slot the clock is at, while it runs. */
    let due = 0;
    let renderMs = 0;
    let dropped = 0;
    let statsAt = 0;
    const shownTimes: number[] = [];
    let raf = 0;

    const stopAudio = () => {
      if (audioFrom === null) return;
      audioPreview.stop();
      audioFrom = null;
    };

    const publish = (now: number) => {
      if (now - statsAt < STATS_MS) return;
      statsAt = now;
      while (shownTimes.length && shownTimes[0] < now - 1000) shownTimes.shift();
      const fps = shownTimes.length > 1 ? ((shownTimes.length - 1) * 1000) / (shownTimes[shownTimes.length - 1] - shownTimes[0]) : 0;
      const waiting = phase !== "running";
      playbackStats.set({ playing: true, fps: Math.round(fps * 10) / 10, realTime: dropped === 0 && !waiting, renderMs: Math.round(renderMs), dropped, waiting });
      dropped = 0;
    };

    /** Whether a frame blocked on footage may be rendered again. */
    const unblocked = (frame: number) => !blocked || blocked.frame !== frame || gateOpen(blocked.gate);

    /**
     * Shows slot `k`'s frame if it is in the RAM cache or, with `render`, if it renders complete now (or
     * partially, when nothing is decoding that would complete it).
     */
    const tryShow = (k: number, render: boolean): boolean => {
      const slot = slotTime(span, k);
      const viewer = getViewer(comp.id);
      if (!slot) return false;
      if (!viewer) return true;
      const frame = frameOf(slot.time);
      if (viewer.cached(frame)) {
        viewer.show(frame);
        return true;
      }
      if (!render || !unblocked(frame)) return false;
      const shown = viewer.show(frame);
      if (shown === "rendered") renderMs = viewer.lastRenderMs;
      if (shown !== "waiting") return true;
      // With nothing in progress, nothing will complete it.
      if (!workInFlight()) {
        viewer.show(frame, true);
        return true;
      }
      blocked = { frame, gate: gateOf(viewer.lastWaiting) };
      return false;
    };

    const shown = (k: number, now: number) => {
      const slot = slotTime(span, k)!;
      dropped += Math.max(0, k - next);
      next = k + 1;
      lastNew = now;
      shownTimes.push(now);
      playhead.set(frameOf(slot.time) * fd);
    };

    const startClock = (now: number) => {
      origin = next - 1;
      originWall = now;
      lastNew = now;
      phase = "running";
      phaseSince = now;
    };

    const startAudio = (k: number) => {
      const slot = slotTime(span, k);
      if (!settings.audio || !slot) return;
      audioFrom = frameOf(slot.time) * fd;
      audioPreview.play(project, comp, audioFrom, span.end);
    };

    /**
     * Renders the next frames into the RAM cache: from the first not shown, or, while the clock runs, from the
     * slot that will be due when the GPU gets through the render (frames before it would be late, so they are
     * dropped). While the GPU's queue has room, at least one per animation frame and more while the time budget
     * lasts; stops at a frame whose footage is still decoding until that arrives.
     */
    const renderAhead = (now: number) => {
      const viewer = getViewer(comp.id);
      if (!viewer) return;
      const lead = phase === "running" ? Math.ceil(((viewer.gpuQueue() + 1) * viewer.gpuMs) / (span.step * 1000)) : 0;
      // Targets only move forwards, so movies decode forwards instead of seeking back as the estimate wavers.
      const first = phase === "running" ? Math.max(next, due + 1 + lead, aheadTo + 1) : next;
      let rendered = 0;
      for (let j = first; j < first + AHEAD && rendered < AHEAD_PER_FRAME; j++) {
        const slot = slotTime(span, j);
        if (!slot) break;
        const frame = frameOf(slot.time);
        if (viewer.cached(frame)) continue;
        if (!unblocked(frame)) break;
        // Before the clock starts, one render at a time: the first ones at a resolution fill the caches and are slow.
        if (viewer.gpuQueue() >= (phase === "preroll" ? 1 : GPU_QUEUE)) {
          viewerStats.aheadGpuFull++;
          break;
        }
        if (rendered > 0 && performance.now() - now + (viewer.lastRenderMs || span.step * 1000) > FRAME_BUDGET_MS) break;
        // A frame renders once its movie frames have decoded (a render without them would be thrown away); the
        // next frames' are asked for meanwhile, in order, so the decoders keep going forwards.
        const footage = viewer.requestFootage(frame);
        for (let n = 1; n <= FOOTAGE_AHEAD; n++) {
          const later = slotTime(span, j + n);
          if (later) viewer.requestFootage(frameOf(later.time));
        }
        if (!footage.ready) {
          viewerStats.aheadFootage++;
          blocked = { frame, gate: gateOf(footage.waiting) };
          break;
        }
        rendered++;
        aheadTo = j;
        if (viewer.prefetch(frame)) {
          renderMs = viewer.lastRenderMs;
          continue;
        }
        blocked = { frame, gate: gateOf(viewer.lastWaiting) };
        break;
      }
    };

    /**
     * Fast Previews: a lower resolution once the GPU has shown it cannot keep up with this one. While prerolling it
     * judges sooner, so playback starts (and the sound with it) at the resolution it can keep.
     */
    const adapt = (now: number) => {
      const viewer = getViewer(comp.id);
      if (!viewer || !fastPreviews.adaptive || factor >= ADAPTIVE_LIMIT) return;
      viewer.gpuQueue();
      const needed = phase === "preroll" ? PREROLL_SAMPLES : ADAPTIVE_SAMPLES;
      const typical = viewer.gpuTypicalMs();
      if (viewer.gpuSamples < needed || typical <= ADAPTIVE_MS) return;
      // GPU time goes about with the pixels rendered: straight to the resolution expected to keep up.
      const from = factor;
      factor++;
      while (factor < ADAPTIVE_LIMIT && typical * (from / factor) ** 2 > ADAPTIVE_MS) factor++;
      adapted.set(comp.id, { factor, generation: contentGeneration() });
      viewer.attach(project, comp, factor);
      viewer.resetGpuTiming();
      blocked = null;
      aheadTo = -1;
      if (phase === "preroll") phaseSince = now;
    };

    /** Frames ready ahead of `next`, up to `count`. */
    const readyAhead = (count: number) => {
      const viewer = getViewer(comp.id);
      if (!viewer) return count;
      let n = 0;
      for (let j = next; j < next + count; j++) {
        const slot = slotTime(span, j);
        if (!slot || !viewer.cached(frameOf(slot.time))) break;
        n++;
      }
      return n;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      getViewer(comp.id)?.attach(project, comp, factor);

      if (phase === "preroll") {
        if (next === origin || pass < 0) {
          // The frame to start from: shown complete before anything moves.
          if (!slotTime(span, next)) {
            cancelAnimationFrame(raf);
            ended.current(frameOf(span.end - fd) * fd);
            return;
          }
          if (tryShow(next, true)) {
            pass = slotTime(span, next)!.pass;
            shown(next, now);
            phaseSince = now;
          }
        } else if (readyAhead(PREROLL) >= PREROLL || now - phaseSince >= PREROLL_MS) {
          startAudio(next - 1);
          phase = audioFrom === null ? "running" : "audio";
          phaseSince = now;
          if (phase === "running") startClock(now);
        }
      } else if (phase === "audio") {
        if (audioPreview.position() !== null || now - phaseSince >= AUDIO_START_MS) startClock(now);
      } else {
        const heard = audioFrom === null ? null : audioPreview.position();
        // Seconds since the origin slot was shown, by the sound when it plays.
        const elapsed = heard !== null ? heard - audioFrom! : (now - originWall) / 1000;
        if (heard !== null) originWall = now - elapsed * 1000;
        // What is drawn now reaches the screen at the next display refresh: the frame due then.
        due = dueSlot(span, origin, elapsed + SCREEN_DELAY_S);
        if (due >= next) {
          const slot = slotTime(span, due);
          if (!slot) {
            cancelAnimationFrame(raf);
            stopAudio();
            ended.current(frameOf(span.end - fd) * fd);
            return;
          }
          if (slot.pass !== pass) {
            // Each pass over the range starts the sound again from the range's start.
            pass = slot.pass;
            if (tryShow(due, true)) shown(due, now);
            else next = due;
            stopAudio();
            startAudio(due);
            origin = due;
            originWall = now;
          } else {
            // The newest frame up to the due one that rendering ahead has ready.
            for (let j = due; j >= Math.max(next, due - AHEAD); j--) {
              if (tryShow(j, false)) {
                shown(j, now);
                break;
              }
            }
          }
          if (now - lastNew > STALL_MS) {
            // Footage cannot keep up at all: wait for it with the clock and the sound stopped.
            stopAudio();
            next = due;
            origin = due;
            pass = -1;
            phase = "preroll";
            phaseSince = now;
          }
        }
      }
      renderAhead(now);
      adapt(now);
      publish(now);
    };
    playbackStats.set({ playing: true, fps: 0, realTime: true, dropped: 0, waiting: false });
    // Frames whose Audio Spectrum the workers have not computed yet wait for it like footage.
    const onThread = spectraOffThread();
    raf = requestAnimationFrame(tick);
    return () => {
      onThread();
      cancelAnimationFrame(raf);
      stopAudio();
      from.current = playhead.get()?.time ?? from.current;
      playhead.stop();
      playbackStats.set({ playing: false, waiting: false });
    };
  }, [playing, project, comp, settings]);
}
