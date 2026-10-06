// Probes AudioEncoder in headless Edge: AAC and Opus support, the encoder's first chunks
// (timestamps, durations, sizes) and the decoder configuration it reports.
//
//   node scripts/export/probe-audio.ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";

const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>probe</title>"));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
const result = await page.evaluate(async () => {
  const out: Record<string, unknown> = { ua: navigator.userAgent, hasEncoder: typeof AudioEncoder !== "undefined" };
  for (const codec of ["mp4a.40.2", "mp4a.40.5", "opus", "flac", "pcm-f32"]) {
    for (const extra of [{}, { aac: { format: "aac" } }, { opus: { format: "ogg" } }]) {
      const config = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000, ...extra } as AudioEncoderConfig;
      try {
        const s = await AudioEncoder.isConfigSupported(config);
        out[`${codec} ${JSON.stringify(extra)}`] = s.supported;
      } catch (e) {
        out[`${codec} ${JSON.stringify(extra)}`] = `error ${(e as Error).message}`;
      }
    }
  }
  for (const codec of ["mp4a.40.2", "opus"]) {
    const chunks: { ts: number; dur: number | null; size: number; type: string }[] = [];
    let desc: number[] | null = null;
    const enc = new AudioEncoder({
      output: (c, meta) => {
        chunks.push({ ts: c.timestamp, dur: c.duration, size: c.byteLength, type: c.type });
        const d = meta?.decoderConfig?.description;
        if (d && !desc) desc = Array.from(new Uint8Array(d instanceof ArrayBuffer ? d : (d as ArrayBufferView).buffer));
      },
      error: (e) => (out[`${codec} error`] = e.message),
    });
    try {
      enc.configure({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
      const n = 48000;
      const data = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) data[i] = data[n + i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
      enc.encode(new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: 0, data }));
      await enc.flush();
      enc.close();
    } catch (e) {
      out[`${codec} error`] = (e as Error).message;
    }
    const total = chunks.reduce((s, c) => s + (c.dur ?? 0), 0);
    out[`${codec} chunks`] = { count: chunks.length, first: chunks.slice(0, 3), last: chunks.slice(-2), totalDurUs: total, desc };
  }
  return out;
});
console.log(JSON.stringify(result, null, 1));
await browser.close();
server.close();
