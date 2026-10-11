// Audio Spectrum's band magnitudes, cached by sound, window and settings, and computed ahead of playback in
// workers (spectrumWorker.ts). The effect takes the spectrum it draws now from the cache, computing it on this
// thread when no worker has, and asks for the next frames' spectra, which the workers compute meanwhile with the
// same code: their results are the same numbers.
import type { AudioData } from "../../media/audio.ts";
import { mixWindow, type LayerAudio } from "../../media/mixWindow.ts";
import { notePending, registerPendingSource } from "../../media/pending.ts";
import { analyse, analyseAveraged, windowLength, windowStart, type SpectrumSettings } from "./audioSpectrumAnalysis.ts";

interface JobContribution {
  id: number;
  scale: number;
  offset: number;
  from: number;
  to: number;
}

export interface SpectrumJob {
  key: string;
  contributions: JobContribution[];
  rate: number;
  timeScale: number;
  first: number;
  length: number;
  settings: SpectrumSettings;
  averaged: boolean;
}

export type SpectrumRequest =
  | { type: "audio"; id: number; sampleRate: number; channels: Float32Array[] }
  | { type: "forget"; id: number }
  | { type: "job"; job: SpectrumJob };

export type SpectrumReply = { type: "spectrum"; key: string; mags: Float32Array } | { type: "missing"; key: string };

/** Spectra kept: a few seconds of frames for a dozen instances. */
const MAX_SPECTRA = 4096;
/** Workers at most: each holds its own copy of the sounds it analyses. */
const MAX_WORKERS = 4;
/** This module's prefix among the sources of work renders wait for (pending.ts). */
const PENDING = "spectra";
/** Decoded sounds each worker holds a copy of at most. */
const MAX_SOUNDS = 3;
/** Jobs queued on one worker at most; more would compute frames playback has passed by the time they finish. */
const MAX_QUEUED = 48;

interface PoolWorker {
  worker: Worker;
  /** Sound ids the worker holds, least recently used first. */
  sounds: number[];
  queued: number;
}

const audioIds = new WeakMap<AudioData, number>();
let nextAudioId = 1;
function idOf(audio: AudioData): number {
  let id = audioIds.get(audio);
  if (id === undefined) audioIds.set(audio, (id = nextAudioId++));
  return id;
}

const spectra = new Map<string, Float32Array>();
const pending = new Set<string>();
/** Inputs of jobs whose results are checked against this thread's (spectrumStats.verify). */
const checks = new Map<string, { audio: LayerAudio; first: number; length: number; settings: SpectrumSettings; averaged: boolean }>();
let pool: PoolWorker[] | null | undefined;
let jobs = 0;

/** How spectra were obtained; with `verify` set, every fourth worker result is recomputed here and compared. */
export const spectrumStats = { computed: 0, late: 0, waited: 0, fromWorkers: 0, hits: 0, verified: 0, mismatches: 0, verify: false };

function remember(key: string, mags: Float32Array): void {
  spectra.set(key, mags);
  if (spectra.size > MAX_SPECTRA) spectra.delete(spectra.keys().next().value!);
}

function compute(audio: LayerAudio, first: number, length: number, settings: SpectrumSettings, averaged: boolean): Float32Array {
  return (averaged ? analyseAveraged : analyse)(mixWindow(audio, first, length), audio.rate, settings);
}

function windowOf(audio: LayerAudio, time: number, settings: SpectrumSettings) {
  const perSecond = audio.rate * audio.timeScale;
  const length = windowLength(perSecond, settings.durationMs);
  return { perSecond, length, first: windowStart(time, perSecond, length) };
}

function keyOf(audio: LayerAudio, perSecond: number, first: number, length: number, settings: SpectrumSettings, averaged: boolean): string {
  const sources = audio.contributions.map((c) => `${idOf(c.audio)}:${c.scale}:${c.offset}:${c.from}:${c.to}`).join("|");
  return `${perSecond}:${sources}#${first}:${length}:${settings.startFrequency}:${settings.endFrequency}:${settings.bands}:${averaged}`;
}

let offThread = 0;

/**
 * While the returned function has not been called, spectra are computed only by the workers: a render that
 * needs one they have not finished gets null and notes it as pending work (pending.ts), as playback renders
 * wait for footage. Otherwise (scrubbing, export, tests) a missing spectrum is computed at once.
 */
export function spectraOffThread(): () => void {
  offThread++;
  let released = false;
  return () => {
    if (!released) offThread--;
    released = true;
  };
}

