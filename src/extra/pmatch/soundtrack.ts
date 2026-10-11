// Sound tracks for Particle Match, as the world model hears them (audio.ts): a file's sound (the reference
// video's, or a song's) and a layer's mix. The browser decodes them; a worker (featuresWorker.ts) computes the
// features, about a second of work for a four-minute song, so the page keeps playing meanwhile.
import type { LayerAudio } from "../../media/mixWindow.ts";
import { decodeSoundTrack, type AudioFeatures } from "./audio.ts";
import { computeFeatures, jobBuffers, type FeaturesJob, type FeaturesReply } from "./soundFeatures.ts";

export interface Sound {
  /** Seconds of sound. */
  duration: number;
  features: AudioFeatures;
}

interface Waiting {
  resolve: (features: AudioFeatures) => void;
  reject: (error: Error) => void;
}

const waiting = new Map<number, Waiting>();
let nextId = 1;
let worker: Promise<Worker | null> | undefined;

function featuresWorker(): Promise<Worker | null> {
  worker ??=
    typeof Worker === "undefined"
      ? Promise.resolve(null)
      : import("./featuresWorker.ts?worker&inline").then(
          ({ default: FeaturesWorker }) => {
            const w = new FeaturesWorker();
            w.onmessage = ({ data }: MessageEvent<FeaturesReply>) => {
              const job = waiting.get(data.id);
              waiting.delete(data.id);
              if (!job) return;
              if ("error" in data) job.reject(new Error(data.error));
              else job.resolve(data.features);
            };
            w.onerror = (event) => {
              event.preventDefault();
              for (const job of waiting.values()) job.reject(new Error(event.message || "the sound could not be analysed"));
              waiting.clear();
            };
            return w;
          },
          () => null,
        );
  return worker;
}

async function features(job: FeaturesJob): Promise<AudioFeatures> {
  const w = await featuresWorker();
  if (!w) return computeFeatures(job);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    w.postMessage({ ...job, id }, jobBuffers(job));
  });
}

/** The sound of a video or audio file (null when it has none the browser can decode); its features are videoAudioFeatures'. */
export async function fileSound(blob: Blob): Promise<Sound | null> {
  const audio = await decodeSoundTrack(blob);
  if (!audio) return null;
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c).slice());
  const duration = audio.length / audio.sampleRate;
  return { duration, features: await features({ kind: "file", source: { sampleRate: audio.sampleRate, channels }, duration }) };
}

/** The sound of a layer's mix (mix.ts) over [0, duration) seconds of its comp. */
export async function mixSound(audio: LayerAudio, duration: number): Promise<Sound> {
  const contributions = audio.contributions.map((c) => ({
    sampleRate: c.audio.sampleRate,
    channels: Array.from({ length: c.audio.numberOfChannels }, (_, i) => c.audio.getChannelData(i).slice()),
    scale: c.scale,
    offset: c.offset,
    from: c.from,
    to: c.to,
  }));
  return { duration, features: await features({ kind: "mix", rate: audio.rate, timeScale: audio.timeScale, contributions, duration }) };
}
