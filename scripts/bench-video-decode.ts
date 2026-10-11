// Measures how fast the app's WebCodecs reader (src/media/video.ts) delivers a movie's frames in headless Edge on
// this machine's GPU: hardware against software decoding, every frame or every n-th (fast playback through time
// remapping), with the frames' planes read back as the app does.
//
//   node scripts/bench-video-decode.ts <movie> [frames=240] [steps=1,3]
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const [movie, framesArg = "240", stepsArg = "1,3"] = process.argv.slice(2);
const server = await createServer({ configFile: "vite.config.ts", logLevel: "error", server: { port: 5192, strictPort: false } });
await server.listen();
const base = server.resolvedUrls!.local[0];
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
const bytes = readFileSync(movie);
await page.route("**/__bench_movie", (route) => route.fulfill({ body: bytes, contentType: "video/mp4" }));
await page.goto(base, { timeout: 180_000 });
for (const software of [false, true]) {
  for (const step of stepsArg.split(",").map(Number)) {
    const result = await page.evaluate(
      async ([software, step, count]) => {
        const { openWebCodecs, videoStats } = await import(/* @vite-ignore */ "/src/media/video.ts" as string);
        const blob = await (await fetch("/__bench_movie")).blob();
        const reader = await openWebCodecs(blob, software as boolean);
        Object.assign(videoStats, { resets: 0, fed: 0, frames: 0, convertMs: 0, waitMs: 0 });
        const got = new Set<number>();
        const started = performance.now();
        let worst = 0;
        for (let i = 0; i < (count as number); i++) {
          const index = (i * (step as number)) % reader.frameCount;
          if (got.has(index)) continue;
          const t = performance.now();
          await reader.decode(index, (p: number) => got.add(p));
          worst = Math.max(worst, performance.now() - t);
        }
        const ms = performance.now() - started;
        reader.close();
        return { ms, worst, stats: { ...videoStats } };
      },
      [software, step, Number(framesArg)] as const,
    );
    const shown = Number(framesArg);
    console.log(
      `${software ? "software" : "hardware"} step ${step}: ${shown} frames in ${result.ms.toFixed(0)} ms = ${((shown * 1000) / result.ms).toFixed(0)} shown fps` +
        ` (${result.stats.frames} decoded, convert ${(result.stats.convertMs / Math.max(1, result.stats.frames)).toFixed(1)} ms/frame, worst request ${result.worst.toFixed(0)} ms, resets ${result.stats.resets})`,
    );
  }
}
await browser.close();
await server.close();
