// Scratch: alpha distribution of the transparency check's render.
import { readFileSync } from "node:fs";
import { decodePng } from "../scripts/lib/png-decode.ts";

for (const name of ["cards-transparent", "alpha-input", "identity"]) {
  const p = decodePng(new Uint8Array(readFileSync(`refs/probe/portal-cards/${name}.png`))).rgba;
  let a0 = 0, a255 = 0, mid = 0, min = 255, max = 0;
  for (let i = 3; i < p.length; i += 4) {
    const a = p[i];
    if (a === 0) a0++; else if (a === 255) a255++; else mid++;
    min = Math.min(min, a); max = Math.max(max, a);
  }
  const n = p.length / 4;
  console.log(`${name.padEnd(18)} alpha0=${((a0 / n) * 100).toFixed(1)}%  alpha255=${((a255 / n) * 100).toFixed(1)}%  mid=${((mid / n) * 100).toFixed(1)}%  min=${min} max=${max}`);
}
