// Maps, over the card, how far the Coons patch of a Bezier Warp (12 boundary points, layer pixels) puts each card
// point that After Effects' reference of distort2_bezier_warp shows from the pixel showing it: the mean residual per
// cell of a grid of the card's (u, v), to see whether After Effects draws the patch as a mesh.
//
//   node scripts/check-distort2-bezmap.ts <frame> <cells across> <cells down> <x,y x 12 boundary points>
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const CARD = { x: 20, y: 15, width: 120, height: 90 };
const [frameArg, nuArg, nvArg, ...rest] = process.argv.slice(2);
const [nu, nv] = [Number(nuArg), Number(nvArg)];
const pts = rest.slice(0, 12).map((s) => s.split(",").map(Number));
const frame = readTiff(new Uint8Array(readFileSync(framePath("distort2_bezier_warp", Number(frameArg)))));
const at = (x: number, y: number) => frame.data.subarray((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4);

type V = number[];
const bez = (a: V, b: V, c: V, d: V, t: number) => {
  const s = 1 - t;
  return [0, 1].map((i) => s * s * s * a[i] + 3 * s * s * t * b[i] + 3 * s * t * t * c[i] + t * t * t * d[i]);
};
const [tl, t1, t2, tr, r1, r2, br, b1, b2, bl, l1, l2] = pts;
function coons(u: number, v: number): V {
  const top = bez(tl, t1, t2, tr, u);
  const bottom = bez(bl, b2, b1, br, u);
  const left = bez(tl, l2, l1, bl, v);
  const right = bez(tr, r1, r2, br, v);
  return [0, 1].map(
    (i) =>
      (1 - v) * top[i] + v * bottom[i] + (1 - u) * left[i] + u * right[i] - ((1 - u) * (1 - v) * tl[i] + u * (1 - v) * tr[i] + (1 - u) * v * bl[i] + u * v * br[i]),
  );
}

const cells = Array.from({ length: nv }, () => Array.from({ length: nu }, () => [0, 0, 0]));
for (let y = 1; y < frame.height - 1; y++) {
  for (let x = 1; x < frame.width - 1; x++) {
    if (![at(x, y), at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].every((c) => c[3] === 255)) continue;
    const [r, g] = at(x, y);
    const [u, v] = [(r * 120) / 255 / CARD.width, (g * 90) / 255 / CARD.height];
    const q = coons(u, v);
    const cell = cells[Math.min(nv - 1, Math.floor(v * nv))][Math.min(nu - 1, Math.floor(u * nu))];
    cell[0] += q[0] - (x + 0.5 - CARD.x);
    cell[1] += q[1] - (y + 0.5 - CARD.y);
    cell[2]++;
  }
}
for (const row of cells) console.log(row.map(([dx, dy, n]) => (n ? `${(dx / n).toFixed(2).padStart(6)},${(dy / n).toFixed(2).padStart(6)}` : "      -      ")).join(" "));
