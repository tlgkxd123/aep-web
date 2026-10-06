// Debug helper: prints After Effects' and our straight RGBA at comp pixels.
// Needs `node scripts/pixel-report.ts --dump` first.
//   node scripts/probe-pixels.ts <comp> <frame> x,y [x,y...]   or   <comp> <frame> row=<y> from=<x0> to=<x1>
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, ...specs] = process.argv.slice(2);
const root = resolve("refs");
const ref = readTiff(new Uint8Array(readFileSync(join(root, "frames", comp, `frame_${frame.padStart(5, "0")}.tif`))));
const oursFile = readdirSync(join(root, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`));
const ours = oursFile ? new Uint8Array(readFileSync(join(root, "ours", oursFile))) : undefined;
const at = (data: Uint8Array | undefined, x: number, y: number) => (data ? Array.from(data.slice((y * ref.width + x) * 4, (y * ref.width + x) * 4 + 4)) : []);

let points: [number, number][] = specs.filter((s) => s.includes(",")).map((s) => s.split(",").map(Number) as [number, number]);
const row = specs.find((s) => s.startsWith("row="));
if (row) {
  const y = Number(row.slice(4));
  const from = Number(specs.find((s) => s.startsWith("from="))?.slice(5) ?? 0);
  const to = Number(specs.find((s) => s.startsWith("to="))?.slice(3) ?? ref.width - 1);
  points = [];
  for (let x = from; x <= to; x++) points.push([x, y]);
}
for (const [x, y] of points) console.log(`(${x},${y}) ae=${JSON.stringify(at(ref.data, x, y))} ours=${JSON.stringify(at(ours, x, y))}`);
