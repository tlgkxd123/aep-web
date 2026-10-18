// Compares distance-to-ellipse metrics with the distance After Effects' Ellipse implies (from its Inside to Outside
// Color ramp) on the opaque ring pixels of generate2_ellipse frame 1 (Center 80,60, 60 x 90, Thickness 20, white
// to (1, 0.2, 0.2)). Scratch tool for generateExtra.ts.
//
//   node scripts/check-generate2-ellipse.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

//   node scripts/check-generate2-ellipse.ts [frame centreX centreY width height thickness]
const [frame = 1, X = 80, Y = 60, Wd = 60, Ht = 90, T = 20] = process.argv.slice(2, 8).map(Number);
const comp = process.argv[8] ?? "generate2_ellipse";
const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`))));
const [cx, cy, a, b, h] = [X + 0.5, Y + 0.5, Wd / 2, Ht / 2, T / 2];

function euclid(x: number, y: number): number {
  const q = [Math.abs(x), Math.abs(y)];
  let th = Math.atan2(q[1] * a, q[0] * b);
  for (let i = 0; i < 30; i++) {
    const e = [a * Math.cos(th), b * Math.sin(th)];
    const de = [-a * Math.sin(th), b * Math.cos(th)];
    const v = [e[0] - q[0], e[1] - q[1]];
    const g = v[0] * de[0] + v[1] * de[1];
    const hh = de[0] * de[0] + de[1] * de[1] - (v[0] * e[0] + v[1] * e[1]);
    th = Math.min(Math.PI / 2, Math.max(0, th - g / hh));
  }
  return Math.hypot(a * Math.cos(th) - q[0], b * Math.sin(th) - q[1]);
}
const metrics: Record<string, (x: number, y: number) => number> = {
  euclid,
  radial: (x, y) => {
    const r = Math.hypot(x / a, y / b);
    return Math.abs(Math.hypot(x, y) * (1 - 1 / r));
  },
  gradR: (x, y) => {
    const r = Math.hypot(x / a, y / b);
    const g = Math.hypot(x / (a * a), y / (b * b)) / r;
    return Math.abs((r - 1) / g);
  },
  gradF: (x, y) => {
    const F = (x / a) ** 2 + (y / b) ** 2 - 1;
    const g = 2 * Math.hypot(x / (a * a), y / (b * b));
    return Math.abs(F / g);
  },
  // Distance in a space scaled so the ellipse is a circle of the mean radius, back to pixels by the local scale.
  scaledMean: (x, y) => {
    const m = Math.sqrt(a * b);
    return Math.abs(Math.hypot((x * m) / a, (y * m) / b) - m);
  },
  normalProj: (x, y) => {
    const th = Math.atan2(y * a, x * b);
    const e = [a * Math.cos(th), b * Math.sin(th)];
    const n = [Math.cos(th) / a, Math.sin(th) / b];
    const l = Math.hypot(n[0], n[1]);
    return Math.abs(((x - e[0]) * n[0] + (y - e[1]) * n[1]) / l);
  },
  newton1: (x, y) => {
    const q = [Math.abs(x), Math.abs(y)];
    let th = Math.atan2(q[1] * a, q[0] * b);
    for (let i = 0; i < 1; i++) {
      const e = [a * Math.cos(th), b * Math.sin(th)];
      const de = [-a * Math.sin(th), b * Math.cos(th)];
      const v = [e[0] - q[0], e[1] - q[1]];
      const g = v[0] * de[0] + v[1] * de[1];
      const hh = de[0] * de[0] + de[1] * de[1] - (v[0] * e[0] + v[1] * e[1]);
      th = th - g / hh;
    }
    return Math.hypot(a * Math.cos(th) - q[0], b * Math.sin(th) - q[1]);
  },
  // The point's distance to the ellipse whose radii grow by the point's own offset (r - 1) x radius.
  offsetEllipse: (x, y) => {
    const r = Math.hypot(x / a, y / b);
    let d = (r - 1) * Math.min(a, b);
    for (let i = 0; i < 40; i++) {
      const f = Math.hypot(x / (a + d), y / (b + d)) - 1;
      d += f * Math.min(a + d, b + d);
    }
    return Math.abs(d);
  },
  ...Object.fromEntries(
    Array.from({ length: 150 }, (_, i) => i + 8).flatMap((n) =>
      [0, 0.5].map((phase) => [
        `poly${n}${phase ? "h" : ""}`,
        (x: number, y: number) => {
          let best = Infinity;
          for (let k = 0; k < n; k++) {
            const t0 = (2 * Math.PI * (k + phase)) / n;
            const t1 = (2 * Math.PI * (k + 1 + phase)) / n;
            const p0 = [a * Math.cos(t0), b * Math.sin(t0)];
            const p1 = [a * Math.cos(t1), b * Math.sin(t1)];
            const s = [p1[0] - p0[0], p1[1] - p0[1]];
            const u = Math.min(1, Math.max(0, ((x - p0[0]) * s[0] + (y - p0[1]) * s[1]) / (s[0] * s[0] + s[1] * s[1])));
            best = Math.min(best, Math.hypot(x - p0[0] - u * s[0], y - p0[1] - u * s[1]));
          }
          return best;
        },
      ]),
    ),
  ),
  polarAngle: (x, y) => {
    const phi = Math.atan2(y, x);
    const e = [a * Math.cos(phi), b * Math.sin(phi)];
    return Math.hypot(x - e[0], y - e[1]);
  },
};
const rows: { x: number; y: number; d: number }[] = [];
for (let y = 0; y < ref.height; y++)
  for (let x = 0; x < ref.width; x++) {
    const i = (y * ref.width + x) * 4;
    if (ref.data[i] < 254 || ref.data[i + 3] < 255) continue;
    const t = (ref.data[i + 1] - 51) / 204;
    if (t <= 0.03 || t >= 0.97) continue;
    rows.push({ x: x + 0.5 - cx, y: y + 0.5 - cy, d: h * (1 - t) });
  }
const scores = Object.entries(metrics).map(([name, m]) => {
  let sq = 0;
  let worst = 0;
  for (const r of rows) {
    const e = m(r.x, r.y) - r.d;
    sq += e * e;
    worst = Math.max(worst, Math.abs(e));
  }
  return { name, rms: Math.sqrt(sq / rows.length), worst };
});
console.log(`${rows.length} px; euclid rms ${scores.find((s) => s.name === "euclid")!.rms.toFixed(3)}`);
for (const s of scores.sort((x, y) => x.rms - y.rms).slice(0, 6)) console.log(`${s.name.padEnd(12)} rms ${s.rms.toFixed(3)}  worst ${s.worst.toFixed(3)}`);
