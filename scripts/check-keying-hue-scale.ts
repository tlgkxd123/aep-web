// Linear Color Key, Using Hue: for integer hue scales N and rounding modes, how many opaque palette cells disagree
// with the others of their quantised hue difference on AE's matte (a scale where the matte depends on the quantised
// difference alone has none).
//
//   node scripts/check-keying-hue-scale.ts <comp> <frame> <quadrant> <key r,g,b 0-255>
import { rgbToHsl } from "../src/render/effects/keyingMath.ts";
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";

const [comp, n, quadrant, keyArg] = process.argv.slice(2);
const key = keyArg.split(",").map((v) => Number(v) / 255);
const image = frame(comp, Number(n));
const samples = keyingCells()
  .filter((c) => c.src[3] === 255)
  .map((cell) => {
    const [x, y] = cellPoint(cell, Number(quadrant));
    const out = pixel(image, x, y);
    return { h: rgbToHsl(cell.src.slice(0, 3).map((v) => v / 255))[0], m: out[3] < 255 ? 0 : Math.round(out[0]) };
  });
const kh = rgbToHsl(key)[0];
const modes: Record<string, (v: number) => number> = { floor: Math.floor, round: Math.round, ceil: Math.ceil };
const results: [number, string][] = [];
for (let N = 200; N <= 400; N++) {
  for (const [mode, q] of Object.entries(modes)) {
    const groups = new Map<number, number[]>();
    const K = q(kh * N - 1e-9);
    for (const s of samples) {
      let d = Math.abs(q(s.h * N - 1e-9) - K) % N;
      d = Math.min(d, N - d);
      groups.set(d, [...(groups.get(d) ?? []), s.m]);
    }
    let conflicts = 0;
    for (const ms of groups.values()) {
      const sorted = [...ms].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      conflicts += ms.filter((m) => Math.abs(m - median) > 1).length;
    }
    results.push([conflicts, `N=${N} ${mode}`]);
  }
}
for (const [c, label] of results.sort((a, b) => a[0] - b[0]).slice(0, 6)) console.log(`${label.padEnd(14)} conflicts ${c}`);
if (process.argv.includes("--groups")) {
  const K = Math.round(kh * 255);
  const groups = new Map<number, number[]>();
  for (const s of samples) {
    let d = Math.abs(Math.round(s.h * 255) - K) % 255;
    d = Math.min(d, 255 - d);
    groups.set(d, [...(groups.get(d) ?? []), s.m]);
  }
  for (const [d, ms] of [...groups].sort((a, b) => a[0] - b[0])) console.log(`dH=${d} m=${[...new Set(ms)].sort((a, b) => a - b).join(",")} (${ms.length})`);
  // m/255 = (dH^2 - T^2) / K is linear in dH^2: least squares over the partly keyed groups.
  const pts = [...groups].map(([d, ms]) => [d * d, ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)] / 255]).filter(([, m]) => m > 0.01 && m < 0.99);
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const ramp = 1 / slope;
  const T2 = mx - my * ramp;
  const worst = Math.max(...pts.map(([d2, m]) => Math.abs(((d2 - T2) / ramp - m) * 255)));
  console.log(`fit: T=${Math.sqrt(T2).toFixed(3)} K=${ramp.toFixed(1)} (in d units: t=${(Math.sqrt(T2) / 127.5).toFixed(4)} K=${(ramp / 127.5 ** 2).toFixed(4)}) worst ${worst.toFixed(2)}/255`);
}
