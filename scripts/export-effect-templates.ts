// Regenerates src/extra/pmatch/data/effect-templates.json: the templates of the effects
// Particle Match creates (src/edit/effectTemplates.ts), their definitions cloned from
// the first donor project After Effects saved that defines each (AEP_EFFECT_DONOR, then
// DONORS).
//
//   node scripts/export-effect-templates.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readRifx, type Chunk } from "../src/aep/riff.ts";
import { freshInstance, projectDefinitions } from "../src/edit/effectTemplates.ts";
import { ChunkPacker } from "./lib/effect-templates.ts";

const DONORS = [
  process.env.AEP_EFFECT_DONOR,
  "refs/fixtures/fxextra.aep",
  "refs/probe-pp0.aep",
  "C:/Users/schxm/Downloads/TN 2020 2.aep",
].filter((p): p is string => !!p && existsSync(p));
const OUT = "src/extra/pmatch/data/effect-templates.json";
const EFFECTS = ["tc Particular", "ADBE Mirror", "S_Shake"];

const definitions = DONORS.map((path) => ({ path, defs: projectDefinitions(readRifx(new Uint8Array(readFileSync(path))).root) }));

function definitionOf(matchName: string): { definition: Chunk; source: string } {
  for (const { path, defs } of definitions) {
    const definition = defs.get(matchName);
    if (definition) return { definition, source: path };
  }
  throw new Error(`no donor defines ${matchName}; set AEP_EFFECT_DONOR to a project After Effects saved with it`);
}

const packer = new ChunkPacker();
const effects: Record<string, { source: string; definition: [number, number]; instance: [number, number] }> = {};
for (const matchName of EFFECTS) {
  const { definition, source } = definitionOf(matchName);
  const { sspc, summary } = freshInstance(matchName, definition);
  console.log(`${matchName} from ${source}: ${summary}`);
  effects[matchName] = { source: source.replace(/^.*[\\/]/, ""), definition: packer.add(definition), instance: packer.add(sspc) };
}
const { raw, gzipped, base64 } = packer.pack();
writeFileSync(OUT, JSON.stringify({ effects, data: base64 }) + "\n");
console.log(`${raw} bytes, ${gzipped} gzipped -> ${OUT}`);
