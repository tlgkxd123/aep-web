// Ramp shape of Linear Color Key's Using Chroma matte (Matte view: keying_lck_hue's blue quadrant and the four keys of
// keying_lck_chroma): d^2 = w_rg (dr - dg)^2 + w_rb (dr - db)^2 + w_gb (dg - db)^2 and
// m = (d^p - (tau t)^p + c) / (kappa s), fitted with Nelder-Mead on the soft frames for p = 2 and p = 1, with c free
// or held at 0; prints the off cells per frame.
//
//   node scripts/check-keying-chroma-ramp.ts [--verbose] [--p1] [--free]
//   (KEYING_VERBOSE=<comp>@<frame>q<quadrant> prints one case's off cells)
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";
import { nelderMead } from "./check-keying-nm.ts";

const rgb = (v: number[]) => v.map((x) => x / 255);
const GREEN = [26, 204, 51];
const CASES = [
  ...[
    { n: 0, t: 0.1, s: 0.1 },
    { n: 1, t: 0.25, s: 0 },
    { n: 2, t: 0.03, s: 0.3 },
  ].map((f) => ({ ...f, comp: "keying_lck_hue", quadrant: 3, key: rgb([20, 60, 230]) })),
  ...[GREEN, [240, 128, 20], [26, 178, 166], [200, 80, 160]].flatMap((key, quadrant) =>
    [
      { n: 0, t: 0.1, s: 0.2 },
      { n: 1, t: 0.05, s: 0.4 },
    ].map((f) => ({ ...f, comp: "keying_lck_chroma", quadrant, key: rgb(key) })),
  ),
];
const data = CASES.map((f) => {
  const image = frame(f.comp, f.n);
  return keyingCells()
    .filter((c) => c.src[3] === 255)
    .map((cell) => {
      const [x, y] = cellPoint(cell, f.quadrant);
      const d = cell.src.slice(0, 3).map((v, i) => v / 255 - f.key[i]);
      return { src: cell.src, pairs: [(d[0] - d[1]) ** 2, (d[0] - d[2]) ** 2, (d[1] - d[2]) ** 2], got: pixel(image, x, y)[0] };
    });
});

function model(w: number[], p: number, pairs: number[], t: number, s: number) {
  const d = Math.sqrt(Math.max(0, pairs[0] * w[0] + pairs[1] * w[1] + pairs[2] * w[2]));
  const e = d ** p - (w[3] * t) ** p + w[5];
  return s > 0 ? Math.min(1, Math.max(0, e / (w[4] * s))) : e > 0 ? 1 : 0;
}
function cost(w: number[], p: number) {
  let sum = 0;
  CASES.forEach((f, i) => {
    if (f.s === 0) return;
    for (const c of data[i]) sum += (model(w, p, c.pairs, f.t, f.s) * 255 - c.got) ** 2;
  });
  return sum;
}

const verbose = process.argv.includes("--verbose") ? "--verbose" : process.env.KEYING_VERBOSE && `--verbose=${process.env.KEYING_VERBOSE}`;
for (const p of process.argv.includes("--p1") ? [2, 1] : [2])
  for (const free of process.argv.includes("--free") ? [false, true] : [false]) {
    const start = p === 2 ? [0.10897, 0.03785, 0.04352, 1.0099, 0.41418, 0] : [0.107, 0.037, 0.043, 1, 1, 0];
    let w = start;
    for (let round = 0; round < 3; round++)
      w = free ? nelderMead((x) => cost(x, p), w, 4000, 0.05) : [...nelderMead((x) => cost([...x, 0], p), w.slice(0, 5), 4000, 0.05), 0];
    console.log(`p=${p} c ${free ? "free" : "0"}: w ${w.slice(0, 3).map((v) => v.toFixed(5)).join(" ")} tau ${w[3].toFixed(5)} kappa ${w[4].toFixed(5)} c ${w[5].toFixed(6)}`);
    CASES.forEach((f, i) => {
      let off = 0;
      let worst = 0;
      for (const c of data[i]) {
        const e = Math.abs(model(w, p, c.pairs, f.t, f.s) * 255 - c.got);
        if (e > 3) {
          off++;
          if (verbose === "--verbose" || verbose === `--verbose=${f.comp}@${f.n}q${f.quadrant}`) console.log(`    ${c.src.join(",")} got ${c.got} model ${(model(w, p, c.pairs, f.t, f.s) * 255).toFixed(1)}`);
        }
        worst = Math.max(worst, e);
      }
      console.log(`  ${f.comp}@${f.n} q${f.quadrant}: ${off} cells off by more than 3, worst ${worst.toFixed(1)}`);
    });
  }
