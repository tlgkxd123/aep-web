// Reads what After Effects caches about a footage file at import from its
// header: the importer's format code, frame size, duration, native frame rate
// and whether it has alpha (the rules AE's importers apply: PNG by color type
// or tRNS, TIFF/BMP/GIF always, JPEG never).
import { decodeAudio, decodeWav } from "./audio.ts";
import { audioTrackRate, demuxVideo } from "./mp4.ts";

export type MediaKind = "png" | "jpeg" | "gif" | "bmp" | "tiff" | "video" | "audio";

export interface MediaInfo {
  kind: MediaKind;
  /** The importer's 4-character code AE stores in `sspc`. */
  format: string;
  width: number;
  height: number;
  /** Seconds; 0 for a still. */
  duration: number;
  /** Native frame rate; 0 for a still. */
  frameRate: number;
  hasAlpha: boolean;
  /** Audio-only files: the native sample rate (Hz) and the duration in samples. */
  audio?: { sampleRate: number; samples: number };
  /** Movies with a sound track: its sample rate (Hz). */
  audioTrackRate?: number;
}

const EXTENSIONS: Record<string, MediaKind> = {
  mp3: "audio",
  wav: "audio",
  wave: "audio",
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  bmp: "bmp",
  tif: "tiff",
  tiff: "tiff",
  mp4: "video",
  m4v: "video",
  mov: "video",
};

/** File extensions `probeMedia` reads, for file pickers. */
export const IMPORTABLE_EXTENSIONS = Object.keys(EXTENSIONS);

const extensionOf = (name: string) => (/\.([^./\\]+)$/.exec(name)?.[1] ?? "").toLowerCase();

export const isImportable = (name: string) => extensionOf(name) in EXTENSIONS;

const COMMON_RATES = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 120];

/** The nearest standard rate (NTSC rates exact, 24000/1001...) when within 0.05%. */
function snapRate(fps: number): number {
  const nearest = COMMON_RATES.reduce((a, b) => (Math.abs(fps - b) < Math.abs(fps - a) ? b : a));
  if (Math.abs(fps - nearest) / nearest > 0.0005) return Math.round(fps * 1000) / 1000;
  return Number.isInteger(nearest) ? nearest : (Math.round(nearest * 1.001) * 1000) / 1001;
}

function pngInfo(b: Uint8Array, v: DataView): Omit<MediaInfo, "kind" | "format" | "duration" | "frameRate"> {
  if (b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) throw new Error("not a PNG file");
  const colorType = b[25];
  let hasAlpha = (colorType & 4) !== 0;
  for (let at = 8; !hasAlpha && at + 8 <= b.length; ) {
    const size = v.getUint32(at);
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
    if (type === "tRNS") hasAlpha = true;
    if (type === "IDAT" || type === "IEND") break;
    at += 12 + size;
  }
  return { width: v.getUint32(16), height: v.getUint32(20), hasAlpha };
}

