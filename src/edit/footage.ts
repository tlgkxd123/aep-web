// File footage sources as After Effects' importer writes them (layouts from
// py-aep's FileSource._new): the item's `LIST:Pin` with the cached asset info
// in `sspc`, the path in `Als2/alas`, the importer header in `opti` and the
// color-management records in `CLRS` (left without profiles; see
// scripts/fixtures/projectops_templates.py).
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import type { MediaInfo } from "../media/probe.ts";
import type { Transaction } from "./chunks.ts";
import { setRatio } from "./encode.ts";
import { templateBlock, type TemplateBlock } from "./templates.ts";

/** A file to import: its path as the project should record it, and what its header says. */
export interface FootageFile {
  /** Absolute path when known (local footage service), else the bare file name. */
  path: string;
  info: MediaInfo;
}

const SSPC = {
  format: 22,
  width: 32,
  height: 36,
  duration: 38,
  nativeFrameRate: 56,
  alphaFlags: 69,
  alphaMode: 73,
  fieldSeparation: 0x53,
  fieldOrder: 0x57,
  stamp: 0x74,
  stampLength: 9,
  loop: 126,
  pixelAspect: 136,
  removePulldown: 147,
  conformFrameRate: 148,
  displayFrameRate: 152,
  highQualityFields: 0x9f,
  /** float64 Hz; 0 without audio. */
  audioSampleRate: 160,
} as const;

/** The template family AE's importer for the format matches (opti and linear-light defaults). */
function templateFor(info: MediaInfo): TemplateBlock {
  if (info.kind === "png" || info.kind === "tiff") return "PNG";
  // Audio files share the movie source layout (sspc, Als2, opti, pgui, CLRS, mnfo).
  if (info.kind === "video" || info.kind === "audio") return "MP4";
  return "JPEG";
}

function genericOpti(format: string): Uint8Array {
  const out = new Uint8Array(58);
  const code = [...format.padEnd(4, " ").slice(0, 4)].map((c) => c.charCodeAt(0));
  out.set(code, 0);
  out.set([0x00, 0x05, 0x00, 0x00, 0x00, 0x3a], 4);
  out.set([...code].reverse(), 30);
  out.set([0xff, 0xff, 0xff, 0xff], 34);
  out.set([0x01, 0x00, 0x00, 0x00], 42);
  out[46] = 0x01;
  return out;
}

function tiffOpti(width: number, height: number): Uint8Array {
  const out = new Uint8Array(602);
  const view = new DataView(out.buffer);
  out.set([0x54, 0x49, 0x46, 0x20, 0x01, 0x09], 0);
  view.setUint32(6, 602);
  out.set([0x00, 0x00, 0x01, 0x01, 0xff, 0xff, 0xff, 0xff, 0x20, 0x46, 0x49, 0x54, 0x01], 10);
  out.set([0x04, 0x00], 30);
  view.setUint32(32, height, true);
  view.setUint32(36, width, true);
  view.setUint16(40, 8, true);
  out.set([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00], 42);
  return out;
}

function optiFor(info: MediaInfo): Uint8Array {
  if (info.kind === "tiff") return tiffOpti(info.width, info.height);
  if (info.kind === "png") return new Uint8Array(0);
  return genericOpti(info.format);
}

const alas = (path: string) =>
  JSON.stringify({
    ascendcount_base: 0,
    ascendcount_target: 0,
    fullpath: path,
    platform: 1,
    server_name: "",
    server_volume_name: "",
    target_is_folder: false,
  });

const isStill = (info: MediaInfo) => info.duration === 0;

/** `idta` footage-kind flags: video, single still, audio. */
export const footageFlags = (info: MediaInfo) =>
  (info.width > 0 ? 0x20 : 0) | (isStill(info) ? 0x10 : 0) | (info.audio || info.audioTrackRate ? 0x04 : 0);

/** The label AE gives new footage: Audio (7), Still (5) or Video (3). */
export const footageLabel = (info: MediaInfo) => (info.audio ? 7 : isStill(info) ? 5 : 3);

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/**
 * A fresh `LIST:Pin` for the file. The source is left unstamped (no
 * modification time), the state AE writes for footage it has to re-read, so
 * AE takes the asset info from the file itself when it opens the project.
 */
