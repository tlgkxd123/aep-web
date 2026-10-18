// Numeric checks of candidate Echo Composite In Back rules against values read from After Effects'
// perspective_echo render at frame 16 (cell 4: Echo Time -2/24, 4 echoes, start 0.8, decay 0.7), along row 195
// where the tinted square's echoes overlap in different subsets (scripts/check-perspective-probe.ts). Prints each
// rule's prediction next to the reference, composited over the background.
//
//   node scripts/check-perspective-fit.ts
type V = [number, number, number, number];

const BG = [31, 41, 77];
const TEAL = [0.1, 0.7, 0.65];
const MAGENTA = [0.9, 0.2, 0.7];
const color = (t: number) => TEAL.map((v, c) => v + (MAGENTA[c] - v) * (t / 2));
const times = [0, 1, 2, 3, 4].map((k) => (16 - 2 * k) / 24);
const points: { echoes: number[]; ref: number[] }[] = [
  { echoes: [0], ref: [81, 119, 152] },
  { echoes: [0, 1], ref: [84, 131, 162] },
  { echoes: [0, 1, 2], ref: [82, 138, 164] },
  { echoes: [0, 1, 2, 3], ref: [79, 142, 165] },
  { echoes: [0, 1, 2, 3, 4], ref: [78, 146, 166] },
  { echoes: [1, 2, 3, 4], ref: [66, 134, 155] },
  { echoes: [2, 3, 4], ref: [55, 113, 135] },
  { echoes: [3, 4], ref: [45, 88, 114] },
];

const over = (src: V, dst: V): V => src.map((v, c) => v + dst[c] * (1 - src[3])) as V;
const frame = (k: number, w: number): V => [...color(times[k]).map((v) => v * w), w] as V;
const show = (v: V) => v.slice(0, 3).map((x, c) => Math.round(x * 255 + BG[c] * (1 - v[3])));

const rules: Record<string, (echoes: number[]) => V> = {
  "over, oldest on top": (echoes) => echoes.reduce<V>((s, k) => over(frame(k, 0.8 * 0.7 ** k), s), [0, 0, 0, 0]),
  "over, newest on top": (echoes) => [...echoes].reverse().reduce<V>((s, k) => over(frame(k, 0.8 * 0.7 ** k), s), [0, 0, 0, 0]),
  "lerp toward older by w/(sum)": (echoes) => {
    let s: V = [0, 0, 0, 0];
    let total = 0;
    for (const k of echoes) {
      const w = 0.8 * 0.7 ** k;
      total += w;
      const f = frame(k, 1);
      s = s.map((v, c) => v + (f[c] - v) * (w / total)) as V;
    }
    const a = 1 - echoes.reduce((p, k) => p * (1 - 0.8 * 0.7 ** k), 1);
    return [s[0] * a, s[1] * a, s[2] * a, a];
  },
  "over oldest on top, alpha 1 each": (echoes) => echoes.reduce<V>((s, k) => over([...color(times[k]).map((v) => v * 0.8 * 0.7 ** k), 0.8 * 0.7 ** k] as V, s), [0, 0, 0, 0]),
};
for (const [name, rule] of Object.entries(rules)) {
  console.log(name);
  for (const p of points) console.log(`  ${p.echoes.join("")}`.padEnd(10), show(rule(p.echoes)).join(",").padEnd(14), "ref", p.ref.join(","));
}
