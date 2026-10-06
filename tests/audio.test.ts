import { expect, test } from "vitest";
import type { FootageItem } from "../src/aep/model.ts";
import { decodeWav } from "../src/media/audio.ts";
import { FootageStore } from "../src/media/store.ts";
import { analyse, analyseAveraged, fft } from "../src/render/effects/audioSpectrumAnalysis.ts";

/** A 16-bit PCM RIFF WAVE file with one sample array per channel. */
function wav(rate: number, channels: number[][]): Uint8Array<ArrayBuffer> {
  const frames = channels[0].length;
  const data = frames * channels.length * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels.length * 2, true);
  view.setUint16(32, channels.length * 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, data, true);
  for (let f = 0; f < frames; f++) {
    channels.forEach((c, ch) => view.setInt16(44 + (f * channels.length + ch) * 2, Math.round(c[f] * 32767), true));
  }
  return bytes;
}

const sine = (rate: number, frequency: number, amplitude: number, length: number) =>
  Array.from({ length }, (_, n) => amplitude * Math.sin((2 * Math.PI * frequency * n) / rate));

function audioItem(fileName: string): FootageItem {
  return {
    id: 7,
    kind: "footage",
    name: fileName,
    mainSource: { sourceType: "FileSource", file: `C:/media/${fileName}`, relativePath: "", fileName, isStill: false },
  } as unknown as FootageItem;
}

test("a 16-bit stereo WAVE decodes to its samples per channel at its own rate", () => {
  const left = [0, 0.5, -0.5, 1];
  const right = [0.25, -0.25, 0, -1];
  const audio = decodeWav(wav(22050, [left, right]))!;
  expect([audio.sampleRate, audio.numberOfChannels, audio.length]).toEqual([22050, 2, 4]);
  expect([...audio.getChannelData(0)].map((v) => Math.round(v * 4) / 4)).toEqual(left);
  expect([...audio.getChannelData(1)].map((v) => Math.round(v * 4) / 4)).toEqual(right);
  expect(decodeWav(new Uint8Array([1, 2, 3]))).toBeUndefined();
});

test("footage audio decodes asynchronously: pending and busy first, then ready with listeners notified", async () => {
  const store = new FootageStore();
  const item = audioItem("tone.wav");
  expect(store.audio(item).status).toBe("missing");
  store.addFiles([{ path: "media/tone.wav", blob: new Blob([wav(8000, [sine(8000, 1000, 0.5, 800)])]) }]);
  let notified = 0;
  store.subscribe(() => notified++);
  expect(store.audio(item).status).toBe("pending");
  expect(store.busy).toBe(true);
  await store.idle();
  await Promise.resolve();
  expect(store.busy).toBe(false);
  expect(notified).toBeGreaterThan(0);
  const state = store.audio(item);
  expect(state.status === "ready" && [state.audio.sampleRate, state.audio.length]).toEqual([8000, 800]);
});

test("footage audio that cannot be decoded reports an error instead of staying pending", async () => {
  const store = new FootageStore();
  const item = audioItem("broken.mp3");
  store.addFiles([{ path: "broken.mp3", blob: new Blob([new Uint8Array([0, 1, 2, 3])]) }]);
  expect(store.audio(item).status).toBe("pending");
  await store.idle();
  expect(store.audio(item).status).toBe("error");
});

test("the FFT matches a direct DFT and inverts", () => {
  for (const n of [1, 2, 4, 8, 32, 256]) {
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 1.7) + 0.3);
    const im = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.9));
    const [xr, xi] = [re.slice(), im.slice()];
    fft(xr, xi, -1);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
        si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
      }
      expect(Math.abs(xr[k] - sr) + Math.abs(xi[k] - si)).toBeLessThan(1e-9 * n);
    }
    fft(xr, xi, 1);
    for (let t = 0; t < n; t++) expect(Math.abs(xr[t] / n - re[t]) + Math.abs(xi[t] / n - im[t])).toBeLessThan(1e-12 * n);
  }
});

test("a sine reads its amplitude in the band at its frequency; averaging reads the windowed mean", () => {
  const rate = 48000;
  const samples = Float32Array.from(sine(rate, 1000, 0.5, 4800));
  const settings = { startFrequency: 0, endFrequency: 2000, bands: 20, durationMs: 100 };
  const bands = analyse(samples, rate, settings);
  expect(bands[10]).toBeCloseTo(0.5, 3);
  expect(Math.max(...bands.filter((_, k) => Math.abs(k - 10) > 1))).toBeLessThan(0.01);
  const constant = new Float32Array(4800).fill(0.25);
  const averaged = analyseAveraged(constant, rate, settings);
  expect(averaged[0]).toBeCloseTo(0.5, 5);
  expect(averaged[19]).toBeLessThan(averaged[0]);
});
