// Linear Color Key's Using Hue rounds hues to 1/255 of a turn; colours whose hue falls on a half step show which
// float32 evaluation order After Effects follows. Expected from the references: 134.5, 63.5, 21.5 and 148.5 round
// down, 127.5 (cyan) rounds up.
const f = Math.fround;
const TIES: [number[], number][] = [
  [[0, 213, 255], 134],
  [[213, 255, 170], 63],
  [[85, 43, 0], 21],
  [[170, 213, 255], 148],
  [[0, 255, 255], 128],
];

function sextant([r, g, b]: number[], div: (a: number, b: number) => number): number {
  const max = Math.max(r, g, b);
  const c = f(max - Math.min(r, g, b));
  if (max === r) return div(f(g - b), c);
  if (max === g) return f(div(f(b - r), c) + 2);
  return f(div(f(r - g), c) + 4);
}
const div = (a: number, b: number) => f(a / b);
const VARIANTS: Record<string, (c: number[]) => number> = {
  turns01: (c) => f(f(sextant(c.map((v) => f(v / 255)), div) / 6) * 255),
  turns255: (c) => f(f(sextant(c, div) / 6) * 255),
  degrees: (c) => f(f(f(sextant(c.map((v) => f(v / 255)), div) * 60) / 360) * 255),
  degreesScale: (c) => f(f(sextant(c.map((v) => f(v / 255)), div) * 60) * f(255 / 360)),
  sixth: (c) => f(sextant(c.map((v) => f(v / 255)), div) * f(1 / 6) * 255),
  sixthThen255: (c) => f(f(sextant(c.map((v) => f(v / 255)), div) * f(1 / 6)) * 255),
  scale42: (c) => f(sextant(c.map((v) => f(v / 255)), div) * f(255 / 6)),
  scale42i: (c) => f(sextant(c, div) * f(255 / 6)),
};
for (const [name, h] of Object.entries(VARIANTS)) {
  const got = TIES.map(([c]) => h(c));
  const ok = TIES.every(([, want], i) => Math.round(got[i]) === want);
  console.log(`${name.padEnd(14)} ${ok ? "MATCH" : "     "} ${got.map((v) => v.toFixed(7)).join("  ")}`);
}
