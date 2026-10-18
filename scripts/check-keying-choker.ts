// Matte Choker's stages on keying_choker_alpha: blurs the source alpha (After Effects' keying_blobs) with a candidate
// kernel and tabulates After Effects' choked alpha against the blurred value, binned, with its spread; a kernel that
// matches leaves one curve (the level mapping) with little spread.
//
//   node scripts/check-keying-choker.ts <frame> <quadrant> <softness> [kernel feather|half|third]
import { frame } from "./check-keying-cells.ts";

const [n, q, softness] = process.argv.slice(2, 5).map(Number);
const kernel = process.argv[5] ?? "feather";
const [W, H] = [160, 120];
const [ox, oy] = [(q % 2) * W, Math.floor(q / 2) * H];
const src = frame("keying_blobs", 0);
const ref = frame("keying_choker_alpha", n);
const alpha = (img: typeof src, x: number, y: number) => img.data[((oy + y) * img.width + ox + x) * 4 + 3] / 255;

export function blur(values: Float64Array, s: number, rule: string, w = W, h = H): Float64Array {
  if (s <= 0) return values;
  const sigma = rule === "feather" ? 0.3985 * s + 0.443 : rule === "half" ? s / 2 : s / 3;
  const radius = rule === "feather" ? Math.ceil(s) : Math.ceil(3 * sigma);
  const k = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const total = k.reduce((a, b) => a + b);
  const pass = (from: Float64Array, dx: number, dy: number) => {
    const out = new Float64Array(from.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let i = -radius; i <= radius; i++) {
          const xx = x + dx * i;
          const yy = y + dy * i;
          sum += k[i + radius] * (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : from[yy * w + xx]);
        }
        out[y * w + x] = sum / total;
      }
    return out;
  };
  return pass(pass(values, 1, 0), 0, 1);
}

const a = new Float64Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = alpha(src, x, y);
const b = blur(a, softness, kernel);
if (process.argv.includes("--levels")) {
  // The best v = clamp((blurred - t) k + 0.5) for this case, and the pixels it leaves off by more than 3.
  let best = { t: 0, k: 0, bad: Infinity };
  for (let t = 0; t <= 1.0001; t += 0.005)
    for (let lk = 0; lk <= 9; lk += 0.05) {
      const k = Math.exp(lk);
      let bad = 0;
      for (let i = 0; i < W * H && bad < best.bad; i++) {
        const v = Math.min(1, Math.max(0, (b[i] - t) * k + 0.5));
        if (Math.abs(v * 255 - alpha(ref, i % W, Math.floor(i / W)) * 255) > 3) bad++;
      }
      if (bad < best.bad) best = { t, k, bad };
    }
  console.log(`frame ${n} quadrant ${q} softness ${softness}: t ${best.t.toFixed(3)} k ${best.k.toFixed(2)} (width ${(1 / best.k).toFixed(4)}), ${best.bad} px off`);
  process.exit(0);
}
const row = process.argv.indexOf("--row");
if (row > 0) {
  // One row of the quadrant: source alpha, blurred, After Effects' choked alpha (0-255), x from --row y x0 x1.
  const [y, x0, x1] = process.argv.slice(row + 1, row + 4).map(Number);
  const cols = Array.from({ length: x1 - x0 + 1 }, (_, i) => x0 + i);
  const fmt = (f: (x: number) => number) => cols.map((x) => String(Math.round(f(x))).padStart(4)).join("");
  console.log(`x       ${fmt((x) => x)}`);
  console.log(`source  ${fmt((x) => a[y * W + x] * 255)}`);
  console.log(`blurred ${fmt((x) => b[y * W + x] * 255)}`);
  console.log(`AE      ${fmt((x) => alpha(ref, x, y) * 255)}`);
  process.exit(0);
}
const bins = Array.from({ length: 21 }, () => [] as number[]);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const v = b[y * W + x];
    if (v <= 0.001) continue;
    bins[Math.min(20, Math.round(v * 20))].push(alpha(ref, x, y) * 255);
  }
bins.forEach((values, i) => {
  if (!values.length) return;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const spread = Math.max(...values) - Math.min(...values);
  console.log(`blurred ${(i / 20).toFixed(2)}: ${String(values.length).padStart(5)} px, AE mean ${mean.toFixed(1).padStart(6)}, spread ${spread.toFixed(0)}`);
});
