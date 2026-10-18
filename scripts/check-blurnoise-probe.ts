// Prints a region of a blurnoise reference frame (premultiplied, 0..255) and, when pixel-report.ts --dump wrote
// it, the same region of our render, for reading After Effects' kernels off the probe comps.
//
//   node scripts/check-blurnoise-probe.ts <comp> <frame> <x0> <y0> <x1> <y1> [r|g|b|a|all]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, ...rest] = process.argv.slice(2);
if (!comp || !frameArg) throw new Error("usage: node scripts/check-blurnoise-probe.ts <comp> <frame> <x0> <y0> <x1> <y1> [r|g|b|a|all]");
const frame = Number(frameArg);
const [x0, y0, x1, y1] = rest.slice(0, 4).map(Number);
const channel = rest[4] ?? "all";
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
const oursDir = join(ROOT, "ours");
const oursFile = existsSync(oursDir) ? readdirSync(oursDir).find((f) => f.startsWith(`${comp}_f${frame}_`)) : undefined;
const ours = oursFile ? new Uint8Array(readFileSync(join(oursDir, oursFile))) : undefined;

const premul = (d: Uint8Array, i: number, c: number) => (c === 3 ? d[i + 3] : Math.round((d[i + c] * d[i + 3]) / 255));
const channels = channel === "all" ? [0, 1, 2, 3] : ["rgba".indexOf(channel)];
const cell = (d: Uint8Array, x: number, y: number) =>
  channels.map((c) => String(premul(d, (y * ref.width + x) * 4, c)).padStart(3)).join(channels.length > 1 ? "," : "");

for (const [label, data] of [["ref", ref.data], ["ours", ours]] as const) {
  if (!data) continue;
  console.log(`${label} ${comp}@${frame} x ${x0}..${x1} y ${y0}..${y1} (${channel})`);
  for (let y = y0; y <= y1; y++) {
    const row: string[] = [];
    for (let x = x0; x <= x1; x++) row.push(cell(data, x, y));
    console.log(`${String(y).padStart(3)}: ${row.join(" ")}`);
  }
}
