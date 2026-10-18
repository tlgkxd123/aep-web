// Tests a model of Bezier Warp against a distort2 reference: decodes where each opaque output pixel sampled the card
// (see check-distort2-probe.ts), maps that card point through the model's patch, and prints how far it lands from
// the pixel, by model. The models: the Coons patch of the four boundary curves, and the bicubic Bezier patch whose
// inner control points the boundary implies.
//
//   node scripts/check-distort2-bezier.ts <frame> <x,y x 12 boundary points> [shift]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CARD = { x: 20, y: 15, width: 120, height: 90 };
const [frameArg, ...rest] = process.argv.slice(2);
const pts = rest.slice(0, 12).map((s) => s.split(",").map(Number));
const shift = Number(rest[12] ?? 0);
const frame = readTiff(new Uint8Array(readFileSync(framePath("distort2_bezier_warp", Number(frameArg)))));
const at = (img: typeof frame, x: number, y: number) => img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
const linear = (n: number) => Array.from({ length: n }, (_, i) => (255 * (i + 0.5)) / n);
const card = process.env.DISTORT2_LINEAR ? null : readTiff(new Uint8Array(readFileSync(framePath("distort2_card", 0))));
const redAlong = card ? Array.from({ length: CARD.width }, (_, x) => at(card, CARD.x + x, CARD.y + 45)[0]) : linear(CARD.width);
const greenAlong = card ? Array.from({ length: CARD.height }, (_, y) => at(card, CARD.x + 1, CARD.y + y)[1]) : linear(CARD.height);
function invert(ramp: number[], v: number): number {
  if (v <= ramp[0]) return 0.5 - (ramp[0] - v) / Math.max(1, ramp[1] - ramp[0]);
  for (let i = 1; i < ramp.length; i++) if (v <= ramp[i]) return i - 0.5 + (v - ramp[i - 1]) / Math.max(1e-9, ramp[i] - ramp[i - 1]);
  const n = ramp.length;
  return n - 0.5 + (v - ramp[n - 1]) / Math.max(1, ramp[n - 1] - ramp[n - 2]);
}

type V = number[];
const add = (a: V, b: V, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
const scale = (a: V, k: number) => [a[0] * k, a[1] * k];
const bez = (a: V, b: V, c: V, d: V, t: number) => {
  const s = 1 - t;
  return [0, 1].map((i) => s * s * s * a[i] + 3 * s * s * t * b[i] + 3 * s * t * t * c[i] + t * t * t * d[i]);
};
// Boundary: TL, top tangents, TR, right tangents, BR, bottom tangents (from the right), BL, left tangents (from below).
const [tl, t1, t2, tr, r1, r2, br, b1, b2, bl, l1, l2] = pts.map((v) => [v[0] + shift, v[1] + shift]);
const top = (u: number) => bez(tl, t1, t2, tr, u);
const bottom = (u: number) => bez(bl, b2, b1, br, u);
const left = (v: number) => bez(tl, l2, l1, bl, v);
const right = (v: number) => bez(tr, r1, r2, br, v);

function coons(u: number, v: number): V {
  const ruled = add(add(scale(top(u), 1 - v), bottom(u), v), add(scale(left(v), 1 - u), right(v), u));
  const corners = add(add(scale(tl, (1 - u) * (1 - v)), tr, u * (1 - v)), add(scale(bl, (1 - u) * v), br, u * v));
  return add(ruled, corners, -1);
}

// Inner control points of the bicubic patch: each the Coons rule applied to the control net.
const net: V[][] = [
  [tl, t1, t2, tr],
  [l2, [0, 0], [0, 0], r1],
  [l1, [0, 0], [0, 0], r2],
  [bl, b2, b1, br],
];
for (const i of [1, 2]) {
  for (const j of [1, 2]) {
    const u = j / 3;
    const v = i / 3;
    const ruled = add(add(scale(net[0][j], 1 - v), net[3][j], v), add(scale(net[i][0], 1 - u), net[i][3], u));
    const corners = add(add(scale(tl, (1 - u) * (1 - v)), tr, u * (1 - v)), add(scale(bl, (1 - u) * v), br, u * v));
    net[i][j] = add(ruled, corners, -1);
  }
}
const bern = (t: number) => [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3];
export function bicubic(u: number, v: number): V {
  const bu = bern(u);
  const bv = bern(v);
  let p = [0, 0];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) p = add(p, net[i][j], bv[i] * bu[j]);
  return p;
}

