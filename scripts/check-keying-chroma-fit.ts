// Joint fit of Linear Color Key's Using Chroma matte over keying_lck_hue's chroma quadrant (Matte view, blue key):
// for a 2D chroma map (u, v), m s = a du^2 + b dv^2 + 2 c du dv - tau t^2 on the soft frames, then every frame's
// cells with the fitted form.
//
//   node scripts/check-keying-chroma-fit.ts [--verbose]
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";

const COMP = "keying_lck_hue";
const QUADRANT = 3;
const KEY = [20, 60, 230].map((v) => v / 255);
const FRAMES = [
  { n: 0, t: 0.1, s: 0.1 },
  { n: 1, t: 0.25, s: 0 },
  { n: 2, t: 0.03, s: 0.3 },
];

function hexHue([r, g, b]: number[]): [number, number] {
  const max = Math.max(r, g, b);
  const c = max - Math.min(r, g, b);
  if (c === 0) return [0, 0];
  const h = max === r ? (((g - b) / c) % 6 + 6) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return [h / 6, c];
}
const polar = (h: number, c: number) => [c * Math.cos(2 * Math.PI * h), c * Math.sin(2 * Math.PI * h)];
const MAPS: Record<string, (c: number[]) => number[]> = {
  plane: ([r, g, b]) => [r - (g + b) / 2, (Math.sqrt(3) / 2) * (g - b)],
  hexPolar: (c) => polar(...hexHue(c)),
  hexagon: (c) => {
    // the chroma hexagon itself: hue sextant interpolated along the hexagon's edges
    const [h, ch] = hexHue(c);
    const s = h * 6;
    const i = Math.floor(s) % 6;
    const f = s - Math.floor(s);
    const a = polar(i / 6, ch);
    const b = polar((i + 1) / 6, ch);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  },
  hsvPolar: (c) => {
    const [h, ch] = hexHue(c);
    const max = Math.max(...c);
    return polar(h, max > 0 ? ch / max : 0);
  },
  hslPolar: (c) => {
    const [h, ch] = hexHue(c);
    const l = (Math.max(...c) + Math.min(...c)) / 2;
    return polar(h, l > 0 && l < 1 ? ch / (1 - Math.abs(2 * l - 1)) : 0);
  },
};

const cells = keyingCells().filter((c) => c.src[3] === 255);
const verbose = process.argv.includes("--verbose");
for (const [name, map] of Object.entries(MAPS)) {
  const key = map(KEY);
  const feats = (src: number[]) => {
    const [u, v] = map(src.slice(0, 3).map((x) => x / 255));
    const du = u - key[0];
    const dv = v - key[1];
    return [du * du, dv * dv, 2 * du * dv];
  };
  const X: number[][] = [];
  const y: number[] = [];
  for (const f of FRAMES.filter((f) => f.s > 0)) {
    const image = frame(COMP, f.n);
    for (const cell of cells) {
      const [px, py] = cellPoint(cell, QUADRANT);
      const m = pixel(image, px, py)[0] / 255;
      if (m <= 0.02 || m >= 0.98) continue;
      X.push([...feats(cell.src), -f.t * f.t]);
      y.push(m * f.s);
    }
  }
  const k = 4;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const v = Array.from({ length: k }, (_, i) => X.reduce((s, r, n) => s + r[i] * y[n], 0));
  for (let i = 0; i < k; i++)
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = 0; c < k; c++) A[r][c] -= f * A[i][c];
      v[r] -= f * v[i];
    }
  const w = v.map((x, i) => x / A[i][i]);
  const lines = [`${name}: a ${w[0].toFixed(5)} b ${w[1].toFixed(5)} c ${w[2].toFixed(5)} tau ${w[3].toFixed(5)}`];
  for (const f of FRAMES) {
    const image = frame(COMP, f.n);
    let off = 0;
    let worst = 0;
    for (const cell of cells) {
      const [px, py] = cellPoint(cell, QUADRANT);
      const got = pixel(image, px, py)[0];
      const q = feats(cell.src).reduce((s, x, i) => s + x * w[i], 0) - w[3] * f.t * f.t;
      const m = f.s > 0 ? Math.min(1, Math.max(0, q / f.s)) : q > 0 ? 1 : 0;
      const e = Math.abs(m * 255 - got);
      if (e > 3) {
        off++;
        if (verbose) lines.push(`  ${cell.src.join(",")} got ${got} model ${(m * 255).toFixed(1)}`);
      }
      worst = Math.max(worst, e);
    }
    lines.push(`  frame ${f.n}: ${off} cells off by more than 3, worst ${worst.toFixed(1)}`);
  }
  console.log(lines.join("\n"));
}
