// Color Difference Key's partial mattes: each colour rotated about the grey axis by the angle that takes the key's
// hue to green (or to the nearest primary), then A = its blue and B = 1 - its green, against After Effects' views of
// keying_cdk_views (View 2/3 partial A, 4/5 partial B, 6 their screen) at default levels.
//
//   node scripts/check-keying-cdk.ts <frame> <quadrant> <key r,g,b> <view> [--verbose]
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";

const [n, q, keyArg, viewArg] = process.argv.slice(2);
const key = keyArg.split(",").map(Number);
const view = Number(viewArg);
const image = frame("keying_cdk_views", Number(n));

function hue([r, g, b]: number[]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  return ((h * 60) % 360 + 360) % 360;
}
function rotate(v: number[], degrees: number) {
  const t = (degrees * Math.PI) / 180;
  const [c, s] = [Math.cos(t), Math.sin(t)];
  const k = 1 / Math.sqrt(3);
  const dot = (v[0] + v[1] + v[2]) * k;
  const cross = [k * (v[2] - v[1]), k * (v[0] - v[2]), k * (v[1] - v[0])];
  return v.map((x, i) => x * c + cross[i] * s + k * dot * (1 - c));
}

for (const angleRule of ["exact", "primary"]) {
  const h = hue(key);
  const target = angleRule === "exact" ? h : Math.round(h / 120) * 120;
  const angle = 120 - target;
  let off = 0;
  for (const cell of keyingCells().filter((c) => c.src[3] === 255)) {
    const v = rotate(cell.src.slice(0, 3), angle).map((x) => Math.min(255, Math.max(0, x)));
    const a = v[2] / 255;
    const b = 1 - v[1] / 255;
    const model = (view <= 3 ? a : view <= 5 ? b : 1 - (1 - a) * (1 - b)) * 255;
    const [x, y] = cellPoint(cell, Number(q));
    const got = pixel(image, x, y)[0];
    if (Math.abs(model - got) > 3) {
      off++;
      if (process.argv.includes("--verbose") && off < 25) console.log(`  ${cell.src.join(",")} got ${got} model ${model.toFixed(1)}`);
    }
  }
  console.log(`${angleRule} (rotate ${angle.toFixed(2)} degrees): ${off} cells off`);
}
