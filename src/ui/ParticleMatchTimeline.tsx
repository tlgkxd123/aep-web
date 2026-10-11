// The Particle Match window's scrub strip: play/pause and the time, a track to scrub the reference on with
// its soundtrack's loudness, and the training window as a range with a handle at each end (dragged like the
// Timeline's work area; B and N set its ends at the playhead).
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BANDS, type AudioFeatures } from "../extra/pmatch/audio.ts";
import { Icon } from "./icons.tsx";

/** What the window plays: the reference video, or a free-running clock without one. */
export interface Transport {
  time(): number;
  playing(): boolean;
  seek(t: number): void;
  setPlaying(playing: boolean): void;
}

/** Plays a timeline of `duration` seconds in a loop, for a model previewed without its reference. */
export class FreeClock implements Transport {
  private readonly duration: number;
  private origin = 0;
  private paused = 0;
  private running = false;

  constructor(duration: number) {
    this.duration = duration;
  }

  time(): number {
    return this.running ? ((performance.now() - this.origin) / 1000) % this.duration : this.paused;
  }

  playing(): boolean {
    return this.running;
  }

  seek(t: number): void {
    if (this.running) this.origin = performance.now() - t * 1000;
    else this.paused = t;
  }

  setPlaying(playing: boolean): void {
    if (playing === this.running) return;
    if (playing) this.origin = performance.now() - this.paused * 1000;
    else this.paused = this.time();
    this.running = playing;
  }
}

