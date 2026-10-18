// For a CC Composite cell of channel_cc_composite_alpha_*: the blend colour B After Effects' output implies (inverting
// the source-over mix of the original at 70 % over Set Channels' result), beside the W3C non-separable blend.
//
//   node scripts/check-channel-ccfit.ts <comp> <cell> <mode: hue|saturation|color|luminosity> [--rgb-only]
import { cardCells, refPixel } from "./check-channel-probe.ts";

const [comp, cellArg, mode] = process.argv.slice(2);
const rgbOnly = process.argv.includes("--rgb-only");
const n = Number(cellArg);
const at = [100 * (n % 4), 80 * Math.floor(n / 4)];
const px = refPixel(comp, 0);
const opacity = 0.7;

type V = [number, number, number];
const lum = (c: V) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const sat = (c: V) => Math.max(...c) - Math.min(...c);
function clip(c: V): V {
  const l = lum(c);
  const lo = Math.min(...c);
  const hi = Math.max(...c);
  let r = c;
  if (lo < 0) r = r.map((v) => l + ((v - l) * l) / (l - lo)) as V;
  if (hi > 1) r = r.map((v) => l + ((v - l) * (1 - l)) / (hi - l)) as V;
  return r;
}
const setLum = (c: V, l: number) => clip(c.map((v) => v + l - lum(c)) as V);
function setSat(c: V, s: number): V {
  const lo = Math.min(...c);
  const hi = Math.max(...c);
  return hi <= lo ? [0, 0, 0] : (c.map((v) => ((v - lo) * s) / (hi - lo)) as V);
}
function w3c(b: V, s: V): V {
  if (mode === "hue") return setLum(setSat(s, sat(b)), lum(b));
  if (mode === "saturation") return setLum(setSat(b, sat(s)), lum(b));
  if (mode === "color") return setLum(s, lum(b));
  return setLum(b, lum(s));
}
const f = (c: V) => c.map((v) => (v * 255).toFixed(1).padStart(6)).join("");
const scale = (c: V, k: number) => c.map((v) => v * k) as V;

/** Candidate premultiplied outputs from the original s (straight, at opacity) and the result b (straight, coverage ca). */
const MODELS: Record<string, (s: V, b: V, ca: number) => V> = {
  w3c: (s, b, ca) => [0, 1, 2].map((k) => (1 - ca) * opacity * s[k] + (1 - opacity) * ca * b[k] + opacity * ca * w3c(b, s)[k]) as V,
  premulBlend: (s, b, ca) => {
    const B = w3c(scale(b, ca), scale(s, opacity));
    return [0, 1, 2].map((k) => (1 - ca) * opacity * s[k] + (1 - opacity) * ca * b[k] + B[k]) as V;
  },
  premulBlendScaled: (s, b, ca) => {
    const B = w3c(scale(b, ca), scale(s, opacity));
    return [0, 1, 2].map((k) => (1 - ca) * opacity * s[k] + (1 - opacity) * ca * b[k] + B[k] * ca * opacity) as V;
  },
  overBlack: (s, b, ca) => {
    const B = w3c(scale(b, ca), s);
    return [0, 1, 2].map((k) => (1 - ca) * opacity * s[k] + (1 - opacity) * ca * b[k] + opacity * ca * B[k]) as V;
  },
  mixAfter: (s, b, ca) => {
    const B = w3c(scale(b, ca), s);
    return [0, 1, 2].map((k) => opacity * B[k] + (1 - opacity) * ca * b[k]) as V;
  },
};

if (process.argv.includes("--models")) {
  for (const [name, model] of Object.entries(MODELS)) {
    let worst = 0;
    let sum = 0;
    let count = 0;
    for (const cell of cardCells("b")) {
      if (cell.rgba[3] !== 255) continue;
      const s = cell.rgba.slice(0, 3).map((v) => v / 255) as V;
      const ca = Math.round(0.299 * cell.rgba[0] + 0.587 * cell.rgba[1] + 0.114 * cell.rgba[2]) / 255;
      const b: V = [s[2], s[0], s[1]];
      const out = px(at[0] + cell.i * 10 + 5, at[1] + cell.j * 10 + 5);
      const a = opacity + ca * (1 - opacity);
      const pm = [0, 1, 2].map((k) => (out[k] / 255) * (rgbOnly ? a : out[3] / 255));
      const mine = model(s, b, ca).map((v) => Math.min(a, Math.max(0, v)));
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(mine[k] - pm[k]) * 255;
        worst = Math.max(worst, d);
        sum += d;
        count++;
      }
    }
    console.log(`${name.padEnd(20)} worst ${worst.toFixed(1)}  mean ${(sum / count).toFixed(2)}`);
  }
  process.exit(0);
}

for (const cell of cardCells("b")) {
  if (cell.rgba[3] !== 255) continue;
  const s = cell.rgba.slice(0, 3).map((v) => v / 255) as V;
  const ca = Math.round(0.299 * cell.rgba[0] + 0.587 * cell.rgba[1] + 0.114 * cell.rgba[2]) / 255;
  const b: V = [s[2], s[0], s[1]];
  const out = px(at[0] + cell.i * 10 + 5, at[1] + cell.j * 10 + 5);
  const a = opacity + ca * (1 - opacity);
  const pm = [0, 1, 2].map((k) => (out[k] / 255) * (rgbOnly ? a : out[3] / 255));
  const implied = [0, 1, 2].map((k) => (pm[k] - (1 - ca) * opacity * s[k] - (1 - opacity) * ca * b[k]) / (opacity * ca)) as V;
  console.log(`${cell.i},${cell.j}  s${f(s)}  b${f(b)} a ${(ca * 255).toFixed(0)}  AE B${f(implied)}  w3c${f(w3c(b, s))}`);
}
