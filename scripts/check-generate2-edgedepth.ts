// Light Sweep's edge light against depth on generate2_light_sweep_edge2: for each edge of the hexagon and of its
// hole, from the edge's midpoint inwards along its normal, the light (ref green - 26) / 255 / (Edge Intensity / 50)
// at the nearest pixel centres, with the edge's facing against (sin dir, -cos dir).
//
//   node scripts/check-generate2-edgedepth.ts <frame> [samples]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const HEXAGON = [[40, 30], [95, 18], [135, 50], [120, 100], [60, 105], [25, 70]];
const HOLE = [[65, 52], [65, 72], [95, 72], [95, 52]];
const FRAMES = [
  { dir: 0, edge: 50, t: 1 },
  { dir: 45, edge: 50, t: 2 },
  { dir: 90, edge: 25, t: 4 },
  { dir: -30, edge: 50, t: 8 },
  { dir: 160, edge: 40, t: 3 },
  { dir: 0, edge: 50, t: 6 },
];
const frame = Number(process.argv[2] ?? 0);
const samples = Number(process.argv[3] ?? 14);
const { dir, edge } = FRAMES[frame];
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", "generate2_light_sweep_edge2", `frame_${String(frame).padStart(5, "0")}.tif`))));
const th = (dir * Math.PI) / 180;
const u = [Math.sin(th), -Math.cos(th)];
for (const [name, poly] of [["hex", HEXAGON], ["hole", HOLE]] as const) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // Clockwise on screen (y down): the inside is to the right of a -> b.
    const inward = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    const facing = -(inward[0] * u[0] + inward[1] * u[1]);
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const values: string[] = [];
    for (let k = 0; k < samples; k++) {
      const x = Math.floor(m[0] + inward[0] * (k + 0.5));
      const y = Math.floor(m[1] + inward[1] * (k + 0.5));
      const depth = (x + 0.5 - m[0]) * inward[0] + (y + 0.5 - m[1]) * inward[1];
      const light = (ref.data[(y * ref.width + x) * 4 + 1] - 26) / 255 / (edge / 50);
      values.push(`${depth.toFixed(1)}:${light.toFixed(2)}`);
    }
    console.log(`${name}${i} facing ${facing.toFixed(2)}  ${values.join(" ")}`);
  }
}
