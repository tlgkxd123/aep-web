// Regenerates src/edit/data/effect-library.json, the Effects & Presets library: a template
// (src/edit/effectTemplates.ts) for every effect with a renderer registered in
// src/render/features.ts whose definition a project After Effects accepted holds, with
// its display name and Effects & Presets category.
//
// Definitions come from projects After Effects saved (AEP_EFFECT_DONOR, the py-aep
// corpus, the user's projects and Downloads, extra folders given), newest After Effects
// version first, then from fixture projects under refs/fixtures that aerender rendered.
// Renderers that only skip an effect whose plug-in After Effects lacks here, as After
// Effects does, get no template: applying one would draw nothing in either. Instances
// store every value parameter (those their definition leaves out are written at their
// defaults from a stream of the same kind), so each can be set in Effect Controls.
//
//   node scripts/export-effect-library.ts [folder...]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Layer, PropertyGroup } from "../src/aep/model.ts";
import { findChild, readRifx, type Chunk } from "../src/aep/riff.ts";
import "../src/render/features.ts";
import { effectRenderer, registeredEffects, type LayerImage, type RenderContext } from "../src/render/registry.ts";
import { effectCategory } from "../src/edit/effectCatalog.ts";
import { definitionName, freshInstance, projectDefinitions, streamPool } from "../src/edit/effectTemplates.ts";
import { ChunkPacker } from "./lib/effect-templates.ts";
import { PY_AEP } from "./lib/paths.ts";
import { framePath, loadSuites, ROOT } from "./lib/suites.ts";

export const LIBRARY = "src/edit/data/effect-library.json";
/** Fixture suites built from the library itself, which cannot vouch for it. */
const OWN_SUITES = new Set(["roundtrip"]);
/**
 * Plug-ins After Effects here lacks whose renderers draw the layer unchanged, as After Effects
 * does when it skips them, without saying so (aerender reports them as unavailable effects).
 */
const NOT_INSTALLED = new Set(["Keller.io Superpose 2"]);
/** The category of effects src/edit/effectCatalog.ts does not categorize. */
const OTHER = "Other";

export interface LibraryEntry {
  name: string;
  category: string;
  source: string;
  definition: [number, number];
  instance: [number, number];
}

export interface Library {
  effects: Record<string, LibraryEntry>;
  data: string;
}

export interface LibraryBuild {
  library: Library;
  /** Registered effects without a template, with the reason. */
  excluded: Map<string, string>;
  log: string[];
}

function* aeps(dir: string, depth = 0): Generator<string> {
  if (depth > 5) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) yield* aeps(path, depth + 1);
    else if (/\.aep$/i.test(name) && stat.size < 200e6) yield path;
  }
}

/** The After Effects version a project was saved with, as a sortable number (25.6 -> 2506). */
function savedVersion(root: Chunk): number {
  const head = findChild(root, "head");
  if (!head || head.data.length < 8) return 0;
  const word = new DataView(head.data.buffer, head.data.byteOffset).getUint32(4);
  return (((word >>> 26) & 0x1f) * 8 + ((word >>> 19) & 0x07)) * 100 + ((word >>> 15) & 0x0f);
}

interface Donor {
  path: string;
  version: number;
  /** Rendered by aerender rather than saved by After Effects. */
  fixture: boolean;
}

/** Projects After Effects saved, newest version first, then the fixtures aerender rendered. */
function donors(wanted: string[], folders: string[]): { donor: Donor; defs: Map<string, Chunk> }[] {
  const roots = [
    process.env.AEP_EFFECT_DONOR,
    join(PY_AEP, "samples"),
    "C:/Users/schxm/projects/_user",
    "C:/Users/schxm/Downloads",
    ...folders,
  ].filter((p): p is string => !!p);
  const found: { donor: Donor; defs: Map<string, Chunk> }[] = [];
  const seen = new Set<string>();
  const read = (path: string, fixture: boolean) => {
    const key = resolve(path).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      return;
    }
    if (!wanted.some((name) => bytes.includes(name))) return;
    try {
      const root = readRifx(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).root;
      const defs = projectDefinitions(root);
      if (defs.size) found.push({ donor: { path, version: savedVersion(root), fixture }, defs });
    } catch {
      // Not a project this reader understands.
    }
  };
  for (const root of roots) {
    if (statSync(root, { throwIfNoEntry: false })?.isFile()) read(root, false);
    else for (const path of aeps(root)) read(path, false);
  }
  for (const suite of loadSuites()) {
    if (OWN_SUITES.has(suite.file.replace(/\.?manifest\.json$/, ""))) continue;
    if (!suite.comps.some((c) => c.frames.length && c.frames.every((f) => statSync(framePath(c.comp, f), { throwIfNoEntry: false })))) continue;
    read(join(ROOT, "fixtures", suite.project), true);
  }
  // After Effects 2025 renders the references: projects it (or an earlier version) saved
  // come first, then fixtures it rendered, then projects a later version saved.
  const rank = (d: Donor) => (d.fixture ? 1 : d.version >= 2600 ? 2 : 0);
  return found.sort(
    (a, b) => rank(a.donor) - rank(b.donor) || b.donor.version - a.donor.version || a.donor.path.localeCompare(b.donor.path),
  );
}

