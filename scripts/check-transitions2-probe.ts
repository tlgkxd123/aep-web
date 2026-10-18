// Prints the straight RGBA of a transitions2 reference frame along a row, a column or at points, for working out
// the effects' formulas from After Effects' renders.
//
//   node scripts/check-transitions2-probe.ts <comp> <frame> row=<y> [from=x0] [to=x1] [step=n] [ch=a|rgba]
//   node scripts/check-transitions2-probe.ts <comp> <frame> col=<x> [from=y0] [to=y1] [step=n] [ch=a|rgba]
//   node scripts/check-transitions2-probe.ts <comp> <frame> alpha    (the alpha as a grid of digits 0-9, # = 255)
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frame, ...specs] = process.argv.slice(2);
const { width, height, data } = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const opt = (name: string, fallback: number) => {
  const s = specs.find((v) => v.startsWith(`${name}=`));
  return s ? Number(s.slice(name.length + 1)) : fallback;
};
const channels = specs.find((v) => v.startsWith("ch="))?.slice(3) ?? "rgba";
const px = (x: number, y: number) => {
  const i = (y * width + x) * 4;
  const v = Array.from(data.slice(i, i + 4));
  return channels === "a" ? String(v[3]) : v.join(",");
};
const step = opt("step", 1);
if (specs.includes("alpha")) {
  for (let y = 0; y < height; y += step) {
    let line = "";
    for (let x = 0; x < width; x += step) {
      const a = data[(y * width + x) * 4 + 3];
      line += a === 255 ? "#" : a === 0 ? "." : String(Math.min(9, Math.floor(a / 25.5)));
    }
    console.log(line);
  }
} else if (specs.some((s) => s.startsWith("row="))) {
  const y = opt("row", 0);
  const out: string[] = [];
  for (let x = opt("from", 0); x <= opt("to", width - 1); x += step) out.push(`${x}:${px(x, y)}`);
  console.log(out.join(" "));
} else if (specs.some((s) => s.startsWith("col="))) {
  const x = opt("col", 0);
  const out: string[] = [];
  for (let y = opt("from", 0); y <= opt("to", height - 1); y += step) out.push(`${y}:${px(x, y)}`);
  console.log(out.join(" "));
} else {
  for (const s of specs.filter((v) => v.includes(","))) {
    const [x, y] = s.split(",").map(Number);
    console.log(`(${x},${y}) ${px(x, y)}`);
  }
}
