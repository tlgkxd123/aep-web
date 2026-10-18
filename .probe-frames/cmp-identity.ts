// Scratch: compare the identity render against the source render, pixel by pixel.
import { readFileSync } from "node:fs";
import { decodePng } from "../scripts/lib/png-decode.ts";

const a = decodePng(new Uint8Array(readFileSync("refs/probe/portal-cards/source.png")));
const b = decodePng(new Uint8Array(readFileSync("refs/probe/portal-cards/identity.png")));
console.log(`source ${a.width}x${a.height}  identity ${b.width}x${b.height}`);
const A = a.rgba, B = b.rgba;

const mean = (p: Uint8Array) => { let s = 0; for (let i = 0; i < p.length; i++) s += p[i]; return s / p.length; };
console.log(`mean channel: source ${mean(A).toFixed(2)}  identity ${mean(B).toFixed(2)}`);

let diff = 0, maxDiff = 0, overN = 0;
const hist = new Map();
for (let i = 0; i < A.length; i++) {
  const d = Math.abs(A[i] - B[i]);
  diff += d; maxDiff = Math.max(maxDiff, d); if (d > 3) overN++;
  hist.set(d, (hist.get(d) ?? 0) + 1);
}
console.log(`mean abs diff ${(diff / A.length).toFixed(3)}  max ${maxDiff}  channels>3: ${overN} (${((overN / A.length) * 100).toFixed(1)}%)`);

// Sample a few positions, RGBA.
for (const [x, y] of [[480, 270], [100, 100], [860, 450], [480, 60]]) {
  const o = (y * a.width + x) * 4;
  console.log(`(${x},${y}) source [${A.subarray(o, o + 4)}]  identity [${B.subarray(o, o + 4)}]`);
}
