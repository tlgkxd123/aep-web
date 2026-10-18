// Measures the particles of the particular suite (scripts/fixtures/build_particular.py): each row's particles lie
// on its line (y = 80, 240, 400, 560), and for every one this finds its centre along the line and averages its
// radial profiles (alpha and premultiplied colour, 0..255) over rings 0..R px out. Prints the reference's and, when
// `pixel-report.ts --suite particular --dump` wrote it, ours, with the mean absolute difference per row.
//
//   node scripts/particular-measure.ts <comp> [frame=156] [R=70] [--every] [--min-x=px] [--at=x,x,...] [--sprites=x,x,...] [--pixels=x:y,...]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [comp, frameArg = "156", rArg = "70"] = args;
const frame = Number(frameArg);
const R = Number(rArg);
const ROWS = [80, 240, 400, 560];

interface Image {
  width: number;
  height: number;
  /** Premultiplied RGBA, top row first. */
  data: Float32Array;
}

function premultiplied(straight: Uint8Array, width: number, height: number, alreadyPremultiplied: boolean): Image {
  const data = new Float32Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const a = straight[p * 4 + 3];
    for (let c = 0; c < 3; c++) data[p * 4 + c] = alreadyPremultiplied ? straight[p * 4 + c] : (straight[p * 4 + c] * a) / 255;
    data[p * 4 + 3] = a;
  }
  return { width, height, data };
}

