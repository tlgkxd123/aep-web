// Times one Audio Spectrum analysis (audioSpectrumAnalysis.ts) for a window and band count, as the effect
// runs it per instance and frame.
//
//   node scripts/bench-spectrum.ts [duration ms=170] [bands=750] [rate=48000]
import { analyse, windowLength } from "../src/render/effects/audioSpectrumAnalysis.ts";

const [durationMs = 170, bands = 750, rate = 48000] = process.argv.slice(2).map(Number);
const length = windowLength(rate, durationMs);
const samples = Float32Array.from({ length }, (_, i) => Math.sin(i * 0.05) * 0.5 + Math.sin(i * 0.013) * 0.3);
const settings = { startFrequency: 20, endFrequency: 250, bands, durationMs };
for (let i = 0; i < 20; i++) analyse(samples, rate, settings);
const runs = 200;
const started = performance.now();
for (let i = 0; i < runs; i++) analyse(samples, rate, settings);
console.log(`${length} samples, ${bands} bands: ${((performance.now() - started) / runs).toFixed(3)} ms per analysis`);
