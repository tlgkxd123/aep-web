// Regenerates src/edit/data/mask-template.json: the Masks group of a layer After Effects 2025
// saved with one mask (py-aep's samples/models/property/mask.aep, comp "is_mask_true"), which
// src/edit/masks.ts clones for the masks it writes.
//
//   node scripts/export-mask-template.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFromRifx } from "../src/aep/parse.ts";
import { findList, readRifx } from "../src/aep/riff.ts";
import { chunkBytes, namedList, tdmnName } from "../src/edit/layer-templates.ts";
import { SAMPLES } from "./lib/paths.ts";

const SOURCE = "models/property/mask.aep";
const COMP = "is_mask_true";
const LAYER = "TestLayer";
const OUT = "src/edit/data/mask-template.json";

const project = projectFromRifx(readRifx(new Uint8Array(readFileSync(join(SAMPLES, SOURCE)))));
const comp = [...project.items.values()].find((i) => i.kind === "comp" && i.name === COMP);
const layer = comp?.kind === "comp" ? comp.layers.find((l) => l.name === LAYER) : undefined;
if (!layer) throw new Error(`${SOURCE} has no layer "${LAYER}" in "${COMP}"`);
const root = findList(layer.chunk, "tdgp");
const parade = namedList(root, "ADBE Mask Parade");
const tdmn = root?.children?.find((c) => c.type === "tdmn" && tdmnName(c) === "ADBE Mask Parade");
if (!parade || !tdmn) throw new Error(`"${LAYER}" has no masks`);
const atoms = (parade.children ?? []).filter((c) => c.type === "tdmn" && tdmnName(c) === "ADBE Mask Atom");
if (atoms.length !== 1) throw new Error(`"${LAYER}" should hold exactly one mask, not ${atoms.length}`);

const parts = chunkBytes([tdmn, parade]).map((b) => Buffer.from(b).toString("base64"));
writeFileSync(OUT, JSON.stringify({ source: `py-aep samples/${SOURCE}, ${COMP} > ${LAYER}`, parade: parts }, null, 1) + "\n");
console.log(`wrote ${OUT}: the Masks group of "${LAYER}" (${parts.reduce((n, p) => n + p.length, 0)} base64 characters)`);
