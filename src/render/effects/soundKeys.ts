// Sound Keys (Trapcode) turns audio levels into keyframes; on the layer it is
// applied to, After Effects renders the plugin's own display instead of the layer:
// a blue spectrum grid, the frequency ranges and three green output bars, on
// transparency (fxextra_soundkeys). This draws the grid and bars at the positions
// measured in those renders; the text labels and range boxes are left out.
import { registerEffect } from "../registry.ts";
import { writeTarget } from "./fxextraUtil.ts";

/** Rows of the spectrum grid below the top margin, in pixels. */
const GRID_ROWS = [0, 2, 5, 9, 15, 25, 40, 62];
const BLUE = [0, 0, 255];
const BARS: [number, number[]][] = [
  [0.8, [1, 100, 1]],
  [0.85, [1, 255, 1]],
  [0.9, [1, 100, 1]],
];

registerEffect("tc Sound Keys", (input, _effect, _layer, _time, ctx) => {
  ctx.warn("Sound Keys' display is drawn as a look-alike; its labels and range boxes are left out");
  const { width, height } = input;
  const pad = ctx.pad;
  const out = ctx.pool.acquire(width + 2 * pad, height + 2 * pad);
  const data = new Uint8Array(out.width * out.height * 4);
  const set = (x: number, y: number, c: number[]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    // GL row order: row 0 is the bottom of the image.
    const o = ((out.height - 1 - pad - y) * out.width + x + pad) * 4;
    data.set([c[0], c[1], c[2], 255], o);
  };
  const top = Math.round(height * 0.1);
  const bottom = Math.round(height * 0.9);
  const rows = [...GRID_ROWS.map((r) => top + r).filter((y) => y < bottom - 1), bottom];
  const left = Math.round(width * 0.05);
  const right = Math.round(width * 0.95);
  for (const y of rows) for (let x = left; x <= right; x++) set(x, y, BLUE);
  const axis = Math.round(width * 0.1);
  for (let y = top; y <= bottom; y++) if (!rows.includes(y)) set(axis, y, [1, 1, 255]);
  const barWidth = Math.max(1, Math.round(width / 53));
  for (const [at, colour] of BARS) {
    const x0 = Math.round(width * at);
    for (let y = top; y <= bottom; y++) {
      const c = rows.includes(y) ? [0, colour[1], 255] : colour;
      for (let x = x0; x < x0 + barWidth; x++) set(x, y, c);
    }
  }
  ctx.pool.release(input.target);
  const image = { ...input, target: out };
  writeTarget(ctx, image, data);
  return image;
});
