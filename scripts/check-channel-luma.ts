// Counts, for channel_combiner_from's Luminance frame (Luminance to Red), the opaque cells each 8-bit luminance formula
// reproduces exactly.
//
//   node scripts/check-channel-luma.ts
import { cardCells, refPixel } from "./check-channel-probe.ts";

const px = refPixel("channel_combiner_from", 11);
const FORMULAS: Record<string, (r: number, g: number, b: number) => number> = {
  round601: (r, g, b) => Math.round(0.299 * r + 0.587 * g + 0.114 * b),
  halfDown601: (r, g, b) => Math.ceil(0.299 * r + 0.587 * g + 0.114 * b - 0.5),
  floor601: (r, g, b) => Math.floor(0.299 * r + 0.587 * g + 0.114 * b),
  shift8: (r, g, b) => (77 * r + 150 * g + 29 * b) >> 8,
  shift8round: (r, g, b) => (77 * r + 150 * g + 29 * b + 128) >> 8,
  shift16round: (r, g, b) => (19595 * r + 38470 * g + 7471 * b + 32768) >> 16,
  matlab: (r, g, b) => Math.round(0.2989 * r + 0.587 * g + 0.114 * b),
  via16bit: (r, g, b) => {
    const [r16, g16, b16] = [r, g, b].map((c) => Math.round((c * 32768) / 255));
    return Math.round((Math.round(0.299 * r16 + 0.587 * g16 + 0.114 * b16) * 255) / 32768);
  },
  via16bitTrunc: (r, g, b) => {
    const [r16, g16, b16] = [r, g, b].map((c) => Math.round((c * 32768) / 255));
    return Math.round((Math.floor(0.299 * r16 + 0.587 * g16 + 0.114 * b16) * 255) / 32768);
  },
};
const misses: Record<string, string[]> = {};
for (const name of Object.keys(FORMULAS)) misses[name] = [];
for (const cell of cardCells("a")) {
  if (cell.rgba[3] !== 255) continue;
  const [r, g, b] = cell.rgba;
  const got = px(cell.i * 10 + 5, cell.j * 10 + 5)[0];
  for (const [name, f] of Object.entries(FORMULAS)) if (f(r, g, b) !== got) misses[name].push(`${r},${g},${b}->${got} (${f(r, g, b)})`);
}
for (const [name, list] of Object.entries(misses)) console.log(`${name.padEnd(14)} ${list.length} misses  ${list.slice(0, 4).join("  ")}`);
