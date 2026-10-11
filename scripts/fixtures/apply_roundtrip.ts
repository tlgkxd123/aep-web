// Builds refs/fixtures/roundtrip.aep: the roundtrip base project
// (scripts/fixtures/build_roundtrip.py) with every Effects & Presets library effect
// applied by the browser editor to the card of its comps, the way the UI applies it:
// at its defaults in roundtrip_<effect>, and with a few parameters set away from their
// defaults in roundtrip_<effect>_set. After Effects' renders of the saved file check
// that it opens and renders what the editor writes as the app renders it.
//
//   node scripts/fixtures/apply_roundtrip.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePard, type Pard } from "../../src/aep/decode.ts";
import type { CompItem } from "../../src/aep/model.ts";
import { findList, type Chunk } from "../../src/aep/riff.ts";
import { Editor } from "../../src/edit/editor.ts";
import { applyLibraryEffect, effectLibrary } from "../../src/edit/effectLibrary.ts";
import { addEffects, newInstance, setInstanceColor, setInstanceNumber, setInstancePoint } from "../../src/edit/effects.ts";
import { chunkText } from "../../src/edit/effectTemplates.ts";
import { LIBRARY, type Library } from "../export-effect-library.ts";
import { ROOT } from "../lib/suites.ts";

type Setting = [n: number, value: number | number[]];

/**
 * Parameters set in each roundtrip_<effect>_set comp, by parameter number: numbers,
 * angles, popups (1-based) and checkboxes as numbers; colours as RGB; points as shares
 * of the layer's size (3D points with z in pixels). The values stay within what each
 * renderer's own suite verifies, so a difference points at how the file is written.
 */
const SETTINGS: Record<string, Setting[]> = {
  "ADBE Box Blur2": [[1, 6], [2, 2], [3, 2], [4, 0]],
  "ADBE Minimax": [[1, 1], [2, 3], [4, 2]],
  "ADBE Remove Color Matting": [[1, [1, 1, 1]], [2, 0]],
  "ADBE Mirror": [[1, [0.35, 0.6]], [2, 30]],
  "ADBE Polar Coordinates": [[1, 0.6], [2, 1]],
  "ADBE Point3D Control": [[1, [0.25, 0.75, 40]]],
  "ADBE Angle Control": [[1, 45]],
  "ADBE Checkbox Control": [[1, 1]],
  "ADBE Color Control": [[1, [0.2, 0.6, 0.9]]],
  "ADBE Point Control": [[1, [0.2, 0.3]]],
  "ADBE Slider Control": [[1, 37.5]],
  "ADBE AudSpect": [[2, [0.1, 0.3]], [3, [0.9, 0.7]], [9, 200], [12, 6], [20, 2]],
  "ADBE Ramp": [[1, [0.1, 0.2]], [2, [0.9, 0.2, 0.1]], [3, [0.8, 0.9]], [4, [0.1, 0.3, 0.9]], [5, 2], [7, 0.25]],
  "Keller.io Superpose 2": [[3, 2], [4, 5]],
  "Keylight 906": [[4, [0, 0.2, 1]], [12, 10], [13, 70]],
  PEDG2: [[17, 60], [18, 1.05], [20, 50]],
  "tc Particular": [[146, 400], [11, 250]],
  "tc Sound Keys": [[4, 2], [8, 1.5]],
  "CS Vignette": [[1, 60], [2, 70], [3, [0.4, 0.6]], [5, 30]],
};

/** The parameter definitions of an effect, by parameter number, in their order. */
function parameters(matchName: string, definition: Chunk): Map<number, Pard> {
  const found = new Map<number, Pard>();
  let current = "";
  for (const c of findList(findList(definition, "sspc"), "parT")?.children ?? []) {
    if (c.type === "tdmn") current = chunkText(c);
    else if (c.type === "pard" && current.startsWith(`${matchName}-`)) found.set(Number(current.slice(matchName.length + 1)), decodePard(c));
  }
  return found;
}

/**
 * Effects whose renderers only approximate After Effects: their comps are rendered by
 * After Effects (refs/fixtures/roundtrip.approximations.json) and measured by
 * scripts/roundtrip-approx-report.ts, outside the pixel gate.
 */
const APPROXIMATED: Record<string, string> = {
  PEDG2: "Deep Glow's renderer is not pixel-verified yet (most deepglow suite frames still differ)",
  "tc Particular": "Particular is drawn with a seeded look-alike; particle positions do not match After Effects",
  "tc Sound Keys": "Sound Keys draws its own spectrum/output display over the layer; only its grid and bars are imitated",
};