/** Band magnitudes of the audio layer at comp time `time` (offset included); null while a worker computes them. */
export function spectrumAt(audio: LayerAudio, time: number, settings: SpectrumSettings, averaged: boolean): Float32Array | null {
  const { perSecond, length, first } = windowOf(audio, time, settings);
  const key = keyOf(audio, perSecond, first, length, settings, averaged);
  const cached = spectra.get(key);
  if (cached) {
    spectra.delete(key);
    spectra.set(key, cached);
    spectrumStats.hits++;
    return cached;
  }
  if (offThread > 0 && pool?.length) {
    if (!pending.has(key)) post(pool.reduce((a, b) => (b.queued < a.queued ? b : a)), audio, key, first, length, settings, averaged);
    if (pending.has(key)) {
      spectrumStats.waited++;
      notePending(PENDING, key);
      return null;
    }
  }
  const mags = compute(audio, first, length, settings, averaged);
  spectrumStats.computed++;
  if (pending.has(key)) spectrumStats.late++;
  remember(key, mags);
  return mags;
}

function receive(owner: PoolWorker, reply: SpectrumReply): void {
  owner.queued--;
  pending.delete(reply.key);
  if (reply.type !== "spectrum") return;
  spectrumStats.fromWorkers++;
  const check = checks.get(reply.key);
  if (check) {
    checks.delete(reply.key);
    const here = compute(check.audio, check.first, check.length, check.settings, check.averaged);
    spectrumStats.verified++;
    if (here.length !== reply.mags.length || here.some((v, i) => !Object.is(v, reply.mags[i]))) spectrumStats.mismatches++;
  }
  if (!spectra.has(reply.key)) remember(reply.key, reply.mags);
}

function startPool(): void {
  pool = null;
  if (typeof Worker === "undefined") return;
  void import("./spectrumWorker.ts?worker&inline").then(
    ({ default: SpectrumWorker }) => {
      const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4;
      const workers: PoolWorker[] = [];
      for (let i = 0; i < Math.max(1, Math.min(MAX_WORKERS, cores - 2)); i++) {
        const entry: PoolWorker = { worker: new SpectrumWorker(), sounds: [], queued: 0 };
        entry.worker.onmessage = (event: MessageEvent<SpectrumReply>) => receive(entry, event.data);
        workers.push(entry);
      }
      pool = workers;
    },
    () => undefined,
  );
}

function send(target: PoolWorker, message: SpectrumRequest, transfer: Transferable[] = []): void {
  target.worker.postMessage(message, transfer);
}

/** Queues the spectrum `key` on `target`. */
function post(target: PoolWorker, audio: LayerAudio, key: string, first: number, length: number, settings: SpectrumSettings, averaged: boolean): void {
  const contributions = audio.contributions.map((c) => ({ id: provide(target, c.audio), scale: c.scale, offset: c.offset, from: c.from, to: c.to }));
  const job: SpectrumJob = { key, contributions, rate: audio.rate, timeScale: audio.timeScale, first, length, settings: { ...settings }, averaged };
  if (spectrumStats.verify && jobs++ % 4 === 0) checks.set(key, { audio, first, length, settings: { ...settings }, averaged });
  pending.add(key);
  target.queued++;
  send(target, { type: "job", job });
}

/** Makes sure the worker holds `audio`, sending a copy of its samples the first time. */
function provide(target: PoolWorker, audio: AudioData): number {
  const id = idOf(audio);
  const at = target.sounds.indexOf(id);
  if (at >= 0) target.sounds.splice(at, 1);
  else {
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i).slice());
    send(target, { type: "audio", id, sampleRate: audio.sampleRate, channels }, channels.map((c) => c.buffer));
    while (target.sounds.length >= MAX_SOUNDS) send(target, { type: "forget", id: target.sounds.shift()! });
  }
  target.sounds.push(id);
  return id;
}

/** Starts computing the spectra at comp times `times` on the workers, unless they are cached or on their way. */
export function prefetchSpectra(audio: LayerAudio, times: number[], settings: SpectrumSettings, averaged: boolean): void {
  if (pool === undefined) startPool();
  if (!pool?.length) return;
  for (const time of times) {
    const { perSecond, length, first } = windowOf(audio, time, settings);
    const key = keyOf(audio, perSecond, first, length, settings, averaged);
    if (spectra.has(key) || pending.has(key)) continue;
    // Workers that already hold the sound first, then the least busy.
    const target = pool.reduce((best, w) => {
      const holds = (x: PoolWorker) => audio.contributions.every((c) => x.sounds.includes(idOf(c.audio)));
      if (holds(w) !== holds(best)) return holds(w) ? w : best;
      return w.queued < best.queued ? w : best;
    });
    if (target.queued >= MAX_QUEUED) return;
    post(target, audio, key, first, length, settings, averaged);
  }
}

registerPendingSource(PENDING, { done: (key) => spectra.has(key) || !pending.has(key), busy: () => pending.size > 0 });

// Dev server pages only: lets scripts/check-video-playback.ts check the workers' spectra.
if (typeof document !== "undefined" && document.querySelector('meta[name="aep-local-footage"]')) {
  (window as unknown as { aepSpectra: typeof spectrumStats }).aepSpectra = spectrumStats;
}
