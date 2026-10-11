// The world model's audio features (audio.ts) of a decoded sound, described in one message: what
// featuresWorker.ts computes off the main thread, and soundtrack.ts on it when no worker can run.
import type { AudioData } from "../../media/audio.ts";
import { mixWindow, type LayerAudio } from "../../media/mixWindow.ts";
import { audioFeatures, channelReader, type AudioFeatures } from "./audio.ts";

/** Planar samples of one decoded source. */
export interface SoundSource {
  sampleRate: number;
  channels: Float32Array[];
}

export type FeaturesJob =
  /** A file's sound from its first sample, read as videoAudioFeatures reads it. */
  | { kind: "file"; source: SoundSource; duration: number }
  /** A layer's mix on its comp's timeline (mix.ts). */
  | { kind: "mix"; rate: number; timeScale: number; contributions: (SoundSource & { scale: number; offset: number; from: number; to: number })[]; duration: number };

export type FeaturesRequest = FeaturesJob & { id: number };
export type FeaturesReply = { id: number; features: AudioFeatures } | { id: number; error: string };

const audioData = (source: SoundSource): AudioData => ({
  sampleRate: source.sampleRate,
  numberOfChannels: source.channels.length,
  length: source.channels[0]?.length ?? 0,
  getChannelData: (channel) => source.channels[channel],
});

export function computeFeatures(job: FeaturesJob): AudioFeatures {
  if (job.kind === "file") return audioFeatures(channelReader(job.source.channels), job.source.sampleRate, job.duration);
  const audio: LayerAudio = {
    rate: job.rate,
    timeScale: job.timeScale,
    contributions: job.contributions.map((c) => ({ audio: audioData(c), scale: c.scale, offset: c.offset, from: c.from, to: c.to })),
  };
  return audioFeatures((first, length) => mixWindow(audio, first, length), audio.rate * audio.timeScale, job.duration);
}

/** The buffers holding a job's samples, to transfer with it. */
export function jobBuffers(job: FeaturesJob): ArrayBuffer[] {
  const sources = job.kind === "file" ? [job.source] : job.contributions;
  return sources.flatMap((s) => s.channels.map((c) => c.buffer as ArrayBuffer));
}
