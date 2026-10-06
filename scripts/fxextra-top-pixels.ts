// Lists the most opaque pixels of a reference frame (straight RGBA).
//
//   node scripts/fxextra-top-pixels.ts <comp> <frame> [count]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, count = "30"] = process.argv.slice(2);
const { width, height, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const found: { x: number; y: number; px: number[] }[] = [];
for (let p = 0; p < width * height; p++) if (data[p * 4 + 3]) found.push({ x: p % width, y: Math.floor(p / width), px: [...data.subarray(p * 4, p * 4 + 4)] });
found.sort((a, b) => b.px[3] - a.px[3]);
for (const f of found.slice(0, Number(count))) console.log(`(${f.x},${f.y}) ${f.px}`);
const colours = new Map<string, number>();
for (const f of found) colours.set(f.px.slice(0, 3).join(","), (colours.get(f.px.slice(0, 3).join(",")) ?? 0) + 1);
console.log("colours:", [...colours].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c} x${n}`).join("  "));
