// Audio decoding for effects that visualise another layer's sound (Audio
// Spectrum, Audio Waveform). The footage store decodes located files on demand;
// tests can `registerAudio` decoded audio for a footage item id directly.

/** The part of WebAudio's AudioBuffer the visualisers use (an AudioBuffer satisfies it). */
export interface AudioData {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  /** Samples per channel. */
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

const registered = new Map<number, AudioData>();

export function registerAudio(itemId: number, audio: AudioData | undefined): void {
  if (audio) registered.set(itemId, audio);
  else registered.delete(itemId);
}

export function clearAudio(): void {
  registered.clear();
}

/** Audio registered for footage item `itemId`, if any. */
export function registeredAudio(itemId: number): AudioData | undefined {
  return registered.get(itemId);
}

class PlanarAudio implements AudioData {
  readonly sampleRate: number;
  private readonly channels: Float32Array[];
  constructor(sampleRate: number, channels: Float32Array[]) {
    this.sampleRate = sampleRate;
    this.channels = channels;
  }
  get numberOfChannels(): number {
    return this.channels.length;
  }
  get length(): number {
    return this.channels[0]?.length ?? 0;
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Decodes an uncompressed RIFF/RIFX WAVE file (8/16/24/32-bit integer or 32/64-bit
 * float PCM) at its own sample rate. Returns undefined for anything else.
 */
export function decodeWav(bytes: Uint8Array): AudioData | undefined {
  if (bytes.length < 12) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if ((tag !== "RIFF" && tag !== "RIFX") || String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE") return undefined;
  const little = tag === "RIFF";
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let data: { offset: number; size: number } | undefined;
  for (let p = 12; p + 8 <= bytes.length; ) {
    const id = String.fromCharCode(...bytes.subarray(p, p + 4));
    const size = view.getUint32(p + 4, little);
    const body = p + 8;
    if (id === "fmt " && size >= 16) {
      format = view.getUint16(body, little);
      channels = view.getUint16(body + 2, little);
      rate = view.getUint32(body + 4, little);
      bits = view.getUint16(body + 14, little);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, little);
    } else if (id === "data") {
      data = { offset: body, size: Math.min(size, bytes.length - body) };
    }
    p = body + size + (size & 1);
  }
  const bytesPerSample = bits / 8;
  if (!data || !channels || !rate || !Number.isInteger(bytesPerSample)) return undefined;
  const float = format === WAVE_FORMAT_IEEE_FLOAT;
  if (!(format === WAVE_FORMAT_PCM && bits >= 8 && bits <= 32) && !(float && (bits === 32 || bits === 64))) return undefined;
  const frames = Math.floor(data.size / (bytesPerSample * channels));
  const planes = Array.from({ length: channels }, () => new Float32Array(frames));
  const read = (at: number): number => {
    if (float) return bits === 32 ? view.getFloat32(at, little) : view.getFloat64(at, little);
    if (bits === 8) return (bytes[at] - 128) / 128;
    if (bits === 16) return view.getInt16(at, little) / 32768;
    if (bits === 24) {
      const b0 = bytes[at];
      const b1 = bytes[at + 1];
      const b2 = bytes[at + 2];
      const v = little ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
      return ((v << 8) >> 8) / 8388608;
    }
    return view.getInt32(at, little) / 2147483648;
  };
  for (let f = 0, at = data.offset; f < frames; f++) {
    for (let c = 0; c < channels; c++, at += bytesPerSample) planes[c][f] = read(at);
  }
  return new PlanarAudio(rate, planes);
}

/**
 * Decodes an audio file: WAVE natively at its own rate, anything else the browser
 * can decode (MP3, AAC, Ogg...) through WebAudio at `fallbackRate`.
 */
export async function decodeAudio(bytes: Uint8Array, fallbackRate = 48000): Promise<AudioData> {
  const wav = decodeWav(bytes);
  if (wav) return wav;
  const context = new OfflineAudioContext(1, 1, fallbackRate);
  const copy = bytes.slice().buffer;
  return context.decodeAudioData(copy);
}

/** Mean of all channels at sample `index` (0 outside the clip). */
export function monoSample(audio: AudioData, channels: Float32Array[], index: number): number {
  if (index < 0 || index >= audio.length) return 0;
  let sum = 0;
  for (const data of channels) sum += data[index];
  return sum / channels.length;
}