function load(): { ref: Image; ours?: Image } {
  const tiff = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
  const ref = premultiplied(tiff.data, tiff.width, tiff.height, false);
  const dir = join(ROOT, "ours");
  const dump = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`)) : undefined;
  // The harness reads its frames back as straight alpha, as the references are.
  const ours = dump ? premultiplied(new Uint8Array(readFileSync(join(dir, dump))), tiff.width, tiff.height, false) : undefined;
  return { ref, ours };
}

/** Centres of the particles on line y: local maxima of alpha along it, at least 20 px apart. */
function centres(img: Image, y: number): number[] {
  const at = (x: number) => img.data[(y * img.width + x) * 4 + 3] + img.data[(y * img.width + x) * 4] / 1000;
  const out: number[] = [];
  for (let x = 1; x < img.width - 1; x++) {
    const v = at(x);
    if (v < 8) continue;
    let best = true;
    for (let d = -20; d <= 20 && best; d++) if (d && x + d >= 0 && x + d < img.width && at(x + d) > v) best = false;
    if (best && (!out.length || x - out[out.length - 1] > 20)) out.push(x);
  }
  return out;
}

/** The alpha-weighted centroid within `half` px of (x, y), rounded; refined twice. */
function centroid(img: Image, x: number, y: number, half: number): [number, number] {
  for (let pass = 0; pass < 2; pass++) {
    let [sx, sy, sw] = [0, 0, 0];
    for (let py = Math.max(0, y - half); py <= Math.min(img.height - 1, y + half); py++) {
      for (let px = Math.max(0, x - half); px <= Math.min(img.width - 1, x + half); px++) {
        const a = img.data[(py * img.width + px) * 4 + 3] ** 2;
        sx += px * a;
        sy += py * a;
        sw += a;
      }
    }
    if (!sw) break;
    [x, y] = [Math.round(sx / sw), Math.round(sy / sw)];
  }
  return [x, y];
}

/** Mean ring values (channel `c`) around the centroid near (x, y), rings of 1 px. */
function rings(img: Image, x0: number, y0: number, c: number): number[] {
  const [x, y] = centroid(img, x0, y0, 30);
  const sum = new Float64Array(R + 1);
  const count = new Float64Array(R + 1);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.round(Math.hypot(dx, dy));
      const px = x + dx;
      const py = y + dy;
      if (d > R || px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      sum[d] += img.data[(py * img.width + px) * 4 + c];
      count[d]++;
    }
  }
  return [...sum].map((s, i) => (count[i] ? s / count[i] : 0));
}

const fmt = (values: number[], step: number) =>
  values
    .filter((_, i) => i % step === 0)
    .map((v) => v.toFixed(0).padStart(4))
    .join("");

const { ref, ours } = load();

/**
 * Sprites (the particular_src_texture texture: red left half, green disc top right): for the particle nearest each
 * x of `--sprites x,x,...` on every row, the bounding box of alpha above 32, and the angle from the red part's
 * centroid to the green disc's (0 = pointing right, as the upright texture does; clockwise positive on screen).
 */
function sprites(img: Image, label: string, xs: number[]) {
  for (const y of ROWS) {
    const parts = xs.map((x0) => {
      let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
      const red = [0, 0, 0];
      const green = [0, 0, 0];
      for (let py = Math.max(0, y - 75); py < Math.min(img.height, y + 75); py++) {
        for (let px = Math.max(0, x0 - 74); px < Math.min(img.width, x0 + 74); px++) {
          const o = (py * img.width + px) * 4;
          const a = img.data[o + 3];
          if (a <= 32) continue;
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
          const [r, g] = [img.data[o] / a, img.data[o + 1] / a];
          const bucket = r > 0.6 && g < 0.4 ? red : g > 0.6 && r < 0.4 ? green : null;
          if (bucket) {
            bucket[0] += px;
            bucket[1] += py;
            bucket[2]++;
          }
        }
      }
      if (!Number.isFinite(minX)) return "none";
      const angle =
        red[2] && green[2] ? ((Math.atan2(green[1] / green[2] - red[1] / red[2], green[0] / green[2] - red[0] / red[2]) * 180) / Math.PI).toFixed(1) : "-";
      return `[${minX}..${maxX}]x[${minY}..${maxY}] ${maxX - minX + 1}x${maxY - minY + 1} turn ${angle}`;
    });
    console.log(`${label} row y=${y}: ${parts.join(" | ")}`);
  }
}
const pixelArg = process.argv.find((a) => a.startsWith("--pixels="));
if (pixelArg) {
  for (const spec of pixelArg.slice("--pixels=".length).split(",")) {
    const [x, y] = spec.split(":").map(Number);
    const show = (img: Image) => {
      const o = (y * img.width + x) * 4;
      const a = img.data[o + 3];
      const straight = [0, 1, 2].map((c) => (a ? (img.data[o + c] / a) * 255 : 0).toFixed(0));
      return `straight ${straight.join(",")} alpha ${a.toFixed(0)}`;
    };
    console.log(`(${x}, ${y}) ref ${show(ref)}${ours ? ` | ours ${show(ours)}` : ""}`);
  }
  process.exit(0);
}
const spriteArg = process.argv.find((a) => a.startsWith("--sprites="));
if (spriteArg) {
  const xs = spriteArg.slice("--sprites=".length).split(",").map(Number);
  sprites(ref, "ref ", xs);
  if (ours) sprites(ours, "ours", xs);
  process.exit(0);
}
const step = process.argv.includes("--every") ? 1 : Math.max(1, Math.round(R / 24));
console.log(`${comp}@${frame}: rings every ${step} px out to ${R}${ours ? "" : " (no dump of ours)"}`);
const minXArg = process.argv.find((a) => a.startsWith("--min-x="));
const minX = minXArg ? Number(minXArg.slice("--min-x=".length)) : 0;
for (const y of ROWS) {
  const atArg = process.argv.find((a) => a.startsWith("--at="));
  // Flat-topped discs have several maxima along the line: their centres can be given instead.
  const xs = atArg ? atArg.slice("--at=".length).split(",").map(Number) : centres(ref, y).filter((x) => x >= minX);
  if (!xs.length) {
    console.log(`row y=${y}: no particles`);
    continue;
  }
  const mean = (img: Image, c: number) => {
    const all = xs.map((x) => rings(img, x, y, c));
    return all[0].map((_, i) => all.reduce((s, r) => s + r[i], 0) / all.length);
  };
  const refAlpha = mean(ref, 3);
  console.log(`row y=${y}: ${xs.length} particles at x ${xs.join(", ")}`);
  console.log(`  ref  alpha ${fmt(refAlpha, step)}`);
  console.log(`  ref  red   ${fmt(mean(ref, 0), step)}`);
  if (ours) {
    const ourAlpha = mean(ours, 3);
    console.log(`  ours alpha ${fmt(ourAlpha, step)}`);
    const diff = refAlpha.reduce((s, v, i) => s + Math.abs(v - ourAlpha[i]), 0) / refAlpha.length;
    console.log(`  mean |alpha difference| over the rings: ${diff.toFixed(2)}; ours at x ${centres(ours, y).join(", ")}`);
  }
}
