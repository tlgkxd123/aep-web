// Regenerates src/edit/data/shape-template.json from refs/fixtures/donors/ae2025-shapes.aep (written by
// scripts/ae-shape-donors.ts: After Effects 2025 saved every shape and mask property there away from its
// default, so all of them are stored):
//  - groups: the Rectangle, Ellipse, Star, Polygon and Path groups of layer "Stored", which
//    src/edit/shapes.ts clones for the shapes it adds;
//  - leaves: one stored instance of each shape and mask property, which src/edit/shapes.ts writes into a
//    group of an opened project when After Effects left that property out at its default;
//  - order: the order After Effects keeps the properties of each group in.
//
//   node scripts/export-shape-template.ts
import { readFileSync, writeFileSync } from "node:fs";
import { decodeLhd3 } from "../src/aep/decode.ts";
import { projectFromRifx } from "../src/aep/parse.ts";
import { findChild, findList, readRifx, type Chunk } from "../src/aep/riff.ts";
import { chunkBytes, tdmnName, walk } from "../src/edit/layer-templates.ts";
import { SHAPE_DONORS } from "./ae-shape-donors.ts";

const OUT = "src/edit/data/shape-template.json";
const GROUPS: Record<string, string> = { rect: "Rectangle 1", ellipse: "Ellipse 1", star: "Polystar 1", polygon: "Polygon 1", path: "Shape 1" };

const project = projectFromRifx(readRifx(new Uint8Array(readFileSync(SHAPE_DONORS))));
const comp = [...project.items.values()].find((i) => i.kind === "comp");
if (comp?.kind !== "comp") throw new Error(`${SHAPE_DONORS} has no composition`);
const layerNamed = (name: string) => {
  const layer = comp.layers.find((l) => l.name === name);
  if (!layer) throw new Error(`${SHAPE_DONORS} has no layer "${name}"`);
  return layer;
};

const base64 = (chunks: Chunk[]) => chunkBytes(chunks).map((b) => Buffer.from(b).toString("base64"));
/** [tdmn, container] pairs of a group's tdgp, with the extra chunks a mask atom keeps between them. */
function entries(tdgp: Chunk): { name: string; chunks: Chunk[] }[] {
  const out: { name: string; chunks: Chunk[] }[] = [];
  for (const c of tdgp.children ?? []) {
    if (c.type === "tdmn") out.push({ name: tdmnName(c), chunks: [c] });
    else out.at(-1)?.chunks.push(c);
  }
  return out.filter((e) => e.name !== "ADBE Group End");
}
const containerOf = (chunks: Chunk[]) => chunks.find((c) => c.type === "LIST");
const innerGroup = (list: Chunk | undefined) => (list?.listType === "tdgp" ? list : undefined);

const groups: Record<string, string[]> = {};
const leaves: Record<string, string[]> = {};
const order: Record<string, string[]> = {};

function collect(tdgp: Chunk, parent: string): void {
  const list = entries(tdgp);
  // Groups of one kind may store different properties (a star's Type is left out at Star): merge their orders.
  const known = (order[parent] ??= []);
  list.forEach((e, i) => {
    if (known.includes(e.name)) return;
    const before = list.slice(0, i).reverse().find((p) => known.includes(p.name.valueOf()));
    known.splice(before ? known.indexOf(before.name) + 1 : 0, 0, e.name);
  });
  for (const e of list) {
    const container = containerOf(e.chunks);
    const inner = innerGroup(container);
    if (inner) collect(inner, e.name);
    else if (container && !leaves[e.name] && !findList(findList(container, "tdbs") ?? container, "list")) leaves[e.name] = base64(e.chunks);
  }
}

const stored = layerNamed("Stored");
const contents = entries(findList(stored.chunk, "tdgp")!).find((e) => e.name === "ADBE Root Vectors Group");
const vectorGroups = entries(innerGroup(containerOf(contents?.chunks ?? []))!).filter((e) => e.name === "ADBE Vector Group");
for (const [kind, name] of Object.entries(GROUPS)) {
  const found = vectorGroups.find((e) => {
    const tdgp = innerGroup(containerOf(e.chunks));
    const tdsn = findChild(tdgp, "tdsn");
    const utf8 = findChild(tdsn, "Utf8");
    return utf8 && new TextDecoder().decode(utf8.data) === name;
  });
  if (!found) throw new Error(`layer "Stored" has no group "${name}"`);
  groups[kind] = base64(found.chunks);
  collect(innerGroup(containerOf(found.chunks))!, "ADBE Vector Group");
}

// An empty Contents group, for shape layers saved without one, and the groups it comes before.
const layerGroups = entries(findList(stored.chunk, "tdgp")!).map((e) => e.name);
const root = innerGroup(containerOf(contents!.chunks))!;
const emptyRoot = { ...root, children: (root.children ?? []).filter((c, i, all) => i < all.findIndex((d) => d.type === "tdmn") || (c.type === "tdmn" && tdmnName(c) === "ADBE Group End")) };
const rootContents = base64([contents!.chunks[0], emptyRoot]);
const contentsBefore = layerGroups.slice(layerGroups.indexOf("ADBE Root Vectors Group") + 1);
console.log(`layer groups: ${layerGroups.join(", ")}`);

const masked = layerNamed("Masked");
const parade = entries(findList(masked.chunk, "tdgp")!).find((e) => e.name === "ADBE Mask Parade");
const atom = entries(innerGroup(containerOf(parade?.chunks ?? []))!).find((e) => e.name === "ADBE Mask Atom");
if (!atom) throw new Error(`layer "Masked" has no mask`);
collect(innerGroup(containerOf(atom.chunks))!, "ADBE Mask Atom");

// The point-list headers of the stored paths, which src/edit/paths.ts writes the same way.
walk(stored.chunk, (c) => {
  if (c.listType !== "shap") return;
  const lhd3 = findChild(findList(c, "list"), "lhd3");
  if (!lhd3) return;
  const view = new DataView(lhd3.data.buffer, lhd3.data.byteOffset, lhd3.data.byteLength);
  const { count } = decodeLhd3(lhd3);
  console.log(`shap: ${count} points, counters ${view.getUint32(12)} ${view.getUint32(24)} ${view.getUint32(28)}`);
});

writeFileSync(
  OUT,
  JSON.stringify({ source: "refs/fixtures/donors/ae2025-shapes.aep (scripts/ae-shape-donors.ts)", contents: rootContents, contentsBefore, order, groups, leaves }, null, 1) + "\n",
);
console.log(`wrote ${OUT}: ${Object.keys(groups).length} groups, ${Object.keys(leaves).length} properties`);
for (const [parent, names] of Object.entries(order)) console.log(`  ${parent}: ${names.join(", ")}`);
