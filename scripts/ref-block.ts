// Prints one channel of a block of reference-frame pixels as a grid (straight
// colour, or alpha), for reading stroke profiles. With --ours, prints our frame
// dumped by `node scripts/pixel-report.ts --dump` instead.
//
//   node scripts/ref-block.ts <comp@frame> <x0> <y0> <x1> <y1> [r|g|b|a] [--ours]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const ours = process.argv.includes("--ours");
const [spec, ...rest] = process.argv.slice(2).filter((a) => a !== "--ours");
const [comp, frame] = spec.split("@");
const [x0, y0, x1, y1] = rest.slice(0, 4).map(Number);
const channel = "rgba".indexOf(rest[4] ?? "a");
const t = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frame)))));
let data = t.data;
if (ours) {
  const file = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`));
  if (!file) throw new Error("dump the frame with pixel-report --dump first");
  data = new Uint8Array(readFileSync(join(ROOT, "ours", file)));
}
const header = ["    "];
for (let x = x0; x <= x1; x++) header.push(String(x).padStart(4));
console.log(header.join(""));
for (let y = y0; y <= y1; y++) {
  const row = [String(y).padStart(4)];
  for (let x = x0; x <= x1; x++) row.push(String(data[(y * t.width + x) * 4 + channel]).padStart(4));
  console.log(row.join(""));
}
