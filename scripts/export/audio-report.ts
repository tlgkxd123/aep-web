// Audio checks of scripts/export-report.ts. A comp with an audible WAV layer is exported to MP4 (AAC) and
// WebM (Opus); the container must declare a 48 kHz stereo track of the video's duration, and the audio the
// browser decodes from the file must match a mix computed here, independently of the app: the WAV read in
// Node and placed by the layer's start time and in/out points, with its Audio Levels as gain.
//
// Tolerances, from what lossy coding at 160-192 kbps changes and what it must not:
// - alignment: the decoded audio's best cross-correlation lag against the expected mix is within 1 ms
//   (48 samples). AAC priming or a missing Opus pre-skip shift audio by 21-43 ms or 6.5 ms and fail this.
// - level: per 20 ms window with sound (expected RMS above -40 dBFS), RMS within 1 dB of the expected window.
//   Perceptual coders keep band energies to a fraction of a dB; a gain error or the wrong window fails it.
// - silence: windows the expected mix has silent (below -70 dBFS), 40 ms or more from sound, decode below
//   -50 dBFS, so audio that starts early or late (a dropped offset) fails. Nearer windows may hold pre-echo.
// - waveform: SNR of at least 10 dB at the best lag. Coders drop the waveform's fine detail (noise filling,
//   band replication), so a waveform match tighter than this is not something AAC or Opus promise.
// - duration: the decoded length is the span's within one codec frame (AAC 1024, Opus 960 samples).
// Two controls run the same checks against a wrong expectation (3 dB quieter; offset ignored) and must fail.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeWav, type AudioData } from "../../src/media/audio.ts";
import type { Mp4Audio } from "../lib/mp4-demux.ts";
import { demuxMp4 } from "../lib/mp4-demux.ts";
import { demuxWebm } from "../lib/webm-demux.ts";

const RATE = 48000;
const LAG_LIMIT = 48;
const LEVEL_DB = 1;
const SOUND_DB = -40;
const SILENT_DB = -70;
const SILENCE_LIMIT_DB = -50;
const SNR_DB = 10;
const WINDOW = 960;
/** Windows on each side of a silent window that must be silent too (40 ms). */
const SILENCE_GUARD = 2;

export interface AudioCase {
  name: string;
  file: string;
  comp: string;
  wavDir: string;
  /** Moves the audible layers this many seconds later before exporting. */
  shift?: number;
  span: { start: number; duration: number };
}

export interface Harness {
  call: <T>(fn: string, ...params: unknown[]) => Promise<T>;
  uploads: Map<string, Buffer>;
  check: (label: string, ok: boolean, detail?: string) => void;
}

interface LayerInfo {
  index: number;
  name: string;
  startTime: number;
  inPoint: number;
  outPoint: number;
  stretch: number;
  audioEnabled: boolean;
  solo: boolean;
  file: string | null;
  hasAudio: boolean;
}

const baseName = (path: string) => path.split(/[\\/]/).pop()!;
const db = (power: number) => (power > 0 ? 10 * Math.log10(power) : -Infinity);

/** Linear interpolation of a channel at fractional sample position p (0 outside). */
function at(data: Float32Array, p: number): number {
  const k = Math.floor(p);
  if (k < 0 || k >= data.length) return 0;
  const next = k + 1 < data.length ? data[k + 1] : 0;
  return data[k] + (next - data[k]) * (p - k);
}

/** The expected stereo mix of the comp's audible WAV layers over the span (each layer at unit stretch). */
function expectedMix(layers: { layer: LayerInfo; wav: AudioData; gain: (t: number) => number }[], span: AudioCase["span"], ignoreOffset = false): Float32Array[] {
  const n = Math.round(span.duration * RATE);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (const { layer, wav, gain } of layers) {
    const channels = Array.from({ length: wav.numberOfChannels }, (_, c) => wav.getChannelData(c));
    const start = ignoreOffset ? 0 : layer.startTime;
    const from = ignoreOffset ? 0 : layer.inPoint;
    const to = ignoreOffset ? Infinity : layer.outPoint;
    for (let i = 0; i < n; i++) {
      const t = span.start + i / RATE;
      if (t < from || t >= to) continue;
      const p = (t - start) * wav.sampleRate;
      const g = gain(t);
      for (let c = 0; c < 2; c++) out[c][i] += g * at(channels[Math.min(c, channels.length - 1)], p);
    }
  }
  return out;
}

