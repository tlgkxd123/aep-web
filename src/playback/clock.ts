import type { CompItem } from "../aep/model.ts";

/** Playback span in frame indices, [start, end). */
export interface FrameSpan {
  start: number;
  end: number;
}

export function frameDuration(comp: CompItem): number {
  return comp.frameDuration || 1 / (comp.frameRate || 24);
}

export function frameIndex(comp: CompItem, time: number): number {
  return Math.round(time / frameDuration(comp));
}

/** The work area as frames, clamped to the comp; at least one frame long. */
export function workAreaFrames(comp: CompItem): FrameSpan {
  const fd = frameDuration(comp);
  const last = Math.max(1, Math.round(comp.duration / fd));
  const start = Math.min(last - 1, Math.max(0, Math.round(comp.workAreaStart / fd)));
  const end = Math.min(last, Math.max(start + 1, Math.round((comp.workAreaStart + comp.workAreaDuration) / fd)));
  return { start, end };
}

/**
 * Real-time playback clock: the frame on screen follows wall time at the comp frame rate and loops over a span.
 * When a frame takes longer than its slot to show, the frames whose slots passed are dropped, not delayed.
 */
export class PlaybackClock {
  readonly fps: number;
  readonly span: FrameSpan;
  private readonly startWall: number;
  private readonly offset: number;
  private lastTick = -1;
  private readonly shown: number[] = [];
  private readonly drops: { at: number; count: number }[] = [];
  /** Frames presented and dropped since playback started. */
  presented = 0;
  dropped = 0;

  constructor(fps: number, span: FrameSpan, startFrame: number, now: number) {
    this.fps = fps;
    this.span = span;
    this.startWall = now;
    const length = Math.max(1, span.end - span.start);
    this.offset = (((startFrame - span.start) % length) + length) % length;
  }

  private ticks(now: number): number {
    return Math.floor(((now - this.startWall) / 1000) * this.fps + 1e-6);
  }

  /** The frame due at wall time `now`. */
  frameAt(now: number): number {
    const length = Math.max(1, this.span.end - this.span.start);
    return this.span.start + ((this.offset + Math.max(0, this.ticks(now))) % length);
  }

  /** Whether a frame slot has begun since the last presented frame. */
  due(now: number): boolean {
    return this.ticks(now) !== this.lastTick;
  }

  /**
   * Records that the frame due in the slot of `dueAt` reached the screen at `now`. Slots that passed between
   * the previous presented frame and this one count as dropped.
   */
  present(dueAt: number, now = dueAt): void {
    const tick = Math.max(0, this.ticks(dueAt));
    if (this.lastTick >= 0 && tick > this.lastTick + 1) {
      const count = tick - this.lastTick - 1;
      this.dropped += count;
      this.drops.push({ at: now, count });
    }
    this.lastTick = Math.max(this.lastTick, tick);
    this.presented++;
    this.shown.push(now);
    this.trim(now);
  }

  /** Forgets presentations and drops older than one second. */
  private trim(now: number): void {
    while (this.shown.length && this.shown[0] < now - 1000) this.shown.shift();
    while (this.drops.length && this.drops[0].at < now - 1000) this.drops.shift();
  }

  /** Frames presented per second over the last second. */
  measuredFps(now: number): number {
    this.trim(now);
    if (this.shown.length < 2) return 0;
    const span = (this.shown[this.shown.length - 1] - this.shown[0]) / 1000;
    return span > 0 ? (this.shown.length - 1) / span : 0;
  }

  /** False when any frame was dropped in the last second: AE's Non-real-time. */
  realTime(now: number): boolean {
    this.trim(now);
    return this.drops.length === 0;
  }

  /** Frames dropped in the last second. */
  recentDrops(now: number): number {
    this.trim(now);
    return this.drops.reduce((n, d) => n + d.count, 0);
  }
}

/** Up to `limit` frames after `frame` in playback order (wrapping over the span) that are not cached yet. */
export function lookAhead(frame: number, span: FrameSpan, limit: number, cached: (frame: number) => boolean): number[] {
  const length = Math.max(1, span.end - span.start);
  const out: number[] = [];
  for (let k = 1; k < length && out.length < limit; k++) {
    const f = span.start + ((((frame - span.start + k) % length) + length) % length);
    if (!cached(f)) out.push(f);
  }
  return out;
}
