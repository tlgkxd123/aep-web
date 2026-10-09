// Reads Fast Box Blur's horizontal profile on the boxblur_edge1d fixtures (64 px of
// asymmetric stripes, Repeat Edge Pixels on) and scores edge extensions per radius.
//
//   node scripts/boxblur-edge1d.ts [--print frame]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const STRIPES: [number, number, number[]][] = [[0, 8, [1, 0, 0]], [8, 16, [0, 1, 0]], [16, 40, [0, 0, 0]], [40, 48, [1, 1, 1]], [48, 64, [0, 0, 1]]];
const RADII = [4, 16, 31, 32, 40, 63, 64, 100, 200];
const N = 64;
const src = [0, 1, 2].map((k) => Float64Array.from({ length: N }, (_, x) => STRIPES.find(([a, b]) => x >= a && x < b)![2][k]));

type Edge = (i: number) => number;
const mod = (a: number, m: number) => ((a % m) + m) % m;
const EDGES: Record<string, Edge> = {
  clamp: (i) => Math.min(N - 1, Math.max(0, i)),
  mirror: (i) => (mod(i, 2 * N) < N ? mod(i, 2 * N) : 2 * N - 1 - mod(i, 2 * N)),
  mirror101: (i) => (mod(i, 2 * N - 2) < N ? mod(i, 2 * N - 2) : 2 * N - 2 - mod(i, 2 * N - 2)),
  wrap: (i) => mod(i, N),
};

function box(line: Float64Array, r: number, edge: Edge, cap: number): Float64Array {
  const rad = Math.min(r, cap);
  const out = new Float64Array(N);
  for (let p = 0; p < N; p++) {
    let s = 0;
    for (let k = -rad; k <= rad; k++) s += line[edge(p + k)];
    out[p] = s / (2 * rad + 1);
  }
  return out;
}

/** Zero-extended box (no normalization), over a domain grown by `grow` on each side. */
function zeroBox(line: Float64Array, r: number): Float64Array {
  const out = new Float64Array(line.length);
  for (let p = 0; p < line.length; p++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += line[p + k] ?? 0;
    out[p] = s / (2 * r + 1);
  }
  return out;
}

/** Models of iterated passes that average only what lies inside the layer. */
function insideModels(line: Float64Array, r: number, iterations: number): Record<string, Float64Array> {
  const grow = r * iterations;
  const pad = (v: Float64Array) => Float64Array.from({ length: N + 2 * grow }, (_, i) => (i >= grow && i < grow + N ? v[i - grow] : 0));
  const crop = (v: Float64Array) => v.subarray(grow, grow + N);
  const mask = pad(new Float64Array(N).fill(1));
  // Each pass: zero-extended box divided by the box of the layer's coverage, then cut back to the layer.
  let perPass = line;
  for (let it = 0; it < iterations; it++) {
    const num = crop(zeroBox(pad(perPass), r));
    const den = crop(zeroBox(mask, r));
    perPass = num.map((v, i) => v / den[i]);
  }
  // All passes zero-extended over a growing domain, divided once by the coverage blurred the same way.
  let num: Float64Array = pad(line);
  let den: Float64Array = mask;
  for (let it = 0; it < iterations; it++) {
    num = zeroBox(num, r);
    den = zeroBox(den, r);
  }
  const ratio = crop(num).map((v, i) => v / crop(den)[i]);
  const out: Record<string, Float64Array> = { perPass, ratio };
  // Edge pixels repeated over `extend` pixels each side, then every pass averages only the extended strip's taps.
  for (const [name, extend] of [["ext(k-1)r", (iterations - 1) * r], ["ext(k)r", iterations * r], ["ext(k-1)(r+1)", (iterations - 1) * (r + 1)]] as const) {
    const m = N + 2 * extend;
    let v = Float64Array.from({ length: m }, (_, i) => line[Math.min(N - 1, Math.max(0, i - extend))]);
    for (let it = 0; it < iterations; it++) {
      const next = new Float64Array(m);
      for (let p = 0; p < m; p++) {
        let s = 0;
        let c = 0;
        for (let k = Math.max(0, p - r); k <= Math.min(m - 1, p + r); k++) {
          s += v[k];
          c++;
        }
        next[p] = s / c;
      }
      v = next;
    }
    out[name] = v.subarray(extend, extend + N);
  }
  // Each pass writes r past its input's extent, averaging only the taps within that input; cropped at the end.
  let v = Float64Array.from(line);
  let lo = 0;
  for (let it = 0; it < iterations; it++) {
    const next = new Float64Array(v.length + 2 * r);
    for (let p = 0; p < next.length; p++) {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, p - 2 * r); k <= Math.min(v.length - 1, p); k++) {
        s += v[k];
        c++;
      }
      next[p] = s / c;
    }
    v = next;
    lo += r;
  }
  out.grow = v.subarray(lo, lo + N);
  return out;
}

const caps: Record<string, number> = { none: Infinity, "n-1": N - 1, "n/2": N / 2, "n/2-1": N / 2 - 1 };
const print = process.argv.indexOf("--print");
for (const iterations of [1, 2]) {
  RADII.forEach((r, frame) => {
    const ref = readTiff(new Uint8Array(readFileSync(framePath(`boxblur_edge1d_x${iterations}`, frame))));
    const row = (k: number) => Array.from({ length: N }, (_, x) => ref.data[(4 * ref.width + x) * 4 + k]);
    const scores: [string, number, number][] = [];
    const add = (name: string, lines: Float64Array[]) => {
      let sum = 0;
      let max = 0;
      for (let k = 0; k < 3; k++) {
        row(k).forEach((v, x) => {
          const e = Math.abs(Math.round(lines[k][x] * 255) - v);
          sum += e;
          max = Math.max(max, e);
        });
      }
      scores.push([name, sum / (3 * N), max]);
    };
    const models = src.map((line) => insideModels(line, r, iterations));
    for (const name of Object.keys(models[0])) add(`inside/${name}`, models.map((m) => m[name]));
    for (const [en, edge] of Object.entries(EDGES)) {
      for (const [cn, cap] of Object.entries(caps)) {
        add(
          `${en}/${cn}`,
          src.map((start) => {
            let line: Float64Array = start;
            for (let it = 0; it < iterations; it++) line = box(line, r, edge, cap);
            return line;
          }),
        );
      }
    }
    scores.sort((a, b) => a[1] - b[1]);
    console.log(`x${iterations} r=${r}: ${scores.slice(0, 4).map(([n, m, x]) => `${n} ${m.toFixed(2)}/${x}`).join("  ")}`);
    if (print >= 0 && Number(process.argv[print + 1]) === frame && iterations === Number(process.env.ITER ?? iterations)) {
      for (let k = 0; k < 3; k++) console.log(`  ${"RGB"[k]}: ${row(k).join(" ")}`);
      for (const name of (process.env.MODELS ?? "").split(",").filter(Boolean)) {
        console.log(`  ${name} R: ${Array.from(models[0][name], (v) => Math.round(v * 255)).join(" ")}`);
      }
    }
  });
}