function jpegSize(b: Uint8Array, v: DataView): { width: number; height: number } {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("not a JPEG file");
  for (let at = 2; at + 9 < b.length; ) {
    if (b[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = b[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: v.getUint16(at + 5), width: v.getUint16(at + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) at += 2;
    else at += 2 + v.getUint16(at + 2);
  }
  throw new Error("JPEG file has no frame header");
}

function tiffSize(b: Uint8Array, v: DataView): { width: number; height: number } {
  const little = b[0] === 0x49;
  if (!(little || b[0] === 0x4d) || v.getUint16(2, little) !== 42) throw new Error("not a TIFF file");
  const ifd = v.getUint32(4, little);
  let width = 0;
  let height = 0;
  for (let i = 0, n = v.getUint16(ifd, little); i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = v.getUint16(e, little);
    const value = v.getUint16(e + 2, little) === 3 ? v.getUint16(e + 8, little) : v.getUint32(e + 8, little);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }
  if (!width || !height) throw new Error("TIFF file has no image size");
  return { width, height };
}

const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** The sample rate in the first MPEG audio frame header, after any ID3v2 tag. */
function mp3SampleRate(b: Uint8Array): number | undefined {
  let at = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) at = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
  for (; at + 4 < b.length; at++) {
    if (b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[at + 1] >> 3) & 3;
    const rate = MP3_RATES[version]?.[(b[at + 2] >> 2) & 3];
    if (rate) return rate;
  }
  return undefined;
}

/** An audio-only file as AE's importers record it: format code, native rate and length in samples. */
async function audioInfo(blob: Blob, name: string): Promise<MediaInfo> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const wav = decodeWav(bytes);
  const ext = extensionOf(name);
  let sampleRate: number;
  let samples: number;
  if (wav) {
    sampleRate = wav.sampleRate;
    samples = wav.length;
  } else {
    sampleRate = (ext === "mp3" ? mp3SampleRate(bytes) : undefined) ?? 48000;
    // The browser decodes at its own rate; the length in seconds converts back to native samples.
    const decoded = await decodeAudio(bytes, sampleRate);
    samples = Math.round((decoded.length / decoded.sampleRate) * sampleRate);
  }
  const format = wav ? "WAVE" : "MP3A";
  return { kind: "audio", format, width: 0, height: 0, duration: samples / sampleRate, frameRate: 0, hasAlpha: false, audio: { sampleRate, samples } };
}

/** Probes a footage file AE would import as a single still, movie or audio file. */
export async function probeMedia(blob: Blob, name: string): Promise<MediaInfo> {
  const kind = EXTENSIONS[extensionOf(name)];
  if (!kind) throw new Error(`"${name}" is not a footage format this importer reads (${IMPORTABLE_EXTENSIONS.join(", ")})`);
  if (kind === "audio") return audioInfo(blob, name);
  if (kind === "video") {
    const track = await demuxVideo(blob);
    const times = track.samples.map((s) => s.time).sort((a, b) => a - b);
    const deltas = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0).sort((a, b) => a - b);
    const frameRate = deltas.length ? snapRate(1 / deltas[deltas.length >> 1]) : 30;
    const duration = times.length / frameRate;
    const format = extensionOf(name) === "mp4" ? "XCEX" : "MOoV";
    const audioRate = await audioTrackRate(blob).catch(() => 0);
    return { kind, format, width: track.width, height: track.height, duration, frameRate, hasAlpha: false, ...(audioRate ? { audioTrackRate: audioRate } : {}) };
  }
  const head = new Uint8Array(await blob.slice(0, kind === "png" ? 1 << 16 : kind === "jpeg" ? 1 << 18 : 1 << 12).arrayBuffer());
  let b = head;
  let v = new DataView(b.buffer);
  const still = { kind, duration: 0, frameRate: 0 };
  switch (kind) {
    case "png":
      return { ...still, format: "png!", ...pngInfo(b, v) };
    case "jpeg":
      if (head.length === 1 << 18) {
        b = new Uint8Array(await blob.arrayBuffer());
        v = new DataView(b.buffer);
      }
      return { ...still, format: "ZPEG", ...jpegSize(b, v), hasAlpha: false };
    case "gif":
      if (String.fromCharCode(...b.subarray(0, 3)) !== "GIF") throw new Error("not a GIF file");
      return { ...still, format: "STIL", width: v.getUint16(6, true), height: v.getUint16(8, true), hasAlpha: true };
    case "bmp":
      if (b[0] !== 0x42 || b[1] !== 0x4d) throw new Error("not a BMP file");
      return { ...still, format: "STIL", width: Math.abs(v.getInt32(18, true)), height: Math.abs(v.getInt32(22, true)), hasAlpha: true };
    case "tiff":
      b = new Uint8Array(await blob.arrayBuffer());
      return { ...still, format: "TIF ", ...tiffSize(b, new DataView(b.buffer)), hasAlpha: true };
  }
}
