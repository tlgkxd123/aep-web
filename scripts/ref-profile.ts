// Prints alpha and the Inside→Outside colour fraction t across a reference row,
// against the distance from a bar axis at x = centre (straight colours, t from
// the channel with the largest Inside/Outside difference).
//
//   node scripts/ref-profile.ts <comp@frame> <row> <centre> <halfWidth> <inside r,g,b> <outside r,g,b>
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [spec, rowArg, centreArg, halfArg, insideArg, outsideArg] = process.argv.slice(2);
const [comp, frame] = spec.split("@");
const t = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
const row = Number(rowArg);
const centre = Number(centreArg);
const half = Number(halfArg);
const inside = insideArg.split(",").map(Number);
const outside = outsideArg.split(",").map(Number);
let channel = 0;
for (let c = 1; c < 3; c++) if (Math.abs(outside[c] - inside[c]) > Math.abs(outside[channel] - inside[channel])) channel = c;
for (let x = Math.ceil(centre - half); x <= Math.floor(centre + half); x++) {
  const i = (row * t.width + x) * 4;
  const a = t.data[i + 3] / 255;
  const v = t.data[i + channel] / 255;
  const frac = (v - inside[channel]) / (outside[channel] - inside[channel]);
  console.log(`x=${x} d=${(x - centre).toFixed(2).padStart(6)} alpha=${a.toFixed(3)} t=${a > 0 ? frac.toFixed(3) : "-"}  rgb=${[0, 1, 2].map((c) => t.data[i + c]).join(",")}`);
}
