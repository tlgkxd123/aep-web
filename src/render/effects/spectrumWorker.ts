// Computes Audio Spectrum band magnitudes off the main thread, with the same code the effect runs on it
// (mixWindow + audioSpectrumAnalysis), for the frames playback is about to show. Driven by spectrumPrefetch.ts.
import type { AudioData } from "../../media/audio.ts";
import { mixWindow } from "../../media/mixWindow.ts";
import { analyse, analyseAveraged } from "./audioSpectrumAnalysis.ts";
import type { SpectrumReply, SpectrumRequest } from "./spectrumPrefetch.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SpectrumRequest>) => void) | null;
  postMessage(message: SpectrumReply, transfer?: Transferable[]): void;
};

const sounds = new Map<number, AudioData>();

scope.onmessage = ({ data }) => {
  if (data.type === "audio") {
    const { channels, sampleRate } = data;
    sounds.set(data.id, { sampleRate, numberOfChannels: channels.length, length: channels[0]?.length ?? 0, getChannelData: (i) => channels[i] });
    return;
  }
  if (data.type === "forget") {
    sounds.delete(data.id);
    return;
  }
  const { job } = data;
  const contributions = job.contributions.map((c) => ({ ...c, audio: sounds.get(c.id)! }));
  if (contributions.some((c) => !c.audio)) {
    scope.postMessage({ type: "missing", key: job.key });
    return;
  }
  const samples = mixWindow({ rate: job.rate, timeScale: job.timeScale, contributions }, job.first, job.length);
  const mags = (job.averaged ? analyseAveraged : analyse)(samples, job.rate, job.settings);
  scope.postMessage({ type: "spectrum", key: job.key, mags }, [mags.buffer]);
};
