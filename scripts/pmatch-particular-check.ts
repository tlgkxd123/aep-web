// Compares After Effects renders of the Particular layers Particle Match creates
// (scripts/pmatch-particular.ts --aep, rendered with scripts/aerender.ts) with the
// look-alike's renders of the same frames (scripts/render-frame.ts): particles seen
// (local light peaks), total light, how the light spreads out from the stream point,
// and left/right symmetry about the mirror axis. Particle positions cannot match
// (Particular's own random generator places them); these are the statistics that
// should. Writes a sheet per pair: After Effects | look-alike, light ×3.
//
//   node scripts/pmatch-particular-check.ts <ae.tif>=<ours.png> [...] [--center x,y] [--axis x] [--sheet prefix]
import { readFileSync, writeFileSync } from "node:fs";
import { encodePng } from "./lib/png.ts";
import { decodePng } from "./lib/pmatch-png.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args.splice(at, 2)[1] : fallback;
};
const [cx, cy] = option("--center", "960,540").split(",").map(Number);
const axis = Number(option("--axis", "NaN"));
const sheet = option("--sheet", "");

interface Light {
  width: number;
  height: number;
  /** Luma over black, 0–1. */
  luma: Float32Array;
}

function lightOf(width: number, height: number, rgba: Uint8Array): Light {
  const luma = new Float32Array(width * height);
  for (let i = 0; i < luma.length; i++) {
    const a = rgba[i * 4 + 3] / 255;
    luma[i] = ((0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255) * a;
  }
  return { width, height, luma };
}

const RINGS = [0, 150, 300, 450, 600, 800, 1200];

function stats(img: Light) {
  const { width, height, luma } = img;
  let total = 0;
  let peaks = 0;
  const rings = new Float64Array(RINGS.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const v = luma[y * width + x];
      total += v;
      const r = Math.hypot(x - cx, y - cy);
      let ring = RINGS.length - 1;
      while (ring > 0 && r < RINGS[ring]) ring--;
      rings[ring] += v;
      if (v < 0.06) continue;
      // A plateau counts once: at its first pixel in scan order.
      let peak = true;
      for (let dy = -1; dy <= 1 && peak; dy++) {
        for (let dx = -1; dx <= 1 && peak; dx++) {
          if (!dx && !dy) continue;
          const n = luma[(y + dy) * width + x + dx];
          if (n > v || (n === v && (dy < 0 || (dy === 0 && dx < 0)))) peak = false;
        }
      }
      if (peak) peaks++;
    }
  }
  let symmetry = NaN;
  if (Number.isFinite(axis)) {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < Math.floor(axis); x++) {
        const mx = Math.round(2 * axis - x);
        if (mx < 0 || mx >= width) continue;
        const a = luma[y * width + x];
        const b = luma[y * width + mx];
        ab += a * b;
        aa += a * a;
        bb += b * b;
      }
    }
    symmetry = ab / Math.sqrt(aa * bb || 1);
  }
  return { total, peaks, rings: [...rings].map((v) => v / (total || 1)), symmetry };
}

const pairs = args.filter((a) => a.includes("="));
for (const [k, pair] of pairs.entries()) {
  const [aePath, oursPath] = pair.split("=");
  const ae = readTiff(new Uint8Array(readFileSync(aePath)));
  const ours = decodePng(new Uint8Array(readFileSync(oursPath)));
  const a = lightOf(ae.width, ae.height, ae.data);
  const b = lightOf(ours.width, ours.height, ours.rgba);
  const sa = stats(a);
  const sb = stats(b);
  const ring = (s: ReturnType<typeof stats>) => s.rings.map((v) => (v * 100).toFixed(0).padStart(3)).join(" ");
  console.log(`${aePath} vs ${oursPath}`);
  console.log(`  particles  AE ${String(sa.peaks).padStart(6)}  ours ${String(sb.peaks).padStart(6)}  (${((sb.peaks / Math.max(1, sa.peaks)) * 100).toFixed(0)} %)`);
  console.log(`  light      AE ${sa.total.toFixed(0).padStart(6)}  ours ${sb.total.toFixed(0).padStart(6)}  (${((sb.total / Math.max(1e-9, sa.total)) * 100).toFixed(0)} %)`);
  console.log(`  light % by distance from (${cx}, ${cy}) at ${RINGS.join(", ")} px: AE ${ring(sa)} | ours ${ring(sb)}`);
  if (Number.isFinite(axis)) console.log(`  mirror symmetry about x = ${axis}: AE ${sa.symmetry.toFixed(3)}  ours ${sb.symmetry.toFixed(3)}`);
  if (sheet) {
    const w = a.width;
    const h = a.height;
    const out = new Uint8Array(w * 2 * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w * 2; x++) {
        const src = x < w ? a : b;
        const sx = x < w ? x : x - w;
        const v = sx < src.width && y < src.height ? Math.min(255, src.luma[y * src.width + sx] * 3 * 255) : 0;
        const o = (y * w * 2 + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = x === w ? 255 : v;
        out[o + 3] = 255;
      }
    }
    writeFileSync(`${sheet}${k}.png`, encodePng(w * 2, h, out));
  }
}
