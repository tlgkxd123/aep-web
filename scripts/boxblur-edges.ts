// Fits Fast Box Blur's Repeat Edge Pixels behaviour: blurs the boxblur fixture's
// card sources on the CPU under several edge extensions and reports the error
// against the After Effects references (8-bit units, opaque layers).
//
//   node scripts/boxblur-edges.ts
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CELL_COLORS = [
  [0.95, 0.85, 0.2], [0.1, 0.2, 0.6], [0.85, 0.2, 0.25], [0.2, 0.75, 0.35],
  [0.6, 0.3, 0.8], [1.0, 1.0, 1.0], [0.05, 0.05, 0.05], [0.95, 0.55, 0.1],
  [0.3, 0.85, 0.9], [0.5, 0.5, 0.5], [0.9, 0.4, 0.7], [0.15, 0.45, 0.3],
];

type Plane = { w: number; h: number; d: Float64Array[] };

function card(w: number, h: number, cell: number): Plane {
  const cols = Math.ceil(w / cell);
  const d = [0, 1, 2].map(() => new Float64Array(w * h));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = CELL_COLORS[(Math.floor(y / cell) * cols + Math.floor(x / cell)) % CELL_COLORS.length];
      for (let k = 0; k < 3; k++) d[k][y * w + x] = Math.round(c[k] * 255) / 255;
    }
  }
  return { w, h, d };
}

type Edge = (i: number, n: number) => number;
const EDGES: Record<string, Edge> = {
  clamp: (i, n) => Math.min(n - 1, Math.max(0, i)),
  mirror: (i, n) => {
    const p = 2 * n;
    const m = ((i % p) + p) % p;
    return m < n ? m : p - 1 - m;
  },
  mirror101: (i, n) => {
    if (n === 1) return 0;
    const p = 2 * n - 2;
    const m = ((i % p) + p) % p;
    return m < n ? m : p - m;
  },
  wrap: (i, n) => ((i % n) + n) % n,
};

function pass(src: Float64Array, w: number, h: number, horizontal: boolean, r: number, edge: Edge, radiusCap: boolean): Float64Array {
  const out = new Float64Array(w * h);
  const n = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const rad = radiusCap ? Math.min(r, n - 1) : r;
  const whole = Math.floor(rad);
  const frac = rad - whole;
  const at = (l: number, i: number) => src[horizontal ? l * w + edge(i, n) : edge(i, n) * w + l];
  for (let l = 0; l < lines; l++) {
    for (let p = 0; p < n; p++) {
      let s = 0;
      for (let k = -whole; k <= whole; k++) s += at(l, p + k);
      if (frac) s += frac * (at(l, p - whole - 1) + at(l, p + whole + 1));
      out[horizontal ? l * w + p : p * w + l] = s / (2 * rad + 1);
    }
  }
  return out;
}

function blur(src: Plane, r: number, iterations: number, edge: Edge, radiusCap: boolean): Plane {
  const d = src.d.map((plane) => {
    let p = plane;
    for (let k = 0; k < iterations; k++) {
      p = pass(p, src.w, src.h, true, r, edge, radiusCap);
      p = pass(p, src.w, src.h, false, r, edge, radiusCap);
    }
    return p;
  });
  return { ...src, d };
}

/** Mean and max absolute error (0-255) over the layer's rectangle at (x0, y0) in the reference. */
function score(ours: Plane, comp: string, frame: number, x0: number, y0: number): string {
  const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
  let sum = 0;
  let max = 0;
  for (let y = 0; y < ours.h; y++) {
    for (let x = 0; x < ours.w; x++) {
      for (let k = 0; k < 3; k++) {
        const e = Math.abs(Math.round(ours.d[k][y * ours.w + x] * 255) - ref.data[((y + y0) * ref.width + x + x0) * 4 + k]);
        sum += e;
        max = Math.max(max, e);
      }
    }
  }
  return `mean ${(sum / (ours.w * ours.h * 3)).toFixed(2)} max ${max}`;
}

const cases: { comp: string; frame: number; src: Plane; r: number; it: number; at: [number, number] }[] = [
  { comp: "boxblur_huge", frame: 2, src: card(80, 60, 20), r: 400, it: 1, at: [40, 30] },
  { comp: "boxblur_user", frame: 1, src: card(160, 120, 16), r: 5, it: 5, at: [0, 0] },
  { comp: "boxblur_user", frame: 2, src: card(160, 120, 16), r: 20, it: 5, at: [0, 0] },
  { comp: "boxblur_user", frame: 3, src: card(160, 120, 16), r: 50, it: 5, at: [0, 0] },
  { comp: "boxblur_user", frame: 4, src: card(160, 120, 16), r: 100, it: 5, at: [0, 0] },
  { comp: "boxblur_repeat", frame: 0, src: card(80, 60, 20), r: 5, it: 3, at: [40, 30] },
];
for (const c of cases) {
  const results = Object.entries(EDGES).flatMap(([name, edge]) =>
    [false, true].map((cap) => `${name}${cap ? "+cap" : ""}: ${score(blur(c.src, c.r, c.it, edge, cap), c.comp, c.frame, ...c.at)}`),
  );
  console.log(`${c.comp}@${c.frame} r=${c.r} x${c.it}\n  ${results.join("\n  ")}`);
}