// The boundary curves taken at a fraction of their arc length instead of their Bezier parameter.
function byLength(curve: (t: number) => V): (s: number) => V {
  const steps = 512;
  const lengths = [0];
  let prev = curve(0);
  for (let i = 1; i <= steps; i++) {
    const q = curve(i / steps);
    lengths.push(lengths[i - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1]));
    prev = q;
  }
  return (s: number) => {
    const target = s * lengths[steps];
    let i = 1;
    while (i < steps && lengths[i] < target) i++;
    const f = (target - lengths[i - 1]) / Math.max(1e-12, lengths[i] - lengths[i - 1]);
    return curve((i - 1 + f) / steps);
  };
}
const [topL, bottomL, leftL, rightL] = [byLength(top), byLength(bottom), byLength(left), byLength(right)];
export function arc(u: number, v: number): V {
  const ruled = add(add(scale(topL(u), 1 - v), bottomL(u), v), add(scale(leftL(v), 1 - u), rightL(v), u));
  const corners = add(add(scale(tl, (1 - u) * (1 - v)), tr, u * (1 - v)), add(scale(bl, (1 - u) * v), br, u * v));
  return add(ruled, corners, -1);
}

// Bicubic patch whose inner points complete each corner's parallelogram (no twist at the corners).
const twistNet: V[][] = net.map((row) => row.map((v) => [...v]));
twistNet[1][1] = add(add(twistNet[0][1], twistNet[1][0]), twistNet[0][0], -1);
twistNet[1][2] = add(add(twistNet[0][2], twistNet[1][3]), twistNet[0][3], -1);
twistNet[2][1] = add(add(twistNet[3][1], twistNet[2][0]), twistNet[3][0], -1);
twistNet[2][2] = add(add(twistNet[3][2], twistNet[2][3]), twistNet[3][3], -1);
function twist(u: number, v: number): V {
  const bu = bern(u);
  const bv = bern(v);
  let p = [0, 0];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) p = add(p, twistNet[i][j], bv[i] * bu[j]);
  return p;
}

// A surface drawn as a mesh of N x N cells (N = MESH, default 8), each cell bilinear or split into two triangles.
const N = Number(process.env.MESH ?? 8);
function mesh(surface: (u: number, v: number) => V, triangles: boolean) {
  const nodes = Array.from({ length: N + 1 }, (_, j) => Array.from({ length: N + 1 }, (_, i) => surface(i / N, j / N)));
  return (u: number, v: number): V => {
    const i = Math.min(N - 1, Math.floor(u * N));
    const j = Math.min(N - 1, Math.floor(v * N));
    const [a, b] = [u * N - i, v * N - j];
    const [p00, p10, p01, p11] = [nodes[j][i], nodes[j][i + 1], nodes[j + 1][i], nodes[j + 1][i + 1]];
    if (!triangles) return add(scale(add(scale(p00, 1 - a), p10, a), 1 - b), add(scale(p01, 1 - a), p11, a), b);
    if (a + b <= 1) return add(add(p00, add(p10, p00, -1), a), add(p01, p00, -1), b);
    return add(add(p11, add(p01, p11, -1), 1 - a), add(p10, p11, -1), 1 - b);
  };
}

const models = {
  coons,
  twist,
  coonsMesh: mesh(coons, false),
  twistMesh: mesh(twist, false),
  coonsTri: mesh(coons, true),
  twistTri: mesh(twist, true),
};
for (const [name, model] of Object.entries(models)) {
  let n = 0;
  let sum = 0;
  let worst = 0;
  const bias = [0, 0];
  for (let y = 0; y < frame.height - CARD.y; y++) {
    for (let x = -CARD.x; x < frame.width - CARD.x; x++) {
      if (y + CARD.y < 0) continue;
      const [r, g, , a] = at(frame, CARD.x + x, CARD.y + y);
      if (a < 255) continue;
      const sx = invert(redAlong, r);
      const sy = invert(greenAlong, g);
      if (sx < 2 || sy < 2 || sx > CARD.width - 2 || sy > CARD.height - 2) continue;
      const q = model(sx / CARD.width, sy / CARD.height);
      const e = [q[0] - (x + 0.5), q[1] - (y + 0.5)];
      const d = Math.hypot(e[0], e[1]);
      n++;
      sum += d;
      bias[0] += e[0];
      bias[1] += e[1];
      worst = Math.max(worst, d);
    }
  }
  console.log(`${name.padEnd(8)} n ${n}  mean ${(sum / n).toFixed(3)}  worst ${worst.toFixed(2)}  bias ${(bias[0] / n).toFixed(3)},${(bias[1] / n).toFixed(3)}`);
}