/** For an effect without SETTINGS: up to three of its first visible numbers, angles, popups, checkboxes, colours or points, moved off their defaults. */
function someSettings(params: Map<number, Pard>): Setting[] {
  const settings: Setting[] = [];
  for (const [n, p] of params) {
    if (!n || p.invisible || settings.length >= 3) continue;
    const d = typeof p.defaultValue === "number" ? p.defaultValue : 0;
    if (p.optionCount && p.optionCount > 1) settings.push([n, d === 1 ? 2 : 1]);
    else if (p.controlType === 4) settings.push([n, d ? 0 : 1]);
    else if (p.controlType === 3) settings.push([n, d + 30]);
    else if (p.controlType === 5) settings.push([n, [0.9, 0.3, 0.2]]);
    else if (p.controlType === 6) settings.push([n, [0.35, 0.65]]);
    else if ([1, 2, 10].includes(p.controlType)) {
      const lo = p.sliderMin ?? p.min ?? 0;
      const hi = p.sliderMax ?? p.max ?? d + 1;
      settings.push([n, d + (hi - lo) / 3 <= hi ? d + (hi - lo) / 3 : d - (hi - lo) / 3]);
    }
  }
  return settings;
}

const FIXTURES = join(ROOT, "fixtures");
const base = JSON.parse(readFileSync(join(FIXTURES, "roundtrip.base.json"), "utf8")) as {
  comps: { comp: string; frames: number[]; fps: number }[];
  effects: Record<string, string[]>;
};
const editor = Editor.fromBytes(new Uint8Array(readFileSync(join(FIXTURES, "roundtrip.base.aep"))));
const compNamed = (name: string): CompItem => {
  const found = [...editor.project.items.values()].find((i) => i.kind === "comp" && i.name === name);
  if (!found) throw new Error(`no comp "${name}"`);
  return found as CompItem;
};

// Look-alikes of plug-ins After Effects lacks here (Sapphire) are left out: it cannot render them.
const { effects: entries } = JSON.parse(readFileSync(LIBRARY, "utf8")) as Library;
const library = (await effectLibrary()).filter((e) => !entries[e.matchName]?.lookalike);
const unknown = Object.keys(base.effects).filter((m) => !library.some((e) => e.matchName === m));
const missing = library.filter((e) => !(e.matchName in base.effects)).map((e) => e.matchName);
if (unknown.length || missing.length) {
  throw new Error(`roundtrip.base.aep is not built from this library (${[...unknown, ...missing].join(", ")}); run build_roundtrip.py`);
}
for (const effect of library) {
  const [plain, set] = base.effects[effect.matchName];
  const comp = compNamed(plain);
  applyLibraryEffect(editor, comp, [comp.layers[0].id], effect);
  if (!set) continue;
  const target = compNamed(set);
  const instance = newInstance(effect.template);
  const params = parameters(effect.matchName, effect.template.definition);
  const settings = SETTINGS[effect.matchName] ?? someSettings(params);
  for (const [n, value] of settings) {
    const type = params.get(n)?.controlType;
    if (typeof value === "number") setInstanceNumber(instance, effect.matchName, n, value);
    else if (type === 5) setInstanceColor(instance, effect.matchName, n, value);
    else if (type === 6 || type === 18) setInstancePoint(instance, effect.matchName, n, value);
    else throw new Error(`${effect.matchName} parameter ${n} is not a colour or point`);
  }
  addEffects(editor, target, target.layers[0].id, [{ template: effect.template, instance }]);
  console.log(`${set}: ${settings.map(([n, v]) => `${n}=${JSON.stringify(v)}`).join(" ")}`);
}

writeFileSync(join(FIXTURES, "roundtrip.aep"), editor.save());
let previous: { known?: Record<string, string> } = {};
try {
  previous = JSON.parse(readFileSync(join(FIXTURES, "roundtrip.manifest.json"), "utf8"));
} catch {
  // First build.
}
const effectOf = new Map(Object.entries(base.effects).flatMap(([matchName, comps]) => comps.map((c) => [c, matchName] as const)));
const approximated = base.comps.filter((c) => APPROXIMATED[effectOf.get(c.comp)!]);
const gated = base.comps.filter((c) => !approximated.includes(c));
const manifest = { project: "roundtrip.aep", comps: gated, ...(previous.known && { known: previous.known }) };
writeFileSync(join(FIXTURES, "roundtrip.manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
const reasons = Object.fromEntries(approximated.map((c) => [c.comp, APPROXIMATED[effectOf.get(c.comp)!]]));
writeFileSync(
  join(FIXTURES, "roundtrip.approximations.json"),
  JSON.stringify({ project: "roundtrip.aep", comps: approximated, reasons }, null, 1) + "\n",
);
console.log(`wrote roundtrip.aep: ${library.length} effects, ${gated.length} comps in the pixel gate, ${approximated.length} approximated`);
