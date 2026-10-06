// Prints the ExtraSamples tag (338) of a reference TIFF and one pixel's raw bytes.
//
//   node scripts/fxextra-tiff-tags.ts <comp> <frame>
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";

const [comp, frame] = process.argv.slice(2);
const buf = readFileSync(framePath(comp, Number(frame)));
const little = buf.toString("latin1", 0, 2) === "II";
const u16 = (o: number) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
const u32 = (o: number) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
const ifd = u32(4);
const count = u16(ifd);
for (let i = 0; i < count; i++) {
  const e = ifd + 2 + i * 12;
  const tag = u16(e);
  const type = u16(e + 2);
  const n = u32(e + 4);
  const value = type === 3 && n <= 2 ? u16(e + 8) : u32(e + 8);
  console.log(`tag ${tag} type ${type} count ${n} value ${value}`);
}
