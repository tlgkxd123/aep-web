// Samples CC Spotlight's light amount k along its axis in the Light Only cell of perspective_cc_spotlight (k from the
// red channel over the background: R = bg + k (255 - bg)), next to the geometry of a source at the given height.
//
//   node scripts/check-perspective-spot.ts [height]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const height = Number(process.argv[2] ?? 50);
const offsetArg = process.argv.indexOf("--offset");
const OFFSET = offsetArg > 0 ? Number(process.argv[offsetArg + 1]) : 0.5;
const ref = readTiff(new Uint8Array(readFileSync(framePath("perspective_cc_spotlight", 0))));
const [x0, y0] = [160, 0];
const from = [30, 20];
const to = [90, 70];
const red = (x: number, y: number) => ref.data[((y0 + y) * ref.width + x0 + x) * 4];
const axis = [to[0] - from[0], to[1] - from[1], -height];
const axisLength = Math.hypot(...axis);
const pixel = (cx: number, cy: number, x: number, y: number) => Array.from(ref.data.subarray(((cy + y) * ref.width + cx + x) * 4, ((cy + y) * ref.width + cx + x) * 4 + 3));
if (process.argv.includes("--modes")) {
  // Points on known tiles of the 160x120 card: Light Add (cell 2) and Light Add+ (cell 3) against the card and k.
  const card = (x: number, y: number) => pixel(0, 0, x, y);
  for (const [x, y] of [[50, 70], [110, 70], [130, 70], [150, 70], [110, 50], [70, 90], [90, 110], [130, 110], [150, 100], [120, 40]]) {
    const k = (red(x, y) - 31) / (255 - 31);
    console.log(`(${x},${y}) k ${k.toFixed(3)}  add ${pixel(0, 120, x, y)}  add+ ${pixel(160, 120, x, y)}`);
  }
  void card;
  process.exit(0);
}
if (process.argv.includes("--edge")) {
  const angleAt = (x: number, y: number) => {
    const d = [x + OFFSET - from[0], y + OFFSET - from[1], -height];
    const dist = Math.hypot(...d);
    const cosAxis = (d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]) / (dist * axisLength);
    return [(Math.acos(Math.min(1, cosAxis)) * 180) / Math.PI, height / dist];
  };
  const lines: [number, number][][] = [
    Array.from({ length: 16 }, (_, i) => [44 + i, 60] as [number, number]),
    Array.from({ length: 16 }, (_, i) => [70, 26 + i] as [number, number]),
    Array.from({ length: 16 }, (_, i) => [56 + i, 100] as [number, number]),
  ];
  for (const line of lines) {
    for (const [x, y] of line) {
      const [angle, cosI] = angleAt(x, y);
      const k = (red(x, y) - 31) / (255 - 31);
      console.log(`(${x},${y}) angle ${angle.toFixed(2)}  cone ${(k / cosI).toFixed(3)}`);
    }
    console.log("");
  }
  process.exit(0);
}
if (process.argv.includes("--shadow")) {
  // Light Shadow (cell 0 at frame 0): From (20,10), To (80,60), Height 50 % (60 px), Intensity 75.
  for (const [x, y] of [[70, 50], [90, 70], [110, 70], [130, 70], [110, 50], [90, 90], [130, 110], [60, 30]]) {
    const d = [x + 0.5 - 20, y + 0.5 - 10, -60];
    const k = (0.75 * 60) / Math.hypot(...d);
    console.log(`(${x},${y}) k ${k.toFixed(3)}  shadow ${pixel(0, 0, x, y)}`);
  }
  process.exit(0);
}
for (let t = 0.3; t <= 2.2; t += 0.1) {
  const x = Math.round(from[0] + t * (to[0] - from[0]));
  const y = Math.round(from[1] + t * (to[1] - from[1]));
  if (x >= 160 || y >= 120) break;
  const k = (red(x, y) - 31) / (255 - 31);
  const d = [x + OFFSET - from[0], y + OFFSET - from[1], -height];
  const dist = Math.hypot(...d);
  const cosIncidence = height / dist;
  const cosAxis = (d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]) / (dist * axisLength);
  console.log(
    `t ${t.toFixed(1)} (${x},${y})  k ${k.toFixed(3)}  dist ${dist.toFixed(1)}  cosI ${cosIncidence.toFixed(3)}  angle ${((Math.acos(Math.min(1, cosAxis)) * 180) / Math.PI).toFixed(1)}  k/cosI ${(k / cosIncidence).toFixed(3)}`,
  );
}
