// Edge Feather's kernel: keying_ckey_edges' top-right quadrant (Color Key, Edge Thin 0) feathers the vertical edge
// between the keyed green (x <= 299) and the unkeyed transparent strip; After Effects' alpha on the green side,
// row 60, against the step responses of candidate kernels for each frame's feather.
//
//   node scripts/check-keying-feather.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const FEATHERS = [2, 6, 15];
const EDGE = 299;

/** Step response at the k-th pixel from the edge (k = 0 the last keyed one) of normalised taps w(j), |j| <= r. */
function response(w: (j: number) => number, r: number, k: number) {
  let sum = 0;
  let part = 0;
  for (let j = -r; j <= r; j++) {
    sum += w(j);
    if (j > k) part += w(j);
  }
  return part / sum;
}
const KERNELS: Record<string, (f: number) => [(j: number) => number, number]> = {
  "gauss f/2.4 3s": (f) => [(j) => Math.exp(-(j * j) / (2 * (f / 2.4) ** 2)), Math.ceil((3 * f) / 2.4)],
  "gauss f/2.4 r=f": (f) => [(j) => Math.exp(-(j * j) / (2 * (f / 2.4) ** 2)), Math.ceil(f)],
  "gauss f/2.2 r=f": (f) => [(j) => Math.exp(-(j * j) / (2 * (f / 2.2) ** 2)), Math.ceil(f)],
  "gauss f/2 r=f": (f) => [(j) => Math.exp(-(j * j) / (2 * (f / 2) ** 2)), Math.ceil(f)],
  "tent r=f": (f) => [(j) => f + 1 - Math.abs(j), Math.ceil(f)],
  "box r=f/2 x2": (f) => {
    const r = Math.round(f / 2);
    return [(j) => Math.max(0, 2 * r + 1 - Math.abs(j)), 2 * r];
  },
};
for (const [frame, f] of FEATHERS.entries()) {
  const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", "keying_ckey_edges", `frame_${String(frame).padStart(5, "0")}.tif`))));
  const got = Array.from({ length: Math.ceil(f) + 2 }, (_, k) => ref.data[(60 * ref.width + EDGE - k) * 4 + 3]);
  console.log(`feather ${f}: AE ${got.join(" ")}`);
  for (const r of [Math.ceil(f), Math.ceil(f) + 1, Math.ceil(f * 1.25)]) {
    let best = [Infinity, 0];
    for (let s = 0.3; s < f; s += 0.01) {
      const ours = got.map((_, k) => response((j) => Math.exp(-(j * j) / (2 * s * s)), r, k) * 255);
      const e = ours.reduce((sum, v, k) => sum + (v - got[k]) ** 2, 0);
      if (e < best[0]) best = [e, s];
    }
    console.log(`  best sigma with radius ${r}: ${best[1].toFixed(2)} (feather / ${(f / best[1]).toFixed(3)}), rms ${Math.sqrt(best[0] / got.length).toFixed(2)}`);
  }
  for (const [name, make] of Object.entries(KERNELS)) {
    const [w, r] = make(f);
    const ours = got.map((_, k) => Math.round(response(w, r, k) * 255));
    const err = Math.max(...ours.map((v, k) => Math.abs(v - got[k])));
    console.log(`  ${name.padEnd(18)} ${ours.join(" ")}  worst ${err}`);
  }
}
