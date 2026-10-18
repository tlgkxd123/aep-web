// Prints the property values After Effects 2025 reads from a project (an ExtendScript run through
// scripts/ae-script.ts), to compare with what the parser reads: every leaf property of the layers of
// `comp`, as "layer > group > ... > match name = value".
//
//   node scripts/ae-dump-props.ts <file.aep> <comp> [match name filter]
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runScript } from "./ae-script.ts";

const [file, compName, filter = ""] = process.argv.slice(2);
if (!file || !compName) throw new Error("usage: node scripts/ae-dump-props.ts <file.aep> <comp> [match name filter]");
const forJsx = (path: string) => resolve(path).replace(/\\/g, "/");
const out = join(tmpdir(), `aep-web-props-${process.pid}.txt`);

const source = `
var out = new File(${JSON.stringify(forJsx(out))});
out.encoding = "UTF-8";
out.open("w");
function text(v) {
  if (v instanceof Array) return "[" + v.join(", ") + "]";
  if (v && v.vertices) return "path " + v.vertices.length + " vertices" + (v.closed ? " closed" : " open");
  return String(v);
}
function walk(group, prefix) {
  for (var i = 1; i <= group.numProperties; i++) {
    var p = group.property(i);
    var name = prefix + " > " + p.matchName;
    if (p.propertyType === PropertyType.PROPERTY) {
      if (${JSON.stringify(filter)} && p.matchName.indexOf(${JSON.stringify(filter)}) < 0) continue;
      var value;
      try { value = p.numKeys ? "keys " + p.numKeys + ", at 0: " + text(p.valueAtTime(0, true)) : text(p.value); } catch (e) { value = "(" + e + ")"; }
      out.writeln(name + " = " + value);
    } else walk(p, name);
  }
}
app.open(new File(${JSON.stringify(forJsx(file))}));
for (var i = 1; i <= app.project.numItems; i++) {
  var item = app.project.item(i);
  if (!(item instanceof CompItem) || item.name !== ${JSON.stringify(compName)}) continue;
  for (var l = 1; l <= item.numLayers; l++) walk(item.layer(l), item.layer(l).name);
}
out.close();
`;

const result = await runScript(source, { timeoutMs: 300_000 });
try {
  console.log(readFileSync(out, "utf8").trim());
  rmSync(out, { force: true });
} catch {
  console.log(result.output.trim());
  console.log("After Effects wrote nothing");
  process.exit(1);
}
