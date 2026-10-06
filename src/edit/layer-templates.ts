// Chunk blocks py-aep writes for new layers, solids, folders and Transform
// properties (src/edit/data/layer-templates.json, exported by
// scripts/fixtures/export_layer_templates.py), and the helpers that patch
// them into a project.
import { decodeCdta, decodeLdta } from "../aep/decode.ts";
import type { CompItem, Layer } from "../aep/model.ts";
import { findChild, findList, readRifx, type Chunk } from "../aep/riff.ts";
import { writeChunkBytes } from "../aep/write.ts";
import templates from "./data/layer-templates.json" with { type: "json" };
import type { Transaction } from "./chunks.ts";

/** Parses serialized chunks (each with its 8-byte header) back into a chunk list. */
export function chunksFromBytes(parts: Uint8Array[]): Chunk[] {
  const padded = parts.flatMap((p) => (p.length & 1 ? [p, new Uint8Array(1)] : [p]));
  const size = 4 + padded.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(8 + size);
  bytes.set(new TextEncoder().encode("RIFX"), 0);
  new DataView(bytes.buffer).setUint32(4, size);
  bytes.set(new TextEncoder().encode("Egg!"), 8);
  let at = 12;
  for (const p of padded) {
    bytes.set(p, at);
    at += p.length;
  }
  return readRifx(bytes).root.children ?? [];
}

/** Serializes chunks (with headers) for byte comparisons. */
export function chunkBytes(chunks: Chunk[]): Uint8Array[] {
  return chunks.map((c) => writeChunkBytes(c));
}

const decodeBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export type TemplateName = "avLayer" | "shapeLayer" | "solidItem" | "nullItem" | "folderItem";

/** A fresh copy of a template block. */
export function template(name: TemplateName): Chunk[] {
  return chunksFromBytes(templates[name].map(decodeBase64));
}

export function walk(chunk: Chunk, visit: (c: Chunk) => void): void {
  visit(chunk);
  chunk.children?.forEach((c) => walk(c, visit));
}

export const tdmnName = (chunk: Chunk) => new TextDecoder().decode(chunk.data).replace(/\0.*$/s, "");

/** The list following the `tdmn` naming `matchName` inside `group`. */
export function namedList(group: Chunk | undefined, matchName: string): Chunk | undefined {
  const children = group?.children ?? [];
  const i = children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === matchName);
  const next = i >= 0 ? children[i + 1] : undefined;
  return next?.type === "LIST" ? next : undefined;
}

/** Replaces a template chunk's body with an edited copy (template chunks are not in a transaction yet). */
export function setChunkData(chunk: Chunk | undefined, edit: (view: DataView, bytes: Uint8Array) => void): void {
  if (!chunk) return;
  const bytes = chunk.data.slice();
  edit(new DataView(bytes.buffer), bytes);
  chunk.data = bytes;
}

/** Points every tdb4 that carries a time base at `timebase`. */
export function setTimebase(root: Chunk, timebase: number): void {
  walk(root, (c) => {
    if (c.type !== "tdb4" || c.data.length < 16) return;
    const view = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    if (view.getUint32(12)) setChunkData(c, (v) => v.setUint32(12, timebase));
  });
}

/** The tdb4 time base of a layer's properties: the comp's, stretched by the layer's own stretch. */
export function layerTimebase(comp: CompItem, layer: Layer): number {
  const cdta = findChild(comp.chunk, "cdta");
  const ldta = findChild(layer.chunk, "ldta");
  if (!cdta) throw new Error(`composition "${comp.name}" has no cdta chunk`);
  const stretch = ldta ? Math.abs(decodeLdta(ldta).stretch || 100) / 100 : 1;
  return Math.trunc(decodeCdta(cdta).internalTimebase * Math.max(1, stretch));
}

const TRANSFORM_ORDER: string[] = templates.transformOrder;
const TRANSFORM_PROPS = templates.transformProps as Record<string, string[]>;

/**
 * Writes the chunks of a Transform property AE left out because it held its
 * default value, so the property can be edited. Returns false when the
 * property is already stored or has no template.
 */
export function materializeTransformProp(tx: Transaction, comp: CompItem, layer: Layer, matchName: string): boolean {
  const group = namedList(findList(layer.chunk, "tdgp"), "ADBE Transform Group");
  const source = TRANSFORM_PROPS[matchName];
  if (!group?.children || !source || namedList(group, matchName)) return false;
  const [tdmn, list] = chunksFromBytes(source.map(decodeBase64));
  setTimebase(list, layerTimebase(comp, layer));
  const children = group.children;
  const rank = TRANSFORM_ORDER.indexOf(matchName);
  let at = children.findIndex((c) => c.type === "tdmn");
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.type !== "tdmn") continue;
    const other = TRANSFORM_ORDER.indexOf(tdmnName(c));
    if (other >= 0 && other < rank) at = i + 2;
  }
  if (at < 0) at = children.length;
  tx.setChildren(group, [...children.slice(0, at), tdmn, list, ...children.slice(at)]);
  return true;
}