const versionText = (v: number) => `${Math.floor(v / 100)}.${v % 100}`;

/** Whether the effect's renderer only reports a missing plug-in and passes the layer through. */
function onlySkips(matchName: string): boolean {
  const render = effectRenderer(matchName);
  if (!render) return false;
  const warnings: string[] = [];
  const known = { options: { approximateMissingPlugins: false, sapphireLookalikes: false }, warn: (m: string) => warnings.push(m) };
  const ctx = new Proxy(known, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      throw new Error(`the renderer uses ctx.${String(key)}`);
    },
  }) as unknown as RenderContext;
  const input = { width: 1, height: 1, origin: [0, 0] } as unknown as LayerImage;
  try {
    const out = render(input, { properties: [] } as unknown as PropertyGroup, {} as Layer, 0, ctx);
    return out === input && warnings.some((w) => /plugin is not installed; After Effects skips it/.test(w));
  } catch {
    return false;
  }
}

export function buildLibrary(folders: string[] = []): LibraryBuild {
  const log: string[] = [];
  const excluded = new Map<string, string>();
  const wanted: string[] = [];
  for (const matchName of registeredEffects().sort()) {
    if (NOT_INSTALLED.has(matchName) || onlySkips(matchName)) {
      excluded.set(matchName, "its plug-in is not installed in After Effects here; the renderer draws the layer unchanged, as After Effects does");
    } else wanted.push(matchName);
  }
  const sources = donors(wanted, folders);
  const pool = streamPool(sources.flatMap((s) => [...s.defs]));
  const packer = new ChunkPacker();
  const entries: [string, LibraryEntry][] = [];
  for (const matchName of wanted) {
    const from = sources.find((s) => s.defs.has(matchName));
    if (!from) {
      excluded.set(matchName, "no project After Effects saved or rendered defines it");
      continue;
    }
    const definition = from.defs.get(matchName)!;
    const { sspc, summary } = freshInstance(matchName, definition, pool);
    const category = effectCategory(matchName) ?? OTHER;
    if (category === OTHER) log.push(`${matchName}: no Effects & Presets category known; listed under ${OTHER}`);
    const source = from.donor.path.replace(/^.*[\\/]/, "");
    log.push(`${matchName} from ${from.donor.path} (${from.donor.fixture ? "fixture" : `After Effects ${versionText(from.donor.version)}`}): ${summary}`);
    const name = definitionName(definition) ?? matchName;
    entries.push([matchName, { name, category, source, definition: packer.add(definition), instance: packer.add(sspc) }]);
  }
  const { raw, gzipped, base64 } = packer.pack();
  log.push(`${raw} bytes, ${gzipped} gzipped`);
  const sorted = entries.sort(([a, x], [b, y]) => x.category.localeCompare(y.category) || x.name.localeCompare(y.name) || a.localeCompare(b));
  return { library: { effects: Object.fromEntries(sorted), data: base64 }, excluded, log };
}

export const libraryJson = (library: Library) => JSON.stringify(library, null, 1).replace(/\[\n\s+(\d+),\n\s+(\d+)\n\s+\]/g, "[$1, $2]") + "\n";

export function report({ library, excluded }: LibraryBuild): string[] {
  const lines = Object.entries(library.effects).map(([matchName, e]) => `  ${e.category.padEnd(20)} ${e.name.padEnd(28)} ${matchName}  (${e.source})`);
  return [
    `${lines.length} effects with templates:`,
    ...lines,
    `${excluded.size} rendered effects without a template:`,
    ...[...excluded].map(([matchName, reason]) => `  ${matchName}: ${reason}`),
    "  effects matched by a renderer prefix (Pseudo/...): pseudo effects belong to the presets that define them",
  ];
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const build = buildLibrary(process.argv.slice(2));
  for (const line of build.log) console.log(line);
  writeFileSync(LIBRARY, libraryJson(build.library));
  for (const line of report(build)) console.log(line);
  console.log(`wrote ${LIBRARY}`);
}