function bestLag(got: Float32Array, want: Float32Array, limit: number): { lag: number; snr: number } {
  const n = Math.min(got.length, want.length);
  let best = { lag: 0, corr: -Infinity };
  for (let lag = -limit; lag <= limit; lag++) {
    let dot = 0;
    let gg = 0;
    for (let i = Math.max(0, -lag); i < n && i + lag < got.length; i++) {
      const g = got[i + lag];
      dot += g * want[i];
      gg += g * g;
    }
    const corr = gg > 0 ? dot / Math.sqrt(gg) : -Infinity;
    if (corr > best.corr) best = { lag, corr };
  }
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < n; i++) {
    const g = i + best.lag >= 0 && i + best.lag < got.length ? got[i + best.lag] : 0;
    signal += want[i] * want[i];
    noise += (g - want[i]) ** 2;
  }
  return { lag: best.lag, snr: noise > 0 ? db(signal / noise) : Infinity };
}

/** Level and silence agreement per 20 ms window. */
function windows(got: Float32Array[], want: Float32Array[]): { levelWorst: number; silentWorst: number; sounding: number; silent: number } {
  let levelWorst = 0;
  let silentWorst = -Infinity;
  let sounding = 0;
  let silent = 0;
  const n = Math.min(got[0].length, want[0].length);
  const levels: { g: number; e: number }[] = [];
  for (let w = 0; w + WINDOW <= n; w += WINDOW) {
    let pg = 0;
    let pw = 0;
    for (let c = 0; c < 2; c++) {
      for (let i = w; i < w + WINDOW; i++) {
        pg += got[c][i] ** 2;
        pw += want[c][i] ** 2;
      }
    }
    levels.push({ g: db(pg / (2 * WINDOW)), e: db(pw / (2 * WINDOW)) });
  }
  levels.forEach(({ g, e }, k) => {
    if (e > SOUND_DB) {
      sounding++;
      levelWorst = Math.max(levelWorst, Math.abs(g - e));
    } else if (levels.slice(Math.max(0, k - SILENCE_GUARD), k + SILENCE_GUARD + 1).every((l) => l.e < SILENT_DB)) {
      // Transform codecs smear up to a frame of pre-echo next to sound; silence is checked away from it.
      silent++;
      silentWorst = Math.max(silentWorst, g);
    }
  });
  return { levelWorst, silentWorst, sounding, silent };
}

interface Verdict {
  ok: boolean;
  detail: string;
}

function compare(got: Float32Array[], want: Float32Array[]): Verdict {
  const { lag, snr } = bestLag(got[0], want[0], 2400);
  const win = windows(got, want);
  const ok = Math.abs(lag) <= LAG_LIMIT && snr >= SNR_DB && win.levelWorst <= LEVEL_DB && (win.silent === 0 || win.silentWorst <= SILENCE_LIMIT_DB) && win.sounding > 0;
  const silent = win.silent ? `${win.silent} silent windows max ${win.silentWorst === -Infinity ? "-inf" : win.silentWorst.toFixed(1)} dBFS` : "no silent windows";
  return { ok, detail: `lag ${lag} samples (${((lag / RATE) * 1000).toFixed(2)} ms), SNR ${snr.toFixed(1)} dB, ${win.sounding} sounding windows within ${win.levelWorst.toFixed(2)} dB, ${silent}` };
}

