// The effects After Effects 2025 lists in Effects & Presets: its own, by category, from
// py-aep's tables (src/aep/data, written by scripts/gen-match-names.ts), and plug-ins
// under their vendors' categories.
import categories from "../aep/data/effect-categories.json" with { type: "json" };
import names from "../aep/data/match-names.json" with { type: "json" };

export interface CatalogEffect {
  matchName: string;
  /** The name After Effects shows. */
  name: string;
  /** Its Effects & Presets category. */
  category: string;
}

export interface CatalogCategory {
  name: string;
  /** Its effects, by name. */
  effects: CatalogEffect[];
}

/**
 * py-aep's sections of effects Effects & Presets does not list: those tools create (Paint,
 * Roto Brush, Puppet) or older versions later ones replaced, and Color Finesse, which After
 * Effects 2025 does not install.
 */
const UNLISTED = new Set(["_Obsolete", "Synthetic Aperture"]);
/** After Effects' categories whose effects py-aep's tables do not name. */
const UNNAMED_CATEGORIES = ["Immersive Video"];
/** Plug-ins' Effects & Presets categories, by match name. */
const PLUGIN_CATEGORIES: Record<string, string> = {
  "Keller.io Superpose 2": "Keller.io",
  PEDG2: "Plugin Everything",
  "tc Form": "RG Trapcode",
  "tc Particular": "RG Trapcode",
  "tc Sound Keys": "RG Trapcode",
  "Videocopilot Twitch": "Video Copilot",
};

const CATEGORY: Partial<Record<string, string>> = categories;
const NAME: Partial<Record<string, string>> = names;

/** Whether Effects & Presets offers the effect: tools create some (Paint, Puppet), and projects keep older versions of others. */
export const offeredEffect = (matchName: string): boolean => !UNLISTED.has(CATEGORY[matchName] ?? "");

/** The Effects & Presets category of an effect, when known. */
export function effectCategory(matchName: string): string | undefined {
  const category = CATEGORY[matchName] ?? PLUGIN_CATEGORIES[matchName];
  return category && !UNLISTED.has(category) ? category : undefined;
}

/** The name After Effects shows for one of its own effects. */
export const catalogName = (matchName: string): string | undefined => NAME[matchName];

const FIRST_PARTY: CatalogEffect[] = Object.keys(CATEGORY).flatMap((matchName) => {
  const category = effectCategory(matchName);
  return category ? [{ matchName, name: NAME[matchName] ?? matchName, category }] : [];
});

const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

/** Effects & Presets' categories, alphabetically: After Effects' own effects, and the plug-ins among `more`. */
export function catalogCategories(more: readonly CatalogEffect[] = []): CatalogCategory[] {
  const effects = new Map(FIRST_PARTY.map((e) => [e.matchName, e]));
  for (const e of more) if (!effects.has(e.matchName)) effects.set(e.matchName, e);
  const grouped = new Map<string, CatalogEffect[]>(UNNAMED_CATEGORIES.map((c) => [c, []]));
  for (const e of effects.values()) grouped.set(e.category, [...(grouped.get(e.category) ?? []), e]);
  return [...grouped]
    .map(([name, list]) => ({ name, effects: list.sort((a, b) => byName(a.name, b.name)) }))
    .sort((a, b) => byName(a.name, b.name));
}
