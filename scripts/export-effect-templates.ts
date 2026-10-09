// Regenerates src/extra/pmatch/data/effect-templates.json: the definitions (LIST:EfDf)
// of the effects Particle Match creates, cloned from the first donor project After
// Effects saved that defines each (AEP_EFFECT_DONOR, then DONORS), and from each a
// fresh instance (LIST:sspc): every stored number, angle, popup, checkbox and colour
// back at the default its parameter definition (pard) gives, points at the layer
// centre, no keyframes, expressions or layer references, the Size and Opacity over
// Life curves flat, and the effect's own name. Parameters the definition leaves out
// (After Effects stores none at their defaults) are written when they are set
// (src/edit/effects.ts). The chunks are stored gzipped in one base64 string.
//
//   node scripts/export-effect-templates.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { decodePard, type Pard } from "../src/aep/decode.ts";
import { findChild, findList, readRifx, type Chunk } from "../src/aep/riff.ts";
import { writeChunkBytes } from "../src/aep/write.ts";
import { doubles, readDoubles } from "../src/edit/chunks.ts";
import { setExpressionFlags } from "../src/edit/encode.ts";
import { flatCurve, OVER_LIFE } from "../src/render/effects/particularCurves.ts";

const DONORS = [
  process.env.AEP_EFFECT_DONOR,
  "refs/fixtures/fxextra.aep",
  "refs/probe-pp0.aep",
  "C:/Users/schxm/Downloads/TN 2020 2.aep",
].filter((p): p is string => !!p && existsSync(p));
const OUT = "src/extra/pmatch/data/effect-templates.json";
const EFFECTS = ["tc Particular", "ADBE Mirror", "S_Shake"];

const text = (c: Chunk) => new TextDecoder().decode(c.data).replace(/\0.*$/s, "");
const clone = (c: Chunk): Chunk => ({ ...c, offset: -1, data: c.data.slice(), children: c.children?.map(clone) });

const definitions = DONORS.map((path) => ({ path, efdg: findList(readRifx(new Uint8Array(readFileSync(path))).root, "EfdG") }));

function definitionOf(matchName: string): { definition: Chunk; source: string } {
  for (const { path, efdg } of definitions) {
    for (const efdf of efdg?.children ?? []) {
      if (efdf.type !== "LIST" || efdf.listType !== "EfDf") continue;
      const tdmn = findChild(efdf, "tdmn");
      if (tdmn && text(tdmn) === matchName) return { definition: efdf, source: path };
    }
  }
  throw new Error(`no donor defines ${matchName}; set AEP_EFFECT_DONOR to a project After Effects saved with it`);
}

/** Puts a stored parameter back at its definition's default; returns what changed. */
function reset(name: string, tdbs: Chunk, pard: Pard | undefined): string[] {
  const changes: string[] = [];
  const kids = tdbs.children ?? [];
  if (findList(tdbs, "list")) throw new Error(`${name} is animated in its donor; pick a donor without keyframes`);
  if (kids.some((c) => c.type === "Utf8")) {
    tdbs.children = kids.filter((c) => c.type !== "Utf8");
    changes.push("expression");
  }
  const tdb4 = findChild(tdbs, "tdb4");
  if (tdb4) setExpressionFlags(tdb4.data, false, false);
  const tdpi = findChild(tdbs, "tdpi");
  if (tdpi && new DataView(tdpi.data.buffer, tdpi.data.byteOffset).getInt32(0)) {
    tdpi.data = new Uint8Array(4);
    changes.push("layer");
  }
  const cdat = findChild(tdbs, "cdat");
  if (!cdat || !pard) return changes;
  const values = readDoubles(cdat.data);
  const before = values.join();
  const d = pard.defaultValue;
  switch (pard.controlType) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 7:
    case 10:
      if (typeof d === "number") values[0] = d;
      break;
    case 5:
      if (Array.isArray(d)) [values[0], values[1], values[2], values[3]] = [d[3] * 255, d[0] * 255, d[1] * 255, d[2] * 255];
      break;
    case 6:
    case 18:
      values[0] = 0.5;
      values[1] = 0.5;
      if (pard.controlType === 18) values[2] = 0;
      break;
  }
  if (values.join() !== before) {
    cdat.data = doubles(values);
    changes.push("value");
  }
  return changes;
}

function freshInstance(matchName: string, definition: Chunk): Chunk {
  const sspc = clone(findList(definition, "sspc")!);
  const parT = findList(sspc, "parT");
  const pards = new Map<string, Pard>();
  let current = "";
  for (const c of parT?.children ?? []) {
    if (c.type === "tdmn") current = text(c);
    else if (c.type === "pard") pards.set(current, decodePard(c));
  }
  if (!pards.size) throw new Error(`the definition of ${matchName} has no parameter list`);
  const tdgp = findList(sspc, "tdgp")!;
  // The effect is switched on (bit 0 of the tdsb's last byte) and named after its type.
  const tdsb = findChild(tdgp, "tdsb");
  if (tdsb) tdsb.data[3] |= 1;
  const tdsn = findChild(tdgp, "tdsn");
  if (tdsn) tdsn.data = new Uint8Array(Buffer.concat([Buffer.from("Utf8"), Buffer.from([0, 0, 0, 6]), Buffer.from("-_0_/-")]));
  const counts = new Map<string, number>();
  const kids = tdgp.children ?? [];
  for (let i = 0; i < kids.length - 1; i++) {
    if (kids[i].type !== "tdmn") continue;
    const name = text(kids[i]);
    // A parameter's lists follow its name: its stream (tdbs), then for curves the curve (aRbs).
    for (let j = i + 1; j < kids.length && kids[j].type === "LIST"; j++) {
      const list = kids[j];
      if (list.listType === "tdbs") {
        for (const change of reset(name, list, pards.get(name))) counts.set(change, (counts.get(change) ?? 0) + 1);
      } else if (list.listType === "aRbs" && OVER_LIFE.has(Number(name.slice(matchName.length + 1)))) {
        const aRbp = findChild(list, "aRbp");
        if (aRbp) aRbp.data = flatCurve(aRbp.data);
        counts.set("curve", (counts.get("curve") ?? 0) + 1);
      }
    }
  }
  const stored = kids.filter((c, i) => c.type === "tdmn" && kids[i + 1]?.type === "LIST").length;
  console.log(`${matchName}: ${pards.size} parameters, ${stored} stored; reset ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ") || "nothing"}; named ${JSON.stringify(new TextDecoder().decode(findChild(tdgp, "tdsn")!.data.subarray(8)))}`);
  return sspc;
}

const parts: Uint8Array[] = [];
let offset = 0;
const add = (chunk: Chunk): [number, number] => {
  const bytes = writeChunkBytes(chunk);
  parts.push(bytes);
  const at: [number, number] = [offset, bytes.length];
  offset += bytes.length;
  return at;
};
const effects: Record<string, { source: string; definition: [number, number]; instance: [number, number] }> = {};
for (const matchName of EFFECTS) {
  const { definition, source } = definitionOf(matchName);
  console.log(`${matchName} from ${source}`);
  effects[matchName] = { source: source.replace(/^.*[\\/]/, ""), definition: add(definition), instance: add(freshInstance(matchName, definition)) };
}
const raw = Buffer.concat(parts);
const packed = gzipSync(raw, { level: 9 });
writeFileSync(OUT, JSON.stringify({ effects, data: packed.toString("base64") }) + "\n");
console.log(`${raw.length} bytes, ${packed.length} gzipped -> ${OUT}`);
