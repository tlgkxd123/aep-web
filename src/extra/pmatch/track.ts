// Links per-frame detections (detect.ts) into particle tracks: each live track
// predicts its next position from its velocity, takes the nearest detection inside
// a gate that grows with its speed (particles speed up on the beat), and survives a
// few missed frames. A new track's first step is predicted from a prior: outward
// from the emitter at the speed typical for its distance, when one is known.
import { D_BACK, D_FLUX, D_MAXRES, D_PEAK, D_SPREAD, D_X, D_Y, DETECTION_FLOATS } from "./detect.ts";

export interface FrameDetections {
  index: number;
  data: Float32Array;
}

/** Splits a detection stream (per frame: index, count, detections) into frames. */
export function splitFrames(stream: Float32Array): FrameDetections[] {
  const out: FrameDetections[] = [];
  for (let at = 0; at + 2 <= stream.length; ) {
    const n = stream[at + 1];
    out.push({ index: stream[at], data: stream.subarray(at + 2, at + 2 + n * DETECTION_FLOATS) });
    at += 2 + n * DETECTION_FLOATS;
  }
  return out;
}

export interface TrackPoint {
  frame: number;
  x: number;
  y: number;
  flux: number;
  peak: number;
  spread: number;
  /** White residual over the largest channel residual: 1 for white light. */
  whiteness: number;
  /** Brightest wide structure near the particle (0..1). */
  back: number;
}

export interface Track {
  id: number;
  points: TrackPoint[];
}

export interface Prior {
  center: [number, number];
  /** Typical outward speed (px per frame) at distance r from the center. */
  speedAt(r: number): number;
}

export interface TrackerOptions {
  /** Frames a track may miss before it ends. */
  maxGap: number;
  /** Gate radius: base px plus this share of the predicted step. */
  gateBase: number;
  gateShare: number;
  /** Gate radius for a track's second point. */
  startGate: number;
  /** Detections that may join tracks. */
  accept?: (d: Float32Array, at: number) => boolean;
}

export const DEFAULT_TRACKER: TrackerOptions = { maxGap: 2, gateBase: 2.5, gateShare: 0.6, startGate: 8 };

/** Least peak (white residual) of a detection that counts as a particle. */
export const MIN_PEAK = 14 / 255;

/** Detections that count as particles: bright enough and close to white. */
export function particleDetection(d: Float32Array, at: number): boolean {
  return d[at + D_PEAK] >= MIN_PEAK && d[at + D_PEAK] / Math.max(1e-6, d[at + D_MAXRES]) >= 0.5;
}

interface Live {
  track: Track;
  last: TrackPoint;
  vx: number;
  vy: number;
  hasVelocity: boolean;
  missed: number;
}

const CELL = 16;

