// Shape and mask properties After Effects left out because they held their defaults, written from the
// stored instances in data/shape-template.json (exported by scripts/export-shape-template.ts from a project
// After Effects 2025 saved with every one of them set) so they can be edited.
import type { CompItem, Layer, Property, PropertyGroup, PropertyNode } from "../aep/model.ts";
import type { Chunk } from "../aep/riff.ts";
import type { Transaction } from "./chunks.ts";
import { chunksFromBytes, layerTimebase, setTimebase, tdmnName } from "./layer-templates.ts";
import template from "./data/shape-template.json" with { type: "json" };

const ORDER = template.order as Record<string, string[]>;
const LEAVES = template.leaves as Record<string, string[]>;

const decodeBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A fresh copy of the stored instance of `matchName`: its tdmn and the lists after it. */
export function templateLeaf(matchName: string): Chunk[] | undefined {
  const parts = LEAVES[matchName];
  return parts ? chunksFromBytes(parts.map(decodeBase64)) : undefined;
}

/** The group directly holding `node`, searched from `nodes`. */
export function parentGroup(nodes: readonly PropertyNode[], node: PropertyNode): PropertyGroup | undefined {
  for (const n of nodes) {
    if (n.kind !== "group") continue;
    if (n.children.includes(node)) return n;
    const found = parentGroup(n.children, node);
    if (found) return found;
  }
  return undefined;
}

/** Whether `prop` is a shape or mask property left out of a stored group, which `materializeVectorProp` can write. */
export function canMaterializeVector(layer: Layer, prop: Property): boolean {
  if (!prop.synthesized || !LEAVES[prop.matchName]) return false;
  const group = parentGroup(layer.properties, prop);
  return !!group && !group.synthesized && group.chunk?.listType === "tdgp" && !!ORDER[group.matchName]?.includes(prop.matchName);
}

/** Writes the chunks of a left-out shape or mask property into its group, in After Effects' order; returns its group's tdgp. */
export function materializeVectorProp(tx: Transaction, comp: CompItem, layer: Layer, prop: Property): Chunk {
  const group = parentGroup(layer.properties, prop);
  const tdgp = group?.chunk;
  const leaf = templateLeaf(prop.matchName);
  if (!group || !tdgp?.children || !leaf || !canMaterializeVector(layer, prop)) throw new Error(`"${prop.name}" cannot be written to the project`);
  for (const c of leaf) setTimebase(c, layerTimebase(comp, layer));
  const order = ORDER[group.matchName];
  const rank = order.indexOf(prop.matchName);
  const children = tdgp.children;
  let at = -1;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.type !== "tdmn") continue;
    const name = tdmnName(c);
    const other = order.indexOf(name);
    if (name === "ADBE Group End" || (other > rank && at < 0)) {
      at = i;
      break;
    }
  }
  if (at < 0) at = children.length;
  tx.setChildren(tdgp, [...children.slice(0, at), ...leaf, ...children.slice(at)]);
  return tdgp;
}

/** The property named `matchName` in the group stored in `tdgp`, in `layer` as derived now. */
export function findInGroup(layer: Layer, tdgp: Chunk, matchName: string): Property | undefined {
  const find = (nodes: readonly PropertyNode[]): Property | undefined => {
    for (const n of nodes) {
      if (n.kind !== "group") continue;
      if (n.chunk === tdgp) return n.children.find((c): c is Property => c.kind === "property" && c.matchName === matchName);
      const found = find(n.children);
      if (found) return found;
    }
    return undefined;
  };
  return find(layer.properties);
}
