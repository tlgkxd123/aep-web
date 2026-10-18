// Prints, for Color Balance probe frames that raise one red balance, After Effects' red output against the plain
// power curve over the darkest greys (8-bit input, AE output, the power's output, the toed power's output), and
// the toed power's total error. The toe replaces x^p below the point where its slope is k by the parabola through
// 0 tangent to it there.
//   node scripts/check-color2-toe.ts [--k 1.4]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff, type Image } from "./lib/tiff.ts";

const arg = process.argv.indexOf("--k");
const K = arg > 0 ? Number(process.argv[arg + 1]) : 1.4;
const read = (f: number): Image => readTiff(new Uint8Array(readFileSync(framePath("color2_probe2", f))));
const cell = (img: Image, k: number) => {
  const o = ((Math.floor(k / 16) * 8 + 4) * img.width + (k % 16) * 8 + 4) * 4;
  return img.data[o];
};
const toed = (x: number, p: number) => {
  if (p >= 1) return x ** p;
  const x0 = (K / p) ** (1 / (p - 1));
  if (x >= x0) return x ** p;
  return (2 - p) * x0 ** (p - 1) * x + (p - 1) * x0 ** (p - 2) * x * x;
};
const src = read(0);
const cases: [string, number, (x: number, pw: (x: number, p: number) => number) => number][] = [
  ["shadow +30", 40, (x, pw) => pw(x, 1.4 ** -0.3)],
  ["shadow +100", 41, (x, pw) => pw(x, 1.4 ** -1)],
  ["mid +30", 52, (x, pw) => pw(x, 2 ** -0.3)],
  ["mid +100", 53, (x, pw) => pw(x, 0.5)],
  ["high +30", 64, (x, pw) => pw(Math.min(1, x / 0.88), 1.4 ** -0.3)],
  ["high +100", 65, (x, pw) => pw(Math.min(1, x / 0.6), 1.4 ** -1)],
];
let total = 0;
for (const [name, frame, curve] of cases) {
  const out = read(frame);
  const rows: string[] = [];
  for (let k = 192; k < 208; k++) {
    const x = cell(src, k);
    const ae = cell(out, k);
    const t = curve(x / 255, toed) * 255;
    total += Math.abs(t - ae);
    rows.push(`${x}:${ae}/${(curve(x / 255, (v, p) => v ** p) * 255).toFixed(0)}/${t.toFixed(1)}`);
  }
  console.log(`${name.padEnd(12)} ${rows.join(" ")}`);
}
console.log(`k ${K}: total |toed - AE| ${total.toFixed(1)}`);
