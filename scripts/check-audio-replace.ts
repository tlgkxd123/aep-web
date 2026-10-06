// After Effects acceptance for audio footage written by the editor: replaces a
// footage item used in a comp with a WAV file, saves, and renders that comp with
// aerender. After Effects must open the project and find the audio file.
//
//   node scripts/check-audio-replace.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CompItem, FootageItem } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { replaceFootage } from "../src/edit/project.ts";
import { probeMedia } from "../src/media/probe.ts";
import { aerender } from "./aerender.ts";

const editor = Editor.fromBytes(new Uint8Array(readFileSync("refs/fixtures/footage.aep")));
const project = editor.project;
// A comp whose layer uses file footage.
let comp: CompItem | undefined;
let item: FootageItem | undefined;
for (const c of project.items.values()) {
  if (c.kind !== "comp") continue;
  for (const l of c.layers) {
    const s = project.items.get(l.sourceId);
    if (s?.kind === "footage" && s.mainSource.sourceType === "FileSource") [comp, item] = [c, s];
  }
  if (comp) break;
}
if (!comp || !item) throw new Error("no comp with file footage in footage.aep");

const wavPath = resolve("refs/fixtures/fxmisc_audio/fxmisc_sine440.wav");
const bytes = readFileSync(wavPath);
const info = await probeMedia(new Blob([bytes]), wavPath);
replaceFootage(editor, item, { path: wavPath, info });
const out = resolve("refs/probe-audio-replace.aep");
writeFileSync(out, editor.save());
console.log(`replaced "${item.name}" in comp "${comp.name}" with ${wavPath} (${info.audio!.samples} samples at ${info.audio!.sampleRate} Hz)`);

const dir = join(tmpdir(), "aep-audio-replace");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const result = await aerender(["-project", out, "-comp", comp.name, "-s", "0", "-e", "0", "-OMtemplate", "Secuencia TIFF con alfa", "-output", join(dir, "f_[#####].tif"), "-sound", "OFF"], 300_000);
const problems = result.output.split(/\r?\n/).filter((l) => /error|no encontrado|not found|missing|falta/i.test(l));
console.log(`aerender exit ${result.code}${result.timedOut ? " (timed out)" : ""}`);
console.log(problems.length ? `problems:\n  ${problems.slice(0, 8).join("\n  ")}` : "no errors or missing-file messages in the aerender log");
process.exit(result.code === 0 && !problems.length ? 0 : 1);
