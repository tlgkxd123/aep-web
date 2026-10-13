// Writes src/viz/data/schema.json: for each Avee Player element type the exporter writes
// (src/viz/export.ts), every property in the order, type and group Avee Player stores it,
// with a neutral value, read from templates' scene.json:
//
//   node scripts/viz-schema.ts <template.viz | unpacked folder | scene.json>...
//
// Only the format is kept: names, types, orders, groups and plain defaults. What a template
// shows (tags, images, compositions, shader code) is cleared.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readZip } from "../src/media/zip.ts";

const TYPES = ["Composition", "AudioProvider", "Image", "Bars", "BlurEffect", "MirrorEffect", "Particles", "CustomShader"];
/** Properties whose values are a template's content: written by the exporter, cleared here. */
const CONTENT: Record<string, unknown> = {
  _id: 0,
  tag: "",
  elementDescription: "",
  customImage: "",
  MaskImage: "",
  TargetImage: "",
  targetImage: "",
  sourceCompositionIndex: 0,
  audioProviderIndex: 1,
  shaderFragment: "",
  shaderVertex: "",
};

type Json = Record<string, unknown>;

async function sceneOf(path: string): Promise<Json> {
  const full = resolve(path);
  if (statSync(full).isDirectory()) return JSON.parse(readFileSync(join(full, "scene.json"), "utf8")) as Json;
  if (/\.json$/i.test(full)) return JSON.parse(readFileSync(full, "utf8")) as Json;
  const entries = await readZip(new Blob([readFileSync(full)]));
  const scene = entries.find((e) => e.path.endsWith("scene.json"));
  if (!scene) throw new Error(`${path} has no scene.json`);
  return JSON.parse(await (await scene.read()).text()) as Json;
}

const isProp = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value) && "t" in (value as Json);

/** A property with its content cleared, sub-properties kept (a shader's variables dropped but for the empty slot). */
function neutral(key: string, prop: Json): Json {
  if (prop.t === "_dyn") {
    const slot = Object.values(prop).find((v) => isProp(v) && (v as Json).v === "None") as Json | undefined;
    return { t: prop.t, o: prop.o, tag: prop.tag, newVariable: slot ? { ...slot, o: 0 } : { v: "None", t: "_child None Value Checkbox Texture", o: 0, tag: "dyn" } };
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(prop)) out[k] = isProp(v) ? neutral(k, v) : v;
  if (key in CONTENT) out.v = CONTENT[key];
  return out;
}

const schema: Record<string, Json> = {};
for (const path of process.argv.slice(2)) {
  const scene = await sceneOf(path);
  for (const comp of scene.compositions as Json[]) {
    if (!schema.Composition) {
      const { elements: _, ...rest } = comp;
      schema.Composition = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, isProp(v) ? neutral(k, v) : v]));
    }
    for (const element of comp.elements as Json[]) {
      const type = element.objType as string;
      if (!TYPES.includes(type)) continue;
      const known = (schema[type] ??= {});
      // The union over every element of the type, so properties newer templates add are kept.
      for (const [k, v] of Object.entries(element)) if (!(k in known)) known[k] = isProp(v) ? neutral(k, v) : v;
    }
  }
}
const missing = TYPES.filter((t) => !schema[t]);
if (missing.length) throw new Error(`no ${missing.join(", ")} element in the templates given`);
const out = resolve("src/viz/data/schema.json");
writeFileSync(out, `${JSON.stringify(schema, null, 1)}\n`);
console.log(`${out}: ${TYPES.map((t) => `${t} ${Object.keys(schema[t]).length}`).join(", ")}`);
