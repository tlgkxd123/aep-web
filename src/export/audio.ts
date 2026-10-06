// A comp's audio for export: the audible layers preview plays (src/media/audioPreview.ts), mixed offline
// with Web Audio at the output rate, then encoded with WebCodecs (AAC for MP4, Opus for WebM).
import type { CompItem, Project } from "../aep/model.ts";
import type { AudioData as SourceAudio } from "../media/audio.ts";
import { audibleLeaves, audioLevelsDb } from "../media/audioPreview.ts";
import { footageStore } from "../media/store.ts";

export const EXPORT_SAMPLE_RATE = 48000;
export const EXPORT_CHANNELS = 2;

/** Planar float stereo at `sampleRate`. */
export interface MixedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

const buffers = new WeakMap<SourceAudio, AudioBuffer>();

function toAudioBuffer(audio: SourceAudio): AudioBuffer {
  if (audio instanceof AudioBuffer) return audio;
  let buffer = buffers.get(audio);
  if (!buffer) {
    buffer = new AudioBuffer({ length: Math.max(1, audio.length), sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels });
    for (let c = 0; c < audio.numberOfChannels; c++) buffer.copyToChannel(audio.getChannelData(c) as Float32Array<ArrayBuffer>, c);
    buffers.set(audio, buffer);
  }
  return buffer;
}

/** Waits for the footage store to decode the item's audio; undefined when it is missing or undecodable. */
async function decoded(item: Parameters<typeof footageStore.audio>[0]): Promise<SourceAudio | undefined> {
  for (;;) {
    const state = footageStore.audio(item);
    if (state.status === "ready") return state.audio;
    if (state.status !== "pending") return undefined;
    await footageStore.idle();
  }
}

/**
 * The comp's audio from comp time `start` for `duration` seconds, or null when no audible layer has sound.
 * Each layer is a buffer source started at its offset with its stretch as playback rate, through a gain that
 * follows its Audio Levels frame by frame; mono sources play on both channels.
 */
export async function mixCompAudio(
  project: Project,
  comp: CompItem,
  start: number,
  duration: number,
  warn?: (message: string) => void,
  sampleRate = EXPORT_SAMPLE_RATE,
): Promise<MixedAudio | null> {
  const end = start + duration;
  const leaves = audibleLeaves(project, comp, start, end);
  if (!leaves.length) return null;
  const length = Math.max(1, Math.round(duration * sampleRate));
  const context = new OfflineAudioContext(EXPORT_CHANNELS, length, sampleRate);
  const step = comp.frameDuration || 1 / (comp.frameRate || 24);
  let heard = 0;
  for (const leaf of leaves) {
    const audio = await decoded(leaf.item);
    if (!audio) {
      warn?.(`audio of "${leaf.item.name}" is not loaded and was left out`);
      continue;
    }
    const buffer = toAudioBuffer(audio);
    const begin = Math.max(leaf.from, start, -leaf.b / leaf.a);
    if (begin >= leaf.to) continue;
    const offset = leaf.a * begin + leaf.b;
    const sourceDuration = Math.min((leaf.to - begin) * leaf.a, buffer.duration - offset);
    if (offset >= buffer.duration || sourceDuration <= 0) continue;
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = leaf.a;
    const gain = context.createGain();
    // Audio Levels are read in the layer's own comp time.
    const stretch = leaf.layer.stretch ? leaf.layer.stretch / 100 : 1;
    const layerTime = (t: number) => (leaf.a * t + leaf.b) * stretch + leaf.layer.startTime;
    const level = (t: number) => 10 ** (audioLevelsDb(leaf.layer, layerTime(t)) / 20);
    gain.gain.setValueAtTime(level(begin), begin - start);
    for (let t = Math.ceil(begin / step) * step; t < Math.min(leaf.to, end); t += step) {
      if (t > begin) gain.gain.linearRampToValueAtTime(level(t), t - start);
    }
    node.connect(gain).connect(context.destination);
    node.start(begin - start, offset, sourceDuration);
    heard++;
  }
  if (!heard) return null;
  const rendered = await context.startRendering();
  return { sampleRate, channels: Array.from({ length: EXPORT_CHANNELS }, (_, c) => rendered.getChannelData(c)) };
}

