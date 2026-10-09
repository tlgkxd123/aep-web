// Centroids of the pixels where one channel is >= lo and another <= hi, per frame.
//
//   node scripts/dg-centroid.ts <comp> <frames a,b,..> <channel> <lo> <otherChannel> <hi>
import { reference } from "./dg-cpu.ts";

const [comp, framesArg, chArg, loArg, otherArg, hiArg] = process.argv.slice(2);
for (const f of framesArg.split(",").map(Number)) {
  const r = reference(comp, f);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const i = (y * r.width + x) * 4;
      if (r.data[i + Number(chArg)] * 255 >= Number(loArg) && r.data[i + Number(otherArg)] * 255 <= Number(hiArg)) {
        sx += x + 0.5;
        sy += y + 0.5;
        n++;
      }
    }
  }
  console.log(`${comp}@${f}: n ${n} centroid (${(sx / n).toFixed(2)}, ${(sy / n).toFixed(2)})`);
}