export async function runAudioCases(h: Harness, cases: AudioCase[]): Promise<void> {
  for (const c of cases) {
    console.log(`\n== ${c.name} (${c.comp}, audio)`);
    await h.call("load", readFileSync(c.file).toString("base64"));
    const audible = (list: LayerInfo[]) => list.filter((l) => l.audioEnabled && l.hasAudio && l.file);
    if (c.shift) for (const l of audible(await h.call<LayerInfo[]>("layers", c.comp))) await h.call("shiftLayer", c.comp, l.index, c.shift);
    const layers = audible(await h.call<LayerInfo[]>("layers", c.comp));
    const anySolo = layers.some((l) => l.solo);
    const heard = layers.filter((l) => !anySolo || l.solo);
    const sources: { layer: LayerInfo; wav: AudioData; gain: (t: number) => number }[] = [];
    for (const layer of heard) {
      const name = baseName(layer.file!);
      const bytes = readFileSync(join(c.wavDir, name));
      await h.call("addFile", name, bytes.toString("base64"));
      const wav = decodeWav(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (!wav || layer.stretch !== 100) throw new Error(`${name}: the audio check needs an unstretched WAV layer`);
      const step = 1 / 240;
      const times = Array.from({ length: Math.ceil(c.span.duration / step) + 1 }, (_, i) => c.span.start + i * step);
      const levels = await h.call<number[]>("audioLevels", c.comp, layer.index, times);
      sources.push({ layer, wav, gain: (t) => 10 ** (levels[Math.min(levels.length - 1, Math.max(0, Math.round((t - c.span.start) / step)))] / 20) });
    }
    console.log(heard.map((l) => `  layer ${l.index} ${l.name}: start ${l.startTime.toFixed(3)} s, in ${l.inPoint.toFixed(3)}, out ${l.outPoint.toFixed(3)}`).join("\n"));
    const want = expectedMix(sources, c.span);
    const n = want[0].length;
    const settings = { resolution: 2, timeSpan: "custom", customStart: c.span.start, customDuration: c.span.duration, frameRate: null };

    for (const format of ["h264", "vp9"] as const) {
      const key = `${c.name}/${format}-audio`;
      const tag = `${c.name} ${format} audio`;
      const run = await h.call<{ status: string; error?: string; audioCodec: string | null; log: string[] }>("exportItem", key, c.comp, settings, { format, channels: "rgb", bitrate: null, audio: "auto" });
      if (run.status !== "Done") {
        h.check(`${tag}: renders to Done`, false, `${run.status} ${run.error ?? ""}`);
        continue;
      }
      const file = new Uint8Array(h.uploads.get(`${key}/out`)!);
      const spanS = c.span.duration;
      if (format === "h264") {
        const mp4 = demuxMp4(file);
        const a: Mp4Audio | undefined = mp4.audio;
        const asc = a?.audioSpecificConfig;
        const durationS = a ? a.duration / a.timescale : 0;
        const problems = a
          ? [
              a.sampleEntry !== "mp4a" && `sample entry ${a.sampleEntry}`,
              !(asc && asc[0] >> 3 === 2) && `AudioSpecificConfig ${asc ? [...asc].join(",") : "missing"} (not AAC LC)`,
              (a.sampleRate !== RATE || a.channels !== 2) && `${a.sampleRate} Hz, ${a.channels} channels`,
              (durationS < spanS - 1e-6 || durationS > spanS + 1024 / RATE) && `media duration ${durationS.toFixed(4)} s`,
              a.samples.some((s) => s.duration !== 1024 * (a.timescale / RATE)) && "samples are not 1024 frames",
              run.audioCodec !== "mp4a.40.2" && `queue reports ${run.audioCodec}`,
            ].filter(Boolean)
          : ["no audio track"];
        h.check(
          `${tag}: MP4 has an AAC-LC 48 kHz stereo track of the span's duration (${spanS.toFixed(3)} s, at most one 1024-sample frame longer)`,
          problems.length === 0,
          problems.length ? problems.join("; ") : `${a!.samples.length} AAC frames, ${durationS.toFixed(4)} s, timescale ${a!.timescale}`,
        );
      } else {
        const webm = demuxWebm(file);
        const a = webm.audio;
        const toUs = (t: number) => (t * webm.timecodeScale) / 1000;
        const head = a?.codecPrivate;
        const preSkip = head && head.length >= 12 ? head[10] | (head[11] << 8) : -1;
        const last = a?.blocks[a.blocks.length - 1];
        // Played end = last block start + 20 ms - DiscardPadding - CodecDelay.
        const endUs = last ? toUs(last.time) + 20000 - (last.discardPadding ?? 0) / 1000 - (a!.codecDelay / 1000) : 0;
        const times = a?.blocks.map((b) => b.time) ?? [];
        const interleaved = webm.blockTracks.indexOf(a?.trackNumber ?? -1) < webm.blockTracks.lastIndexOf(webm.trackNumber);
        const problems = a
          ? [
              a.codec !== "A_OPUS" && `codec ${a.codec}`,
              !(head && new TextDecoder().decode(head.subarray(0, 8)) === "OpusHead" && head[9] === 2) && "CodecPrivate is not a stereo OpusHead",
              (a.sampleRate !== RATE || a.channels !== 2) && `${a.sampleRate} Hz, ${a.channels} channels`,
              Math.abs(a.codecDelay - Math.round((preSkip / RATE) * 1e9)) > 1 && `CodecDelay ${a.codecDelay} ns for pre-skip ${preSkip}`,
              a.seekPreRoll !== 80_000_000 && `SeekPreRoll ${a.seekPreRoll}`,
              times.some((t, i) => i > 0 && t - times[i - 1] !== 20) && "Opus blocks are not 20 ms apart",
              Math.abs(endUs - spanS * 1e6) > 1000 && `audio ends at ${(endUs / 1e6).toFixed(4)} s`,
              !interleaved && "audio is not interleaved with video",
              run.audioCodec !== "opus" && `queue reports ${run.audioCodec}`,
            ].filter(Boolean)
          : ["no audio track"];
        h.check(
          `${tag}: WebM has an Opus 48 kHz stereo track (OpusHead, CodecDelay = pre-skip, DiscardPadding) ending at the span's end (${spanS.toFixed(3)} s) within 1 ms, interleaved with the video`,
          problems.length === 0,
          problems.length ? problems.join("; ") : `${a!.blocks.length} Opus blocks, pre-skip ${preSkip}, ends at ${(endUs / 1e6).toFixed(4)} s`,
        );
      }

      const decoded = await h.call<{ sampleRate?: number; length?: number; channels?: number; duration?: number; error?: string }>("decodeAudio", key);
      if (decoded.error || !decoded.length) {
        h.check(`${tag}: the browser decodes the audio track`, false, decoded.error ?? "no samples");
        continue;
      }
      const got = Array.from({ length: 2 }, (_, ch) => {
        const buf = h.uploads.get(`${key}/audio/${Math.min(ch, (decoded.channels ?? 1) - 1)}`)!;
        return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      });
      const frame = format === "h264" ? 1024 : 960;
      const lengthOk = decoded.sampleRate === RATE && decoded.channels === 2 && decoded.length >= n - frame && decoded.length <= n + frame;
      h.check(
        `${tag}: decodeAudioData gives 48 kHz stereo of the span's length within one codec frame`,
        lengthOk,
        `${decoded.length} samples at ${decoded.sampleRate} Hz (${decoded.channels} ch), expected ${n} +- ${frame}`,
      );
      const verdict = compare(got, want);
      h.check(`${tag}: decoded audio matches the independently mixed source (lag <= 1 ms, 20 ms window levels within ${LEVEL_DB} dB, silence kept, SNR >= ${SNR_DB} dB)`, verdict.ok, verdict.detail);
      const quieter = compare(got, want.map((ch) => ch.map((v) => v * 10 ** (-3 / 20))));
      const unshifted = compare(got, expectedMix(sources, c.span, true));
      if (c.shift) {
        h.check(`${tag}: control - the same checks fail against a mix 3 dB quieter and against one that ignores the layer's offset`, !quieter.ok && !unshifted.ok, `3 dB quieter: ${quieter.detail}; offset ignored: ${unshifted.detail}`);
      } else {
        h.check(`${tag}: control - the same checks fail against a mix 3 dB quieter`, !quieter.ok, quieter.detail);
      }
    }

    const offKey = `${c.name}/h264-audio-off`;
    const off = await h.call<{ status: string; audioCodec: string | null }>("exportItem", offKey, c.comp, settings, { format: "h264", channels: "rgb", bitrate: null, audio: "off" });
    const offFile = off.status === "Done" ? demuxMp4(new Uint8Array(h.uploads.get(`${offKey}/out`)!)) : null;
    h.check(`${c.name}: Audio Output Off writes no audio track`, !!offFile && !offFile.audio && off.audioCodec === null, off.status === "Done" ? `audio track ${offFile?.audio ? "present" : "absent"}` : off.status);
  }
}
