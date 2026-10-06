// Prints how After Effects stores audio-only footage items: sspc fields, the opti
// importer header, idta flags and label, for the audio files of the given projects.
//
//   node scripts/audio-footage-chunks.ts <project.aep> [...]
import { readFileSync } from "node:fs";
import { decodeSspc } from "../src/aep/decode.ts";
import { parseProject } from "../src/aep/parse.ts";
import { findChild, findList } from "../src/aep/riff.ts";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
for (const path of process.argv.slice(2)) {
  const bytes = readFileSync(path);
  const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  for (const item of project.items.values()) {
    if (item.kind !== "footage" || !item.hasAudio || item.hasVideo || !item.chunk) continue;
    const pin = findList(item.chunk, "Pin ");
    const sspc = findChild(pin, "sspc");
    const opti = findChild(pin, "opti");
    const idta = findChild(item.chunk, "idta");
    console.log(`== ${item.name} (label ${item.label})`);
    console.log(`  idta[23] = 0x${idta?.data[23].toString(16)}  sspc ${sspc?.data.length} bytes  opti ${opti?.data.length} bytes`);
    if (sspc) {
      const s = decodeSspc(sspc);
      console.log(`  format "${s.sourceFormatType}" size ${s.width}x${s.height} duration ${s.duration} fps ${s.nativeFrameRate} audio ${s.audioSampleRate} Hz alphaMode ${s.alphaModeRaw}`);
      console.log(`  sspc hex: ${hex(sspc.data)}`);
    }
    if (opti) console.log(`  opti hex: ${hex(opti.data)}`);
    console.log(`  Pin children: ${(pin?.children ?? []).map((c) => (c.type === "LIST" ? `LIST:${c.listType}` : c.type)).join(", ")}`);
  }
}
