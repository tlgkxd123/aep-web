// Fits where Light Sweep's band is centred: for each generate2_light_sweep_band frame (Add over grey 128), the
// offset of Center (in pixels) and the profile form that best give After Effects' green channel.
//
//   node scripts/check-generate2-sweep-fit.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const FRAMES = [
  { c: [80, 60], dir: 0, shape: 1, w: 50, i: 0.5 },
  { c: [80, 60], dir: 0, shape: 2, w: 40, i: 0.8 },
  { c: [80, 60], dir: 0, shape: 3, w: 30, i: 1.0 },
  { c: [70, 50], dir: 30, shape: 1, w: 20, i: 0.6 },
  { c: [90, 65], dir: 90, shape: 2, w: 60, i: 0.4 },
  { c: [80, 60], dir: -60, shape: 3, w: 25, i: 0.7 },
];
const PROFILES: Record<string, (r: number, w: number) => number> = {
  linear: (r, w) => Math.max(0, 1 - r / (2 * w)),
  linear1: (r, w) => Math.max(0, 1 - (r + 1) / (2 * w + 2)),
  smooth: (r, w) => (r >= 2 * w ? 0 : (1 + Math.cos((Math.PI * r) / (2 * w))) / 2),
  sharp: (r, w) => Math.max(0, 1 - r / (2 * w)) ** 2,
  smoothstep: (r, w) => {
    const t = Math.min(1, r / (2 * w));
    return 1 - t * t * (3 - 2 * t);
  },
};
const quantize = process.argv.includes("--floor") ? Math.floor : Math.round;

for (const [f, s] of FRAMES.entries()) {
  const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", "generate2_light_sweep_band", `frame_${String(f).padStart(5, "0")}.tif`))));
  const th = (s.dir * Math.PI) / 180;
  const n = [Math.cos(th), Math.sin(th)];
  const results: { key: string; err: number; worst: number }[] = [];
  for (const [name, profile] of Object.entries(PROFILES)) {
    for (let ox = 0; ox <= 1.5; ox += 0.25) {
      for (let oy = 0; oy <= 1.5; oy += 0.25) {
        let sq = 0;
        let worst = 0;
        let count = 0;
        for (let y = 0; y < ref.height; y += 2) {
          for (let x = 0; x < ref.width; x += 2) {
            const g = ref.data[(y * ref.width + x) * 4 + 1];
            if (g >= 254) continue;
            const r = Math.abs((x + 0.5 - s.c[0] - ox) * n[0] + (y + 0.5 - s.c[1] - oy) * n[1]);
            const ours = Math.min(255, quantize(128 + 204 * s.i * profile(r, s.w)));
            const e = ours - g;
            sq += e * e;
            worst = Math.max(worst, Math.abs(e));
            count++;
          }
        }
        results.push({ key: `${name} offset ${ox},${oy}`, err: Math.sqrt(sq / count), worst });
      }
    }
  }
  const best = process.argv.includes("--centre")
    ? results.filter((r) => r.key.endsWith("offset 0.5,0.5"))
    : results.sort((a, b) => a.err - b.err).slice(0, 3);
  console.log(`f${f} dir ${s.dir} shape ${s.shape}: ${best.map((b) => `${b.key} rms ${b.err.toFixed(2)} worst ${b.worst}`).join(" | ")}`);
}
