// End-to-end check of the dev server's local footage endpoints: reads the token
// from the served page, locates a project's footage and downloads one file.
//
//   node scripts/check-local-footage.ts <project.aep> [http://localhost:5173]
import { readFileSync } from "node:fs";
import { parseProject } from "../src/aep/parse.ts";

const [path, base = "http://localhost:5173"] = process.argv.slice(2);
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const paths = [...project.items.values()].flatMap((i) => (i.kind === "footage" && i.mainSource.sourceType === "FileSource" ? [i.mainSource.file] : []));

const html = await (await fetch(base)).text();
const token = /name="aep-local-footage" content="([0-9a-f]+)"/.exec(html)?.[1];
if (!token) throw new Error("no token in the served page");
const denied = await fetch(`${base}/__aep/footage/locate`, { method: "POST", body: JSON.stringify({ token: "wrong", paths }) });
console.log(`wrong token -> ${denied.status}`);
const located = await fetch(`${base}/__aep/footage/locate`, { method: "POST", body: JSON.stringify({ token, paths }) });
const { results } = (await located.json()) as { results: { path: string; file: string | null }[] };
const found = results.filter((r) => r.file);
console.log(`located ${found.length}/${results.length}`);
const first = found[0];
if (first) {
  const r = await fetch(`${base}/__aep/footage/file?token=${token}&file=${encodeURIComponent(first.file!)}`);
  console.log(`read ${first.file}: ${r.status} ${r.headers.get("content-type")} ${(await r.arrayBuffer()).byteLength} bytes`);
}
const outside = await fetch(`${base}/__aep/footage/file?token=${token}&file=${encodeURIComponent("C:\\Windows\\win.ini")}`);
console.log(`unlisted file -> ${outside.status}`);
