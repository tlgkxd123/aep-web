// Converts an Avee Player template (src/viz/) around a song and writes the project as
// File > Save As Zip with Footage lays it out, unpacked: <out>/<name>/<name>.aep beside its
// "(Footage)" folder, so After Effects finds the footage through the relative links alone:
//
//   node scripts/viz-sample.ts <template.viz | unpacked folder> [song.wav] [--out dir] [--at seconds] [--aerender] [--export]
//
// With --export, the converted project is also exported back to <out>/<name>/<name>.viz
// (src/viz/export.ts), converted once more, and both conversions' comps and reports printed.
//
// Without a song, a synthetic one (bass kicks twice a second for 8 s) is used. Songs must be
// WAV here (Node decodes no other sound). Prints what the conversion approximated or left
// out. With --aerender, After Effects renders the main comp's frame at --at seconds (1 by
// default) to <out>/<name>/ae/; the render must succeed without missing footage and show
// something; prints VIZ-AE-PASSED when it does.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { collectProject } from "../src/edit/collect.ts";
import type { FootageFile } from "../src/edit/project.ts";
import { decodeWav } from "../src/media/audio.ts";
import { probeMedia } from "../src/media/probe.ts";
import { FootageStore } from "../src/media/store.ts";
import { writeZip } from "../src/media/zip.ts";
import { convertViz } from "../src/viz/convert.ts";
import { exportViz } from "../src/viz/export.ts";
import { parseScene, vizFromArchive, vizFromFiles, type VizTemplate } from "../src/viz/scene.ts";
import { aerender } from "./aerender.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  if (at >= 0) args.splice(at, 1);
  return at >= 0;
};
const option = (name: string) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const [value] = args.splice(at, 2).slice(1);
  if (!value) throw new Error(`${name} needs a value`);
  return value;
};
const out = resolve(option("--out") ?? "refs/probe-viz");
const at = Number(option("--at") ?? 1);
const withAerender = flag("--aerender");
const withExport = flag("--export");
const [templateArg, songArg] = args;
if (!templateArg) throw new Error("usage: node scripts/viz-sample.ts <template.viz | folder> [song.wav] [--out dir] [--aerender]");

/** Pixels a render must show brighter than black: the template drew something. */
const MIN_LIT_PIXELS = 2000;

/** A mono 16-bit WAV of 55 Hz kicks twice a second over a quiet 440 Hz tone. */
function kicks(seconds: number, rate = 48000): Uint8Array {
  const samples = seconds * rate;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const kick = 0.8 * Math.exp(-((t * 2) % 1) * 12) * Math.sin(2 * Math.PI * 55 * t);
    view.setInt16(44 + i * 2, Math.round((kick + 0.05 * Math.sin(2 * Math.PI * 440 * t)) * 32767), true);
  }
  return bytes;
}

function filesBelow(dir: string): { path: string; blob: Blob }[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? filesBelow(full)
      : [{ path: relative(dirname(dir), full).replace(/\\/g, "/"), blob: new Blob([readFileSync(full)]) }];
  });
}

const templatePath = resolve(templateArg);
const template: VizTemplate | undefined = statSync(templatePath).isDirectory()
  ? await vizFromFiles(filesBelow(templatePath))
  : await vizFromArchive(new Blob([readFileSync(templatePath)]), basename(templatePath));
if (!template) throw new Error(`${templatePath} is not an Avee Player template`);

mkdirSync(out, { recursive: true });
let songPath = songArg ? resolve(songArg) : undefined;
if (!songPath) {
  songPath = join(out, "kicks.wav");
  writeFileSync(songPath, kicks(8));
}
const songBlob = new Blob([readFileSync(songPath)]);
const song: FootageFile = { path: songPath, info: await probeMedia(songBlob, basename(songPath)) };
const audio = decodeWav(new Uint8Array(readFileSync(songPath)));
if (!audio) throw new Error(`${songPath} is not a WAV file this script reads`);

const project = await convertViz(template, { song, audio });
const store = new FootageStore(256 << 20);
store.addFiles([...project.footage, { path: song.path, blob: songBlob }]);
const { entries, missing } = collectProject(project.editor, `${template.name}.zip`, (item) => store.sourceFiles(item));
const folder = join(out, entries[0].path.replace(/\.aep$/i, ""));
rmSync(folder, { recursive: true, force: true });
for (const entry of entries) {
  const path = join(folder, ...entry.path.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entry.data instanceof Uint8Array ? entry.data : new Uint8Array(await entry.data.arrayBuffer()));
}
const aep = join(folder, entries[0].path);
const { comp } = project;
console.log(`${aep}: "${comp.name}", ${comp.width}x${comp.height}, ${comp.frameRate} fps, ${comp.duration.toFixed(2)} s, ${entries.length - 1} footage files`);
for (const item of missing) console.log(`  missing footage: ${item.name}`);
for (const line of project.report) console.log(`  - ${line}`);

if (withExport) {
  const exported = exportViz(project.editor.project, comp, (item) => store.sourceFiles(item));
  const { blob } = await writeZip(exported.files);
  const vizPath = join(folder, `${template.name}.viz`);
  writeFileSync(vizPath, new Uint8Array(await blob.arrayBuffer()));
  const scene = parseScene(new TextDecoder().decode(exported.files[0].data as Uint8Array));
  const types = scene.compositions.flat().reduce((m, e) => m.set(e.objType, (m.get(e.objType) ?? 0) + 1), new Map<string, number>());
  console.log(`${vizPath}: ${scene.compositions.length} compositions, ${[...types].map(([t, n]) => `${n} ${t}`).join(", ")}`);
  for (const line of exported.report) console.log(`  - ${line}`);
  const again = await convertViz((await vizFromArchive(blob, vizPath))!, { song, audio });
  const compCount = (p: typeof project) => [...p.editor.project.items.values()].filter((i) => i.kind === "comp").length;
  console.log(`converted again: ${compCount(again)} comps (first conversion: ${compCount(project)}), ${again.report.length} report lines`);
}

if (withAerender) {
  const frame = Math.round(at * comp.frameRate);
  const dir = join(folder, "ae");
  mkdirSync(dir, { recursive: true });
  const result = await aerender(
    ["-project", aep, "-comp", comp.name, "-s", String(frame), "-e", String(frame), "-OMtemplate", process.env.AE_TIFF_TEMPLATE ?? "Secuencia TIFF con alfa", "-output", join(dir, "f_[#####].tif"), "-sound", "OFF"],
    600_000,
  );
  const problems = result.output.split(/\r?\n/).filter((l) => /error|no encontrad|not found|missing|falta|ausente/i.test(l));
  const tif = join(dir, `f_${String(frame).padStart(5, "0")}.tif`);
  let lit = 0;
  if (existsSync(tif)) {
    const image = readTiff(new Uint8Array(readFileSync(tif)));
    for (let i = 0; i < image.data.length; i += 4) if (image.data[i] + image.data[i + 1] + image.data[i + 2] > 60) lit++;
  }
  const ok = result.code === 0 && !result.timedOut && !problems.length && lit >= MIN_LIT_PIXELS;
  console.log(`${ok ? "ok  " : "FAIL"} After Effects renders "${comp.name}" frame ${frame}: exit ${result.code}, ${lit} lit pixels${problems.length ? `, ${problems.slice(0, 6).join(" | ")}` : ""}`);
  if (ok) console.log("VIZ-AE-PASSED");
  else process.exit(1);
}
