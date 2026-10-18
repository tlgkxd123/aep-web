// Measures CS HexTile's cells on a UV card (stylize2_hextile_uv): for every pixel of the layer, the hexagonal
// distance (flat-top: max(|y|, (√3|x| + |y|) / 2)) to the nearest centre of the lattice Center + i (√3 R, R) +
// j (0, 2R), the ranges of that distance over drawn, partly drawn and transparent pixels, and with --cells which
// symmetry of the hexagon maps each cell's offsets to the source's offsets from Center.
//
//   node scripts/check-stylize2-hextile.ts <comp> <frame> <layer x> <layer y> <layer w> <layer h> <center x> <center y> <radius> [--cells]
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [lx, ly, lw, lh, cx, cy, r] = rest.map(Number);
const img = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
const s3 = Math.sqrt(3);
let drawnMax = 0;
let clearMin = Infinity;
const partial: string[] = [];
const cells = new Map<string, number[][]>();
for (let y = 0; y < lh; y++) {
  for (let x = 0; x < lw; x++) {
    const px = x + 0.5 - cx;
    const py = y + 0.5 - cy;
    let best = { d: Infinity, ox: 0, oy: 0, key: "" };
    const i0 = Math.round(px / (s3 * r));
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      const j0 = Math.round((py - i * r) / (2 * r));
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        const ox = px - i * s3 * r;
        const oy = py - i * r - j * 2 * r;
        const d = Math.max(Math.abs(oy), (s3 * Math.abs(ox) + Math.abs(oy)) / 2);
        if (d < best.d) best = { d, ox, oy, key: `${i},${j}` };
      }
    }
    const k = ((ly + y) * img.width + lx + x) * 4;
    const a = img.data[k + 3];
    if (a > 250) {
      drawnMax = Math.max(drawnMax, best.d);
      if (best.d < r - 2) {
        const list = cells.get(best.key) ?? [];
        list.push([best.ox, best.oy, (img.data[k] / 255) * lw - cx, (img.data[k + 1] / 255) * lh - cy]);
        cells.set(best.key, list);
      }
    } else if (a < 5) clearMin = Math.min(clearMin, best.d);
    else partial.push(`${best.d.toFixed(2)}:${a}`);
  }
}
console.log(`drawn up to hex distance ${drawnMax.toFixed(2)}, transparent from ${clearMin.toFixed(2)}`);
console.log(`partial (distance:alpha): ${partial.slice(0, 16).join(" ")} (${partial.length})`);

const sym: [string, number[]][] = [];
for (let k = 0; k < 6; k++) {
  const a = (k * Math.PI) / 3;
  sym.push([`rot${k * 60}`, [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)]]);
  sym.push([`mirror${k * 30}`, [Math.cos(a), Math.sin(a), Math.sin(a), -Math.cos(a)]]);
}
if (process.argv.includes("--sectors")) {
  for (const key of ["0,0", "1,0", "0,1"]) {
    const bySector = new Map<number, number[][]>();
    for (const e of cells.get(key) ?? []) {
      const s = Math.floor((((Math.atan2(e[1], e[0]) * 180) / Math.PI + 360) % 360) / 30);
      bySector.set(s, [...(bySector.get(s) ?? []), e]);
    }
    const line: string[] = [];
    for (const [s, list] of [...bySector].sort((a, b) => a[0] - b[0])) {
      const scores = sym.map(([name, m]) => [name, list.filter(([ox, oy, ux, uy]) => Math.hypot(m[0] * ox + m[1] * oy - ux, m[2] * ox + m[3] * oy - uy) < 1.6).length / list.length] as const);
      scores.sort((a, b) => b[1] - a[1]);
      line.push(`${s * 30}°:${scores[0][0]} ${(scores[0][1] * 100).toFixed(0)}%`);
    }
    console.log(`cell ${key} sectors: ${line.join("  ")}`);
  }
}
for (const [key, list] of [...cells].sort()) {
  const scores = sym.map(([name, m]) => {
    const fits = list.filter(([ox, oy, ux, uy]) => Math.hypot(m[0] * ox + m[1] * oy - ux, m[2] * ox + m[3] * oy - uy) < 1.6).length;
    return [name, fits / list.length] as const;
  });
  scores.sort((a, b) => b[1] - a[1]);
  if (process.argv.includes("--cells") || key === "0,0") console.log(`cell ${key}: ${scores.slice(0, 2).map(([n, s]) => `${n} ${(s * 100).toFixed(0)}%`).join(", ")} (${list.length})`);
}
