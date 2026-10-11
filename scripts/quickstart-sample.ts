// Writes each Quick Start template's project (src/quickstart/) around a song, to open and
// render in After Effects:
//
//   node scripts/quickstart-sample.ts [song.wav] [--background image] [--logo image] [--out dir] [--aerender]
//
// Without a song, a synthetic one (bass kicks twice a second for 8 s) is written next to the
// projects. Songs must be WAV here (Node decodes no other sound). The projects store the
// files' absolute paths, so After Effects finds them where they are. With --aerender, After
// Effects renders each template's frame at 1 s (on a kick of the synthetic song) to
// <out>/ae-<template>/ and the ring's white bars must show around the circle; prints
// QUICKSTART-AE-PASSED when every render does.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { FootageFile } from "../src/edit/project.ts";
import { decodeWav } from "../src/media/audio.ts";
import { probeMedia } from "../src/media/probe.ts";
import { buildQuickStart, RING_RADIUS } from "../src/quickstart/build.ts";
import { QUICK_START_TEMPLATES } from "../src/quickstart/catalog.ts";
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
const out = resolve(option("--out") ?? "refs/probe-quickstart");
const backgroundPath = option("--background");
const logoPath = option("--logo");
const withAerender = flag("--aerender");
mkdirSync(out, { recursive: true });

/** Bright pixels a render must show in the ring's band: its front spectrum is white. */
const MIN_RING_PIXELS = 400;

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

let songPath = args[0] ? resolve(args[0]) : undefined;
if (!songPath) {
  songPath = join(out, "kicks.wav");
  writeFileSync(songPath, kicks(8));
}
const footage = async (path: string | undefined): Promise<FootageFile | undefined> => {
  if (!path) return undefined;
  const absolute = resolve(path);
  return { path: absolute, info: await probeMedia(new Blob([readFileSync(absolute)]), basename(absolute)) };
};
const audio = decodeWav(new Uint8Array(readFileSync(songPath)));
if (!audio) throw new Error(`${songPath} is not a WAV file this script reads`);
const media = { song: (await footage(songPath))!, background: await footage(backgroundPath), logo: await footage(logoPath) };

const written: { path: string; comp: string; frame: number; width: number; height: number }[] = [];
for (const template of QUICK_START_TEMPLATES) {
  const { editor, comp } = await buildQuickStart(template.id, media, { audio });
  const path = join(out, `${template.id}.aep`);
  writeFileSync(path, editor.save());
  written.push({ path, comp: comp.name, frame: Math.round(comp.frameRate), width: comp.width, height: comp.height });
  console.log(`${path}: "${comp.name}", ${comp.width}x${comp.height}, ${comp.frameRate} fps, ${comp.duration.toFixed(2)} s, ${comp.layers.length} layers`);
}

if (withAerender) {
  const results: boolean[] = [];
  for (const { path, comp, frame, width, height } of written) {
    const dir = join(out, `ae-${basename(path, ".aep")}`);
    mkdirSync(dir, { recursive: true });
    const result = await aerender(
      ["-project", path, "-comp", comp, "-s", String(frame), "-e", String(frame), "-OMtemplate", process.env.AE_TIFF_TEMPLATE ?? "Secuencia TIFF con alfa", "-output", join(dir, "f_[#####].tif"), "-sound", "OFF"],
      600_000,
    );
    const problems = result.output.split(/\r?\n/).filter((l) => /error|no encontrad|not found|missing|falta|ausente/i.test(l));
    const tif = join(dir, `f_${String(frame).padStart(5, "0")}.tif`);
    let ring = 0;
    if (existsSync(tif)) {
      const image = readTiff(new Uint8Array(readFileSync(tif)));
      const scale = image.width / width;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const r = Math.hypot(x / scale - width / 2, y / scale - height / 2);
          const i = (y * image.width + x) * 4;
          if (r > RING_RADIUS + 8 && r < RING_RADIUS + 200 && image.data[i] + image.data[i + 1] + image.data[i + 2] > 600) ring++;
        }
      }
    }
    const ok = result.code === 0 && !result.timedOut && !problems.length && ring >= MIN_RING_PIXELS;
    results.push(ok);
    console.log(`${ok ? "ok  " : "FAIL"} After Effects renders "${comp}" frame ${frame}: exit ${result.code}, ${ring} bright ring pixels${problems.length ? `, ${problems.slice(0, 4).join(" | ")}` : ""}`);
  }
  if (results.every(Boolean)) console.log("QUICKSTART-AE-PASSED");
  else process.exit(1);
}