/** m:ss, or m:ss.s with `tenths`. */
export function clockText(seconds: number, tenths = false): string {
  const t = Math.max(0, tenths ? Math.round(seconds * 10) / 10 : Math.floor(seconds));
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${(tenths ? s.toFixed(1) : String(Math.floor(s))).padStart(tenths ? 4 : 2, "0")}`;
}

/** Loudness points drawn on the strip at most. */
const LOUDNESS_POINTS = 600;

/** How loud the soundtrack is over its length, 0–1 (the mean of its slow band envelopes, spread to its 5–95 % range). */
export function loudnessOf(features: AudioFeatures): Float32Array {
  const points = Math.max(2, Math.min(LOUDNESS_POINTS, features.frames));
  const out = new Float32Array(points);
  const per = features.frames / points;
  for (let p = 0; p < points; p++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.floor(p * per); k < Math.min(features.frames, Math.floor((p + 1) * per)); k++, n++) {
      for (let b = 0; b < BANDS; b++) sum += features.data[k * features.dims + BANDS + b];
    }
    out[p] = n ? sum / (n * BANDS) : 0;
  }
  const sorted = Float32Array.from(out).sort();
  const lo = sorted[Math.floor(0.05 * (points - 1))];
  const hi = sorted[Math.ceil(0.95 * (points - 1))];
  for (let p = 0; p < points; p++) out[p] = hi > lo ? Math.max(0, Math.min(1, (out[p] - lo) / (hi - lo))) : 0.5;
  return out;
}

function loudnessPath(values: Float32Array): string {
  const n = values.length;
  let d = `M0 1`;
  for (let i = 0; i < n; i++) d += `L${((i + 0.5) / n).toFixed(4)} ${(1 - 0.12 - 0.8 * values[i]).toFixed(3)}`;
  return `${d}L1 1Z`;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const snap = (t: number) => Math.round(t * 10) / 10;

type Drag = { kind: "seek" } | { kind: "from" } | { kind: "to" } | { kind: "move"; grab: number; from: number; to: number; x: number; moved: boolean };

export interface TimelineProps {
  transport: Transport;
  duration: number;
  /** The training window in seconds; its handles drag when `onRange` is given. */
  range?: { from: number; to: number } | null;
  onRange?: (from: number, to: number) => void;
  /** Shortest training window, seconds. */
  minRange: number;
  loudness?: Float32Array | null;
  disabled?: boolean;
}

export function ParticleMatchTimeline({ transport, duration, range, onRange, minRange, loudness, disabled }: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [playing, setPlaying] = useState(false);
  const length = Math.max(duration, 1e-6);

  // The playhead follows the transport every frame without re-rendering the window.
  useEffect(() => {
    let shown = NaN;
    let wasPlaying = false;
    let frame = requestAnimationFrame(function tick() {
      const t = transport.time();
      if (t !== shown) {
        shown = t;
        const text = clockText(t, true);
        if (headRef.current) headRef.current.style.left = `${(100 * clamp(t, 0, length)) / length}%`;
        if (timeRef.current) timeRef.current.textContent = text;
        trackRef.current?.setAttribute("aria-valuenow", t.toFixed(1));
        trackRef.current?.setAttribute("aria-valuetext", text);
      }
      const now = transport.playing();
      if (now !== wasPlaying) setPlaying((wasPlaying = now));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [transport, length]);

  const timeAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * duration;
  };

  const setRange = (from: number, to: number) => onRange?.(Math.max(0, snap(from)), Math.min(duration, snap(to)));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    const part = (e.target as HTMLElement).closest<HTMLElement>("[data-drag]")?.dataset.drag;
    const t = timeAt(e.clientX);
    let drag: Drag = { kind: "seek" };
    if (range && onRange && (part === "from" || part === "to")) drag = { kind: part };
    else if (range && onRange && part === "move") drag = { kind: "move", grab: t, from: range.from, to: range.to, x: e.clientX, moved: false };
    if (part === "from" || part === "to") e.preventDefault();
    dragRef.current = drag;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (drag.kind === "seek") transport.seek(t);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const t = timeAt(e.clientX);
    if (drag.kind === "seek") return transport.seek(t);
    if (!range) return;
    if (drag.kind === "from") return setRange(clamp(t, 0, range.to - minRange), range.to);
    if (drag.kind === "to") return setRange(range.from, clamp(t, range.from + minRange, duration));
    if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
    if (!drag.moved) return;
    const span = drag.to - drag.from;
    const from = clamp(drag.from + t - drag.grab, 0, Math.max(0, duration - span));
    setRange(from, from + span);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.kind === "move" && !drag.moved) transport.seek(timeAt(e.clientX));
  };

  const onTrackKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 5 : 1;
    const t = transport.time();
    const next = e.key === "ArrowLeft" ? t - step : e.key === "ArrowRight" ? t + step : e.key === "Home" ? 0 : e.key === "End" ? duration : null;
    if (next === null) return;
    e.preventDefault();
    transport.seek(clamp(next, 0, duration));
  };

  const onHandleKey = (end: "from" | "to") => (e: KeyboardEvent) => {
    if (!range || !onRange) return;
    const step = e.shiftKey ? 10 : 1;
    const value = range[end];
    const next = e.key === "ArrowLeft" ? value - step : e.key === "ArrowRight" ? value + step : e.key === "Home" ? -Infinity : e.key === "End" ? Infinity : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (end === "from") setRange(clamp(next, 0, range.to - minRange), range.to);
    else setRange(range.from, clamp(next, range.from + minRange, duration));
  };

  const pct = (t: number) => `${(100 * clamp(t, 0, length)) / length}%`;
  const editable = !!onRange && !disabled;

  return (
    <div className={`pm-strip ${disabled ? "disabled" : ""}`}>
      <div className="pm-transport">
        <button
          type="button"
          className="pm-play"
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          disabled={disabled}
          onClick={() => transport.setPlaying(!transport.playing())}
        >
          <Icon name={playing ? "pause" : "play"} size={14} />
        </button>
        <span className="pm-clock">
          <span ref={timeRef}>{clockText(0, true)}</span>
          <span className="dim"> / {clockText(duration, true)}</span>
        </span>
        {range && (
          <span className="pm-range-readout">
            Training window <b>{clockText(range.from, true)}</b> – <b>{clockText(range.to, true)}</b>
            <span className="dim"> ({(range.to - range.from).toFixed(range.to - range.from < 10 ? 1 : 0)} s)</span>
          </span>
        )}
      </div>
      <div
        ref={trackRef}
        className="pm-track"
        role="slider"
        aria-label="Current time"
        aria-valuemin={0}
        aria-valuemax={Number(duration.toFixed(1))}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (dragRef.current = null)}
        onKeyDown={onTrackKey}
      >
        {loudness && (
          <svg className="pm-loudness" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
            <path d={loudnessPath(loudness)} />
          </svg>
        )}
        {range && (
          <div className={`pm-range ${editable ? "editable" : ""}`} style={{ left: pct(range.from), width: `calc(${pct(range.to)} - ${pct(range.from)})` }} data-drag={editable ? "move" : undefined}>
            {editable &&
              (["from", "to"] as const).map((end) => (
                <div
                  key={end}
                  className={`pm-handle pm-handle-${end}`}
                  data-drag={end}
                  role="slider"
                  tabIndex={0}
                  aria-label={end === "from" ? "Training window start" : "Training window end"}
                  aria-valuemin={end === "from" ? 0 : Number((range.from + minRange).toFixed(1))}
                  aria-valuemax={end === "from" ? Number(Math.max(0, range.to - minRange).toFixed(1)) : Number(duration.toFixed(1))}
                  aria-valuenow={Number(range[end].toFixed(1))}
                  aria-valuetext={clockText(range[end], true)}
                  onKeyDown={onHandleKey(end)}
                />
              ))}
          </div>
        )}
        <div ref={headRef} className="pm-head" aria-hidden="true" />
      </div>
    </div>
  );
}
