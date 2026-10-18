// Scratch: which template blocks define or use app-native (AEPW / tc) effects, and how a
// project that Particle Match writes defines them. Read-only inspection.
import { readFileSync, readdirSync } from "node:fs";
import { readRifx, findList, findChild } from "../src/aep/riff.ts";
import { projectDefinitions } from "../src/edit/effectTemplates.ts";

const data = JSON.parse(readFileSync("src/edit/data/project-templates.json", "utf8"));
const text = (c) => (c ? new TextDecoder().decode(c.data).replace(/\0.*$/s, "") : undefined);

const decode = (b64) => readRifx(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))).root;

for (const key of Object.keys(data.blocks)) {
  const root = decode(data.blocks[key]);
  const defs = [...projectDefinitions(root).keys()];
  const pefl = findList(root, "Pefl");
  const plugins = (pefl?.children ?? []).map(text);
  console.log(`${key}: definitions=[${defs.join(", ")}] pefl=[${plugins.join(", ")}]`);
}
