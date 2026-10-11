// Generates the effect donors: refs/fixtures/donors/ae2025-effects.aep, a project After Effects 2025
// itself builds and saves (an ExtendScript run through scripts/ae-script.ts, no UI), with one solid
// per effect After Effects lists (app.effects) holding that effect as applied, at its factory
// defaults. Its definitions (LIST:EfdG) are what fixtures (scripts/fixtures/aepfix.py) and the effect
// library (scripts/export-effect-library.ts) clone effects from. Also writes
// refs/fixtures/donors/ae2025-effects.json: every listed effect (match name, name and category as
// this After Effects shows them, its version) and whether it could be applied to a solid.
//
//   node scripts/ae-donors.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readRifx } from "../src/aep/riff.ts";
import { projectDefinitions } from "../src/edit/effectTemplates.ts";
import { runScript } from "./ae-script.ts";
import { ROOT } from "./lib/suites.ts";

const DIR = join(ROOT, "fixtures", "donors");
export const DONOR_PROJECT = join(DIR, "ae2025-effects.aep");
const SUMMARY = join(DIR, "ae2025-effects.json");
/** Effects that apply only to layers with audio. */
const AUDIO = /^ADBE (Aud[ _]|Param EQ)/;
/** Effects whose application never returns in a script run without the UI (Apply Color LUT asks for a file). */
const SKIP = new Set<string>(["ADBE Apply Color LUT2", ...(process.env.AE_DONOR_SKIP?.split(",") ?? [])]);

const forJsx = (path: string) => resolve(path).replace(/\\/g, "/");

function script(projectPath: string, logPath: string): string {
  return `
var logFile = new File(${JSON.stringify(forJsx(logPath))});
function record(fields) {
  var parts = [];
  for (var k in fields) {
    var v = fields[k];
    parts.push('"' + k + '":' + (typeof v === "string" ? '"' + v.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"').replace(/[\\r\\n]+/g, " ") + '"' : String(v)));
  }
  logFile.encoding = "UTF-8";
  logFile.open("a");
  logFile.writeln("{" + parts.join(",") + "}");
  logFile.close();
}
logFile.encoding = "UTF-8";
logFile.open("w");
logFile.close();
var skip = ${JSON.stringify(Object.fromEntries([...SKIP].map((m) => [m, true])))};
app.newProject();
var project = app.project;
var effects = [];
for (var i = 0; i < app.effects.length; i++) effects.push(app.effects[i]);
var comp = null;
var count = 0;
var comps = 0;
for (var i = 0; i < effects.length; i++) {
  var e = effects[i];
  var fields = { matchName: e.matchName, name: e.displayName, category: e.category, version: e.version };
  if (${AUDIO.toString()}.test(e.matchName) || skip[e.matchName]) {
    fields.added = false;
    fields.error = skip[e.matchName] ? "skipped: applying it does not return without the UI" : "audio effect";
    record(fields);
    continue;
  }
  record({ applying: e.matchName, at: new Date().getTime() });
  if (comp === null || count >= 40) {
    comps++;
    comp = project.items.addComp("donors " + comps, 64, 48, 1, 1, 24);
    count = 0;
  }
  try {
    var layer = comp.layers.addSolid([0.5, 0.5, 0.5], String(i), 64, 48, 1);
    var parade = layer.property("ADBE Effect Parade");
    if (!parade.canAddProperty(e.matchName)) {
      layer.remove();
      fields.added = false;
      fields.error = "cannot be applied to a solid";
    } else {
      var fx = parade.addProperty(e.matchName);
      count++;
      fields.added = true;
      fields.params = fx.numProperties;
    }
  } catch (err) {
    fields.added = false;
    fields.error = String(err);
  }
  record(fields);
}
project.save(new File(${JSON.stringify(forJsx(projectPath))}));
record({ saved: true });
`;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  mkdirSync(DIR, { recursive: true });
  const log = join(DIR, "ae2025-effects.log");
  let lines: Record<string, unknown>[] = [];
  for (let attempt = 0; ; attempt++) {
    rmSync(DONOR_PROJECT, { force: true });
    const result = await runScript(script(DONOR_PROJECT, log), { timeoutMs: 30 * 60_000, progressFile: log, idleMs: 120_000 });
    lines = readFileSync(log, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    if (!result.timedOut && lines.some((l) => l.saved)) break;
    // The effect being applied when After Effects stopped answering is skipped next time.
    const last = lines.at(-1);
    if (attempt > 8 || !last?.applying) {
      console.log(result.output.trim());
      console.log(`After Effects ${result.timedOut ? "timed out" : "did not save the project"} after ${lines.length} records`);
      process.exit(1);
    }
    console.log(`applying ${last.applying} did not return; skipping it`);
    SKIP.add(String(last.applying));
  }
  rmSync(log, { force: true });
  const bytes = readFileSync(DONOR_PROJECT);
  const defined = projectDefinitions(readRifx(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).root);
  const started = new Map(lines.filter((l) => l.applying).map((l) => [l.applying, Number(l.at)]));
  const effects: Record<string, unknown>[] = lines.filter((l) => l.matchName).map((l) => ({ ...l, defined: defined.has(String(l.matchName)) }));
  writeFileSync(SUMMARY, JSON.stringify({ project: "ae2025-effects.aep", skipped: [...SKIP], effects }, null, 1) + "\n");
  const slow = [...started].map(([m, t], i, all) => [m, (all[i + 1]?.[1] ?? t) - t] as const).filter(([, ms]) => ms > 5000);
  for (const [m, ms] of slow) console.log(`  slow: ${m} ${(ms / 1000).toFixed(1)} s`);
  const added = effects.filter((e) => e.added).length;
  console.log(`${effects.length} effects listed, ${added} applied, ${defined.size} defined in ${DONOR_PROJECT}`);
  for (const e of effects.filter((e) => !e.added)) console.log(`  not applied: ${e.matchName} (${e.name}): ${e.error}`);
  for (const e of effects.filter((e) => e.added && !e.defined)) console.log(`  applied but not defined: ${e.matchName} (${e.name})`);
}
