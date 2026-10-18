// Light Sweep's band over generate2_light_sweep_band's flat grey (128): the added share of the light colour (from
// green, the light's green 0.8) against the distance across the band, per frame.
//
//   node scripts/check-generate2-sweep.ts [frame] [direction-degrees cx cy]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [frame = 0, dir = 0, cx = 80, cy = 60] = process.argv.slice(2).map(Number);
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", "generate2_light_sweep_band", `frame_${String(frame).padStart(5, "0")}.tif`))));
const th = (dir * Math.PI) / 180;
const byDistance = new Map<number, number[]>();
for (let y = 0; y < ref.height; y++) {
  for (let x = 0; x < ref.width; x++) {
    const o = (y * ref.width + x) * 4;
    const share = (ref.data[o + 1] - 128) / 204;
    for (const [ox, oy, name] of [[0.5, 0.5, "c"]] as const) {
      void name;
      const dx = x + ox - cx;
      const dy = y + oy - cy;
      const d = Math.round(dx * Math.cos(th) + dy * Math.sin(th));
      if (!byDistance.has(d)) byDistance.set(d, []);
      byDistance.get(d)!.push(share);
    }
  }
}
const keys = [...byDistance.keys()].sort((a, b) => a - b);
const lines: string[] = [];
for (const d of keys) {
  const v = byDistance.get(d)!;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const spread = Math.max(...v) - Math.min(...v);
  if (process.argv.includes("--all") || Math.abs(d) % 4 === 0 || Math.abs(d) < 4) lines.push(`${d.toFixed(1).padStart(6)} ${mean.toFixed(4)} ±${spread.toFixed(3)} (${v.length})`);
}
console.log(lines.join("\n"));
