// Sound Keys (Trapcode) turns audio levels into keyframes; on the layer it is
// applied to, After Effects renders the plugin's own display instead of the layer:
// a blue spectrum grid, the frequency ranges and three green output bars, on
// transparency (fxextra_soundkeys). This draws the grid and bars at the positions
// measured in those renders; the text labels and range boxes are left out.
import { registerEffect } from "../registry.ts";

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
  const gl = ctx.gl;
  // `acquire` leaves the cleared target bound with its viewport set.
  const out = ctx.pool.acquire(width + 2 * pad, height + 2 * pad);
  /** Fills image pixels x0..x1, y0..y1 (inclusive, top-left origin) with an opaque 8-bit colour. */
  const fill = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
    const left = Math.max(0, x0);
    const right = Math.min(width - 1, x1);
    const upper = Math.max(0, y0);
    const lower = Math.min(height - 1, y1);
    if (left > right || upper > lower) return;
    // GL row order: row 0 is the bottom of the image.
    gl.scissor(left + pad, out.height - 1 - pad - lower, right - left + 1, lower - upper + 1);
    gl.clearColor(c[0] / 255, c[1] / 255, c[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };
  const top = Math.round(height * 0.1);
  const bottom = Math.round(height * 0.9);
  const rows = [...GRID_ROWS.map((r) => top + r).filter((y) => y < bottom - 1), bottom];
  const left = Math.round(width * 0.05);
  const right = Math.round(width * 0.95);
  const axis = Math.round(width * 0.1);
  const barWidth = Math.max(1, Math.round(width / 53));
  gl.enable(gl.SCISSOR_TEST);
  // The axis runs between the grid rows, which stay blue where they cross it.
  fill(axis, top, axis, bottom, [1, 1, 255]);
  for (const y of rows) fill(left, y, right, y, BLUE);
  for (const [at, colour] of BARS) {
    const x0 = Math.round(width * at);
    fill(x0, top, x0 + barWidth - 1, bottom, colour);
    for (const y of rows) if (y >= top && y <= bottom) fill(x0, y, x0 + barWidth - 1, y, [0, colour[1], 255]);
  }
  gl.disable(gl.SCISSOR_TEST);
  ctx.pool.release(input.target);
  return { ...input, target: out };
});