export function track(frames: FrameDetections[], options: TrackerOptions = DEFAULT_TRACKER, prior?: Prior): Track[] {
  const done: Track[] = [];
  let live: Live[] = [];
  let nextId = 1;
  let previousIndex = -Infinity;
  for (const frame of frames) {
    const d = frame.data;
    const count = d.length / DETECTION_FLOATS;
    const gap = frame.index - previousIndex;
    previousIndex = frame.index;
    if (gap > options.maxGap + 1) {
      done.push(...live.map((l) => l.track));
      live = [];
    }
    // Grid of accepted detections.
    const grid = new Map<number, number[]>();
    const used = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const at = i * DETECTION_FLOATS;
      if (options.accept && !options.accept(d, at)) {
        used[i] = 1;
        continue;
      }
      const key = Math.floor(d[at + D_X] / CELL) * 65536 + Math.floor(d[at + D_Y] / CELL);
      const list = grid.get(key);
      if (list) list.push(i);
      else grid.set(key, [i]);
    }
    const near = (x: number, y: number, r: number, visit: (i: number) => void) => {
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
        for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
          const list = grid.get(cx * 65536 + cy);
          if (list) for (const i of list) visit(i);
        }
      }
    };
    // Candidate links, cheapest first.
    const links: [number, number, number][] = [];
    live.forEach((l, li) => {
      const steps = frame.index - l.last.frame;
      let px = l.last.x;
      let py = l.last.y;
      let vx = l.vx;
      let vy = l.vy;
      let gate: number;
      if (l.hasVelocity) {
        gate = options.gateBase + options.gateShare * Math.hypot(vx, vy) * steps;
      } else if (prior) {
        const dx = px - prior.center[0];
        const dy = py - prior.center[1];
        const r = Math.hypot(dx, dy) || 1;
        const s = prior.speedAt(r);
        vx = (dx / r) * s;
        vy = (dy / r) * s;
        gate = options.startGate + options.gateShare * s * steps;
      } else {
        vx = vy = 0;
        gate = options.startGate * steps;
      }
      px += vx * steps;
      py += vy * steps;
      near(px, py, gate, (i) => {
        const at = i * DETECTION_FLOATS;
        const dist = Math.hypot(d[at + D_X] - px, d[at + D_Y] - py);
        if (dist > gate) return;
        // Light changes slowly along a track.
        const ratio = Math.abs(Math.log((d[at + D_FLUX] + 1e-3) / (l.last.flux + 1e-3)));
        links.push([dist / gate + 0.25 * ratio, li, i]);
      });
    });
    links.sort((a, b) => a[0] - b[0]);
    const taken = new Uint8Array(live.length);
    for (const [, li, i] of links) {
      if (taken[li] || used[i]) continue;
      taken[li] = 1;
      used[i] = 1;
      const l = live[li];
      const at = i * DETECTION_FLOATS;
      const point = pointOf(d, at, frame.index);
      const steps = frame.index - l.last.frame;
      const nvx = (point.x - l.last.x) / steps;
      const nvy = (point.y - l.last.y) / steps;
      // Velocity follows new steps quickly: the beat changes it within a few frames.
      if (l.hasVelocity) {
        l.vx += 0.6 * (nvx - l.vx);
        l.vy += 0.6 * (nvy - l.vy);
      } else {
        l.vx = nvx;
        l.vy = nvy;
        l.hasVelocity = true;
      }
      l.track.points.push(point);
      l.last = point;
      l.missed = 0;
    }
    const next: Live[] = [];
    live.forEach((l, li) => {
      if (!taken[li]) l.missed++;
      if (l.missed > options.maxGap) done.push(l.track);
      else next.push(l);
    });
    for (let i = 0; i < count; i++) {
      if (used[i]) continue;
      const point = pointOf(d, i * DETECTION_FLOATS, frame.index);
      next.push({ track: { id: nextId++, points: [point] }, last: point, vx: 0, vy: 0, hasVelocity: false, missed: 0 });
    }
    live = next;
  }
  done.push(...live.map((l) => l.track));
  return done.filter((t) => t.points.length > 1).sort((a, b) => a.id - b.id);
}

function pointOf(d: Float32Array, at: number, frame: number): TrackPoint {
  return {
    frame,
    x: d[at + D_X],
    y: d[at + D_Y],
    flux: d[at + D_FLUX],
    peak: d[at + D_PEAK],
    spread: d[at + D_SPREAD],
    whiteness: d[at + D_PEAK] / Math.max(1e-6, d[at + D_MAXRES]),
    back: d[at + D_BACK],
  };
}

/**
 * The point nearest to all tracks' lines of motion (least squares over perpendicular distances, weighted by
 * how far each track moved): where outward-flying particles come from.
 */
export function focusOfExpansion(tracks: Track[]): [number, number] | null {
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (const t of tracks) {
    const first = t.points[0];
    const last = t.points[t.points.length - 1];
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const length = Math.hypot(dx, dy);
    if (length < 4) continue;
    // Normal of the line through the track.
    const nx = -dy / length;
    const ny = dx / length;
    const w = Math.min(length, 100);
    const c = nx * first.x + ny * first.y;
    a11 += w * nx * nx;
    a12 += w * nx * ny;
    a22 += w * ny * ny;
    b1 += w * nx * c;
    b2 += w * ny * c;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-9) return null;
  return [(a22 * b1 - a12 * b2) / det, (a11 * b2 - a12 * b1) / det];
}
