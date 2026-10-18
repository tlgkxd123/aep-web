// Difference Matte's colour distance: on keying_dmatte's matte quadrants (1 and 2), the opaque palette cells against
// the shifted palette's, how well each candidate distance and a tolerance scale explain After Effects' matte, with
// the ramp m = (d - k t) / (j s) (or with --squared (d^2 - (k t)^2) / (j s)) fitted per metric over every frame.
//
//   node scripts/check-keying-dmatte.ts [metric [--squared] [--verbose]]
//   node scripts/check-keying-dmatte.ts --hard            the threshold of the frames without softness
//   node scripts/check-keying-dmatte.ts metric --curve i  the matte against the distance in case i
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";
import { nelderMead } from "./check-keying-nm.ts";

const CASES = [
  { q: 1, n: 0, t: 15, s: 0 },
  { q: 1, n: 1, t: 5, s: 10 },
  { q: 1, n: 2, t: 30, s: 20 },
  { q: 2, n: 0, t: 2, s: 5 },
  { q: 2, n: 1, t: 50, s: 30 },
  { q: 2, n: 2, t: 10, s: 0 },
];
const luma = (c: number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const METRICS: Record<string, (a: number[], b: number[]) => number> = {
  max: (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))),
  euclid: (a, b) => Math.hypot(...a.map((v, i) => v - b[i])),
  sum: (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0),
  luma: (a, b) => Math.abs(luma(a) - luma(b)),
  euclidRgba: (a, b) => Math.hypot(...a.map((v, i) => v - b[i])),
};
const cells = keyingCells().filter((c) => (process.argv.includes("--all") || c.src[3] === 255) && c.plate.length);
if (process.argv.includes("--all")) {
  // The cells that are not opaque, in case i: source and plate (premultiplied), After Effects' matte.
  const i = Number(process.argv[process.argv.indexOf("--all") + 1]);
  const image = frame("keying_dmatte", CASES[i].n);
  for (const cell of cells.filter((c) => c.src[3] < 255)) {
    const [x, y] = cellPoint(cell, CASES[i].q);
    console.log(`#${cell.index} src ${cell.src.join(",")} plate ${cell.plate.map(Math.round).join(",")} got ${pixel(image, x, y).map(Math.round).join(",")}`);
  }
  process.exit(0);
}
const data = CASES.map((f) => {
  const image = frame("keying_dmatte", f.n);
  return cells.map((cell) => {
    const [x, y] = cellPoint(cell, f.q);
    return { src: cell.src.slice(0, 3), plate: cell.plate.slice(0, 3).map(Math.round), got: pixel(image, x, y)[0] / 255 };
  });
});
const squared = process.argv.includes("--squared");
const model = (w: number[], d: number, t: number, s: number) => {
  const e = squared ? d * d - (w[0] * t) ** 2 : d - w[0] * t;
  return s > 0 ? Math.min(1, Math.max(0, e / (w[1] * s))) : e > 0 ? 1 : 0;
};
const [only, verbose] = [process.argv[2], process.argv.includes("--verbose")];
const curve = process.argv.indexOf("--curve");
if (curve > 0) {
  // The matte against the distance for one case: --curve <case index>, as a table of distance bins.
  const i = Number(process.argv[curve + 1]);
  const rows = data[i].map((c) => ({ d: METRICS[only ?? "euclid"](c.src, c.plate), got: c.got * 255 })).sort((a, b) => a.d - b.d);
  console.log(`q${CASES[i].q}@${CASES[i].n} t ${CASES[i].t} s ${CASES[i].s}`);
  for (const r of rows) if (r.got > 0.5 && r.got < 254.5) console.log(`  d ${r.d.toFixed(2).padStart(7)}  m ${r.got.toFixed(1)}`);
  const firstKept = rows.find((r) => r.got >= 254.5);
  const lastZero = [...rows].reverse().find((r) => r.got <= 0.5);
  console.log(`  last 0 at d ${lastZero?.d.toFixed(2)}, first 255 at d ${firstKept?.d.toFixed(2)}`);
  process.exit(0);
}
if (process.argv.includes("--hard")) {
  for (const [name, metric] of Object.entries(METRICS))
    CASES.forEach((f, i) => {
      if (f.s > 0) return;
      const rows = data[i].map((c) => ({ d: metric(c.src, c.plate), keep: c.got > 0.5 })).sort((a, b) => a.d - b.d);
      let [best, at] = [Infinity, 0];
      let wrong = rows.filter((r) => !r.keep).length;
      for (let k = 0; k <= rows.length; k++) {
        if (wrong < best) [best, at] = [wrong, k];
        if (k < rows.length) wrong += rows[k].keep ? 1 : -1;
      }
      const lo = at > 0 ? rows[at - 1].d : 0;
      const hi = at < rows.length ? rows[at].d : Infinity;
      console.log(`${name} q${f.q}@${f.n} t ${f.t}: ${best} cells misplaced, threshold ${lo.toFixed(2)}..${hi.toFixed(2)} (x${(lo / f.t).toFixed(3)}..${(hi / f.t).toFixed(3)})`);
    });
  process.exit(0);
}
for (const [name, metric] of Object.entries(METRICS)) {
  if (only && name !== only) continue;
  const cost = (w: number[]) => {
    let sum = 0;
    CASES.forEach((f, i) => data[i].forEach((c) => (sum += (model(w, metric(c.src, c.plate), f.t, f.s) - c.got) ** 2)));
    return sum;
  };
  let best = [1, 1];
  let bestCost = Infinity;
  for (const k of only ? [4.37] : [0.5, 1, 1.5, 2, 2.55, 3, 4, 5])
    for (const j of only ? (squared ? [1311] : [1, 2.55, 4.4]) : [0.5, 1, 2.55, 4, 8]) {
      const w = nelderMead(cost, [k, j], 1500, 0.1);
      const c = cost(w);
      if (c < bestCost) [best, bestCost] = [w, c];
    }
  console.log(`${name}: tolerance x${best[0].toFixed(4)} softness x${best[1].toFixed(4)} cost ${bestCost.toFixed(2)}`);
  CASES.forEach((f, i) => {
    let off = 0;
    for (const c of data[i]) {
      const m = model(best, metric(c.src, c.plate), f.t, f.s);
      if (Math.abs(m - c.got) * 255 > 3) {
        off++;
        if (verbose) console.log(`    q${f.q}@${f.n} ${c.src.join(",")} vs ${c.plate.join(",")} d ${metric(c.src, c.plate).toFixed(2)} got ${(c.got * 255).toFixed(0)} model ${(m * 255).toFixed(1)}`);
      }
    }
    console.log(`  q${f.q}@${f.n} (t ${f.t} s ${f.s}): ${off}/${data[i].length} cells off`);
  });
}