export function buildPin(file: FootageFile): Chunk {
  const { info } = file;
  const pin = findList(templateBlock(templateFor(info))[0], "Pin ");
  const sspc = findChild(pin, "sspc");
  const opti = findChild(pin, "opti");
  const pgui = findChild(pin, "pgui");
  const alasChunk = findChild(findList(pin, "Als2"), "alas");
  if (!pin || !sspc || !opti || !pgui || !alasChunk) throw new Error("footage template is incomplete");
  const view = new DataView(sspc.data.buffer, sspc.data.byteOffset, sspc.data.byteLength);
  for (let i = 0; i < 4; i++) sspc.data[SSPC.format + i] = info.format.charCodeAt(i) || 0x20;
  view.setUint16(SSPC.width, info.width);
  view.setUint16(SSPC.height, info.height);
  if (info.audio) {
    // Audio files record their length exactly, in samples over the sample rate.
    view.setUint32(SSPC.duration, info.audio.samples);
    view.setUint32(SSPC.duration + 4, info.audio.sampleRate);
  } else if (isStill(info)) view.setUint32(SSPC.duration, 0), view.setUint32(SSPC.duration + 4, 1);
  else setRatio(view, SSPC.duration, info.duration, false);
  if (sspc.data.length >= SSPC.audioSampleRate + 8) view.setFloat64(SSPC.audioSampleRate, info.audio?.sampleRate ?? info.audioTrackRate ?? 0);
  const whole = Math.trunc(info.frameRate);
  view.setUint32(SSPC.nativeFrameRate, whole);
  view.setUint16(SSPC.nativeFrameRate + 4, Math.round((info.frameRate - whole) * 65536));
  view.setUint16(SSPC.displayFrameRate, whole);
  view.setUint16(SSPC.displayFrameRate + 2, Math.round((info.frameRate - whole) * 65536));
  sspc.data[SSPC.alphaMode] = info.hasAlpha ? 0 : 3;
  sspc.data.fill(0, SSPC.stamp, SSPC.stamp + SSPC.stampLength);
  opti.data = optiFor(info);
  pgui.data = randomBytes(16);
  alasChunk.data = new TextEncoder().encode(alas(file.path));
  return pin;
}

/**
 * Carries the Interpret Footage settings AE keeps across Replace Footage
 * (field separation, pulldown, loop, pixel aspect and a frame-rate conform)
 * from the old source onto the new one; everything AE measures comes from the
 * new file.
 */
export function carryInterpretation(from: Chunk, to: Chunk, still: boolean): void {
  const old = findChild(from, "sspc");
  const sspc = findChild(to, "sspc");
  if (!old || !sspc || old.data.length < 160) return;
  const view = new DataView(sspc.data.buffer, sspc.data.byteOffset, sspc.data.byteLength);
  const oldView = new DataView(old.data.buffer, old.data.byteOffset, old.data.byteLength);
  for (const at of [SSPC.fieldSeparation, SSPC.fieldOrder, SSPC.highQualityFields, SSPC.removePulldown]) sspc.data[at] = old.data[at];
  view.setUint32(SSPC.loop, oldView.getUint32(SSPC.loop));
  view.setUint32(SSPC.pixelAspect, oldView.getUint32(SSPC.pixelAspect));
  view.setUint32(SSPC.pixelAspect + 4, oldView.getUint32(SSPC.pixelAspect + 4));
  if (!still) view.setUint32(SSPC.conformFrameRate, oldView.getUint32(SSPC.conformFrameRate));
}

/** Points a footage item at a new file: a new `LIST:Pin` and the item's kind flags. */
export function setFootageSource(tx: Transaction, itemList: Chunk, pin: Chunk, info: MediaInfo): void {
  const children = itemList.children ?? [];
  const i = children.findIndex((c) => c.type === "LIST" && c.listType === "Pin ");
  if (i < 0) throw new Error("footage item has no source (LIST:Pin)");
  tx.setChildren(itemList, [...children.slice(0, i), pin, ...children.slice(i + 1)]);
  const idta = findChild(itemList, "idta");
  if (idta) tx.patch(idta, (_, bytes) => (bytes[23] = (bytes[23] & ~0x34) | footageFlags(info)));
}
