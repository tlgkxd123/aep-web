// Difference Matte's Blur Before Difference: rebuilds the palette and the shifted palette from their cells, blurs
// both with a Gaussian of each deviation (edges repeated, truncated at 3 sigma), keys them at keying_dmatte quadrant
// 3's settings (tolerance 10, softness 10) and counts the pixels off After Effects' alpha by more than 3.
//
//   node scripts/check-keying-dmatte-blur.ts <frame> <blur>
import { frame, keyingCells, pixel } from "./check-keying-cells.ts";

const [n, blur] = process.argv.slice(2).map(Number);
const [W, H, CELL] = [160, 120, 4];
const cells = keyingCells();
const cols = W / CELL;
const plane = (pick: (c: (typeof cells)[number]) => number[]) => {
  const img = new Float64Array(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const cell = cells[Math.floor(y / CELL) * cols + Math.floor(x / CELL)];
      const v = cell ? pick(cell) : [0, 0, 0];
      for (let c = 0; c < 3; c++) img[(y * W + x) * 3 + c] = v[c] ?? 0;
    }
  return img;
};
const src = plane((c) => c.src);
const plate = plane((c) => (c.plate.length ? c.plate : c.src));
const alpha = (x: number, y: number) => cells[Math.floor(y / CELL) * cols + Math.floor(x / CELL)]?.src[3] ?? 0;
const ref = frame("keying_dmatte", n);

function gaussian(img: Float64Array, sigma: number, radius: number) {
  const k = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const total = k.reduce((a, b) => a + b);
  const pass = (from: Float64Array, dx: number, dy: number) => {
    const out = new Float64Array(from.length);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let i = -radius; i <= radius; i++) {
            const xx = Math.min(W - 1, Math.max(0, x + dx * i));
            const yy = Math.min(H - 1, Math.max(0, y + dy * i));
            s += k[i + radius] * from[(yy * W + xx) * 3 + c];
          }
          out[(y * W + x) * 3 + c] = s / total;
        }
    return out;
  };
  return pass(pass(img, 1, 0), 0, 1);
}

const [T, S] = [10 * 4.37, 10 * 1302.6];
const results: [string, number][] = [];
for (let sigma = 0.5; sigma <= 4; sigma += 0.125)
  for (const truncation of [2, 3])
    for (const radiusRule of ["sigma", "blur"]) {
      const radius = radiusRule === "blur" ? Math.ceil(blur) : Math.ceil(truncation * sigma);
      if (radiusRule === "blur" && truncation === 2) continue;
      const a = gaussian(src, sigma, radius);
      const b = gaussian(plate, sigma, radius);
      let bad = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          let d2 = 0;
          for (let c = 0; c < 3; c++) d2 += (a[(y * W + x) * 3 + c] - b[(y * W + x) * 3 + c]) ** 2;
          const m = Math.min(1, Math.max(0, (d2 - T * T) / S));
          const got = pixel(ref, 160 + x, 120 + y)[3] === 255 && n === 1 ? pixel(ref, 160 + x, 120 + y)[0] : pixel(ref, 160 + x, 120 + y)[3];
          if (Math.abs(got - alpha(x, y) * m) > 3) bad++;
        }
      results.push([`sigma ${sigma} radius ${radius} (${radiusRule === "blur" ? "blur" : `${truncation} sigma`})`, bad]);
    }
results.sort((a, b) => a[1] - b[1]);
for (const [label, bad] of results.slice(0, 8)) console.log(`${String(bad).padStart(6)}  ${label}`);
