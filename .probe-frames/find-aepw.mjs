// Scratch: search the app's shipped template data (base64) for app-native effect names, and
// work out how "AEPW Particle Match" is authored into projects. Read-only.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const hits = (label, bytes) => {
  const ascii = Buffer.from(bytes).toString("latin1");
  const found = new Set();
  for (const m of ascii.matchAll(/AEPW[ -~]{0,40}/g)) found.add(m[0].replace(/\0+$/, ""));
  if (found.size) console.log(`${label}: ${[...found].join(" | ")}`);
};

const templates = JSON.parse(readFileSync("src/edit/data/project-templates.json", "utf8"));
for (const [key, b64] of Object.entries(templates.blocks)) hits(`project-templates/${key}`, Buffer.from(b64, "base64"));
hits("project-templates/empty", Buffer.from(templates.empty, "base64"));

const lib = JSON.parse(readFileSync("src/edit/data/effect-library.json", "utf8"));
console.log(`effect-library.json: ${Object.keys(lib.effects).length} entries`);
hits("effect-library", gunzipSync(Buffer.from(lib.data, "base64")));
console.log("AEPW entries in library:", Object.keys(lib.effects).filter((k) => k.startsWith("AEPW")).join(", ") || "(none)");
console.log("Extra-category entries:", Object.entries(lib.effects).filter(([, e]) => e.category === "Extra").map(([k]) => k).join(", ") || "(none)");
