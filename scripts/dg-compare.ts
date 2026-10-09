// Mean / max 8-bit difference between two deepglow images: "comp@frame" for an After Effects
// reference or "src:comp@frame" for our dumped source.
//
//   node scripts/dg-compare.ts <a> <b>
import { reference, source, type Img } from "./dg-cpu.ts";

function load(spec: string): Img {
  const isSource = spec.startsWith("src:");
  const [comp, frame] = spec.replace(/^src:/, "").split("@");
  return isSource ? source(comp, Number(frame)) : reference(comp, Number(frame));
}

const [a, b] = process.argv.slice(2).map(load);
for (let c = 0; c < 4; c++) {
  let sum = 0;
  let max = 0;
  let signed = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const d = Math.round(a.data[i * 4 + c] * 255) - Math.round(b.data[i * 4 + c] * 255);
    sum += Math.abs(d);
    signed += d;
    max = Math.max(max, Math.abs(d));
  }
  const n = a.width * a.height;
  console.log(`${"RGBA"[c]}: mean ${(sum / n).toFixed(3)} signed ${(signed / n).toFixed(3)} max ${max}`);
}
