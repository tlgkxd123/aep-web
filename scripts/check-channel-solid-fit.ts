// For a Solid Composite frame of channel_solid_composite: the blend colour B After Effects' output implies (inverting
// the W3C mix of the layer at Source Opacity over the solid at Opacity), beside the W3C non-separable blends.
//
//   node scripts/check-channel-solid-fit.ts <frame> <mode: hue|saturation|color|luminosity>
import { cardCells, refPixel } from "./check-channel-probe.ts";

const [frameArg, mode] = process.argv.slice(2);
const px = refPixel("channel_solid_composite", Number(frameArg));
const sa = 0.7;
const da = 0.8;
const d: V = [0.2, 0.6, 0.9];

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

for (const cell of cardCells("a")) {
  if (cell.rgba[3] !== 255 || cell.j === 0) continue;
  const s = cell.rgba.slice(0, 3).map((v) => v / 255) as V;
  const out = px(cell.i * 10 + 5, cell.j * 10 + 5);
  const pm = [0, 1, 2].map((k) => (out[k] / 255) * (out[3] / 255));
  const implied = [0, 1, 2].map((k) => (pm[k] - (1 - da) * sa * s[k] - (1 - sa) * da * d[k]) / (sa * da)) as V;
  console.log(`${cell.i},${cell.j}  s${f(s)}  AE B${f(implied)}  w3c${f(w3c(d, s))}  swapped${f(w3c(s, d))}`);
}
