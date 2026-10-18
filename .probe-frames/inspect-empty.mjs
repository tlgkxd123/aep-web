// Scratch: what the app's empty-project template already defines (Pefl / EfdG).
import { readFileSync } from "node:fs";
import { readRifx, findList, findChild } from "../src/aep/riff.ts";
import { projectDefinitions } from "../src/edit/effectTemplates.ts";

const data = JSON.parse(readFileSync("src/edit/data/project-templates.json", "utf8"));
const bytes = Uint8Array.from(atob(data.empty), (c) => c.charCodeAt(0));
const root = readRifx(bytes).root;

const text = (c) => (c ? new TextDecoder().decode(c.data).replace(/\0.*$/s, "") : undefined);

const pefl = findList(root, "Pefl");
console.log("Pefl entries:", (pefl?.children ?? []).map((c) => `${c.type}:${text(c)}`).join(", ") || "(none)");

const defs = projectDefinitions(root);
console.log("EfdG definitions:", [...defs.keys()].join(", ") || "(none)");

for (const [matchName, def] of defs) {
  const sspc = findList(def, "sspc");
  const parT = findList(sspc, "parT");
  const names = (parT?.children ?? []).filter((c) => c.type === "tdmn").map(text);
  console.log(`  ${matchName}: ${names.length} params -> ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""}`);
}