export type AudioCodec = "aac" | "opus";

export interface EncodedAudio {
  codec: AudioCodec;
  sampleRate: number;
  numberOfChannels: number;
  chunks: { chunk: EncodedAudioChunk; data: Uint8Array; meta?: EncodedAudioChunkMetadata }[];
  /** Codec setup: AudioSpecificConfig for AAC, OpusHead for Opus. */
  description?: Uint8Array;
  /** Samples the decoder drops before the first one heard (Opus pre-skip). */
  preSkip: number;
}

const CODEC_STRINGS: Record<AudioCodec, string> = { aac: "mp4a.40.2", opus: "opus" };

export function audioEncoderConfig(codec: AudioCodec, sampleRate = EXPORT_SAMPLE_RATE, bitrate = codec === "aac" ? 192_000 : 160_000): AudioEncoderConfig {
  return { codec: CODEC_STRINGS[codec], sampleRate, numberOfChannels: EXPORT_CHANNELS, bitrate };
}

/** Whether this browser encodes the codec, for the Output Module dialog. */
export async function audioSupported(codec: AudioCodec): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") return false;
  try {
    return !!(await AudioEncoder.isConfigSupported(audioEncoderConfig(codec))).supported;
  } catch {
    return false;
  }
}

function bytesOf(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  return new Uint8Array(source.slice(0));
}

/** OpusHead pre-skip (little-endian uint16 at byte 10). */
function opusPreSkip(head: Uint8Array | undefined): number {
  return head && head.length >= 12 ? head[10] | (head[11] << 8) : 0;
}

/** Encodes the mix in 1024-sample blocks, awaiting the encoder queue so memory stays flat. */
export async function encodeAudio(mixed: MixedAudio, codec: AudioCodec, signal?: AbortSignal): Promise<EncodedAudio> {
  if (typeof AudioEncoder === "undefined") throw new Error("This browser has no WebCodecs audio encoder.");
  const config = audioEncoderConfig(codec, mixed.sampleRate);
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`This browser cannot encode ${codec === "aac" ? "AAC" : "Opus"} audio.`);
  const out: EncodedAudio = { codec, sampleRate: mixed.sampleRate, numberOfChannels: mixed.channels.length, chunks: [], preSkip: 0 };
  let failure: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const description = meta?.decoderConfig?.description;
      if (description && !out.description) out.description = bytesOf(description);
      out.chunks.push({ chunk, data, meta });
    },
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
    },
  });
  const check = () => {
    if (failure) throw new Error(`Audio encoder failed: ${failure.message}`);
  };
  encoder.configure(config);
  try {
    const length = mixed.channels[0].length;
    const block = 1024 * 8;
    for (let at = 0; at < length; at += block) {
      if (signal?.aborted) throw new DOMException("Render stopped", "AbortError");
      check();
      const n = Math.min(block, length - at);
      const data = new Float32Array(n * mixed.channels.length);
      mixed.channels.forEach((channel, c) => data.set(channel.subarray(at, at + n), c * n));
      const frame = new AudioData({ format: "f32-planar", sampleRate: mixed.sampleRate, numberOfFrames: n, numberOfChannels: mixed.channels.length, timestamp: Math.round((at / mixed.sampleRate) * 1e6), data });
      encoder.encode(frame);
      frame.close();
      while (encoder.encodeQueueSize > 4 && !failure) await new Promise((r) => setTimeout(r, 0));
    }
    await encoder.flush();
    check();
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  out.preSkip = codec === "opus" ? opusPreSkip(out.description) : 0;
  return out;
}
