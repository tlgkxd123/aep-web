// Measure the reference card grid: edge positions, pitch, and per-card brightness.
// Scratch tooling for studying the reference look; not part of the app.
import { execFileSync } from "node:child_process";

const W = 1280, H = 720;

function frame(t) {
  return execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", "formula720.mp4", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
}
const px = (b, x, y) => { const o = ((y | 0) * W + (x | 0)) * 3; return [b[o], b[o + 1], b[o + 2]]; };
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Vertical-edge response: |d/dx| of luma averaged over a band of rows.
function columnEdges(b, y0, y1) {
  const out = new Float64Array(W);
  for (let y = y0; y < y1; y++) {
    for (let x = 1; x < W - 1; x++) {
      out[x] += Math.abs(lum(px(b, x + 1, y)) - lum(px(b, x - 1, y)));
    }
  }
  const n = y1 - y0;
  for (let x = 0; x < W; x++) out[x] /= n;
  return out;
}

function rowEdges(b, x0, x1) {
  const out = new Float64Array(H);
  for (let x = x0; x < x1; x++) {
    for (let y = 1; y < H - 1; y++) {
      out[y] += Math.abs(lum(px(b, x, y + 1)) - lum(px(b, x, y - 1)));
    }
  }
  const n = x1 - x0;
  for (let y = 0; y < H; y++) out[y] /= n;
  return out;
}

// Find peak positions with a simple local-max + non-max suppression by distance.
function peaks(arr, minVal, minDist) {
  const idx = [...arr.keys()].filter((i) => arr[i] >= minVal).sort((a, c) => arr[c] - arr[a]);
  const taken = [];
  for (const i of idx) {
    if (taken.every((t) => Math.abs(t - i) >= minDist)) taken.push(i);
  }
  return taken.sort((a, c) => a - c);
}

function gaps(p) {
  const g = [];
  for (let i = 1; i < p.length; i++) g.push(p[i] - p[i - 1]);
  return g;
}

for (const t of process.argv.slice(2).map(Number)) {
  const b = frame(t);
  const ce = columnEdges(b, 120, 600);
  const re = rowEdges(b, 200, 1080);
  const cp = peaks(ce, 18, 12);
  const rp = peaks(re, 18, 12);
  console.log(`\n=== t=${t}s ===`);
  console.log("column edge peaks:", cp.join(","));
  console.log("  gaps:", gaps(cp).join(","));
  console.log("  median gap:", gaps(cp).sort((a, c) => a - c)[Math.floor(gaps(cp).length / 2)]);
  console.log("row edge peaks:", rp.join(","));
  console.log("  gaps:", gaps(rp).join(","));
  console.log("  median gap:", gaps(rp).sort((a, c) => a - c)[Math.floor(gaps(rp).length / 2)]);
}
