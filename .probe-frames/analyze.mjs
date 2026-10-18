// One-off analysis of the reference video: dominant colours, card grid geometry, glow falloff.
// Scratch tooling for studying the reference look; not part of the app.
import { execFileSync } from "node:child_process";

const W = 1280, H = 720;
const times = process.argv.slice(2).map(Number);

function frame(t) {
  return execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", "formula720.mp4", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
}
const px = (b, x, y) => { const o = ((y | 0) * W + (x | 0)) * 3; return [b[o], b[o + 1], b[o + 2]]; };
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

for (const t of times) {
  const b = frame(t);
  const hist = new Map();
  let total = 0;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const [r, g, bl] = px(b, x, y);
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (bl >> 4);
    const e = hist.get(k) ?? [0, 0, 0, 0];
    e[0]++; e[1] += r; e[2] += g; e[3] += bl; total++;
    hist.set(k, e);
  }
  const top = [...hist.values()].sort((a, c) => c[0] - a[0]).slice(0, 8)
    .map((e) => `${hex([e[1] / e[0], e[2] / e[0], e[3] / e[0]])} ${(100 * e[0] / total).toFixed(1)}%`);

  // Luminance map on a 16x9 grid of blocks to see the overall layout.
  const bw = W / 16, bh = H / 9;
  const map = [];
  for (let by = 0; by < 9; by++) {
    const row = [];
    for (let bx = 0; bx < 16; bx++) {
      let s = 0, n = 0;
      for (let y = by * bh; y < (by + 1) * bh; y += 2) for (let x = bx * bw; x < (bx + 1) * bw; x += 2) { s += lum(px(b, x, y)); n++; }
      row.push(Math.round(s / n / 16));
    }
    map.push(row);
  }
  const chars = " .:-=+*#%@";
  console.log(`\n=== t=${t}s ===`);
  console.log("top colours:", top.join("  "));
  console.log("luma map (16x9, /16, 0-15 -> chars):");
  for (const row of map) console.log("   " + row.map((v) => chars[Math.min(9, v)]).join("") + "   " + row.join(" "));
}
