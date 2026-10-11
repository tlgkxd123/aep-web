// The Effects & Presets library: a template, as After Effects writes it, for every
// effect the renderer draws (data/effect-library.json, exported by
// scripts/export-effect-library.ts), loaded and unpacked once on first use. Effects the
// open project defines apply from its own definitions too.
import type { CompItem } from "../aep/model.ts";
import type { Chunk } from "../aep/riff.ts";
import { catalogName, offeredEffect } from "./effectCatalog.ts";
import type { Editor } from "./editor.ts";
import { addEffects, newInstance, type EffectTemplate } from "./effects.ts";
import { definitionName, freshInstance, nameAsDefined, projectDefinitions, streamPool } from "./effectTemplates.ts";
import { chunksFromBytes } from "./layer-templates.ts";

/** An effect the editor can apply. */
export interface ApplicableEffect {
  matchName: string;
  /** The name After Effects shows. */
  name: string;
  template: EffectTemplate;
}

export interface LibraryEffect extends ApplicableEffect {
  /** Its Effects & Presets category. */
  category: string;
}

/** Where an effect applies from: the library, or the definition the open project holds. */
export type EffectSource = "library" | "project";

let loading: Promise<LibraryEffect[]> | undefined;
let loaded: LibraryEffect[] | undefined;

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The library's effects, by category then name. */
export function effectLibrary(): Promise<LibraryEffect[]> {
  loading ??= (async () => {
    const { default: data } = await import("./effectLibraryData.ts");
    const raw = await gunzip(Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0)));
    const chunk = ([at, length]: number[]) => {
      const [only] = chunksFromBytes([raw.subarray(at, at + length)]);
      if (!only) throw new Error("an effect template is damaged");
      return only;
    };
    loaded = Object.entries(data.effects).map(([matchName, entry]) => {
      const instance = chunk(entry.instance);
      nameAsDefined(instance);
      return { matchName, name: entry.name, category: entry.category, template: { matchName, definition: chunk(entry.definition), instance } };
    });
    return loaded;
  })();
  return loading;
}

/** The library once `effectLibrary()` has loaded it. */
export const loadedEffectLibrary = (): LibraryEffect[] | undefined => loaded;

/** The match names of the effects a project defines (its LIST:EfdG). */
export const definedEffects = (root: Chunk): Set<string> => new Set(projectDefinitions(root).keys());

/** Where the effect applies from, given the library and the effects the project defines; undefined when it cannot be applied. */
export function effectSource(matchName: string, library: readonly LibraryEffect[] | undefined, defined: ReadonlySet<string>): EffectSource | undefined {
  if (library?.some((e) => e.matchName === matchName)) return "library";
  return defined.has(matchName) && offeredEffect(matchName) ? "project" : undefined;
}

const projectTemplates = new WeakMap<Chunk, EffectTemplate>();

/** An effect the project (`root`) defines, as a template from that definition, at its parameters' defaults. */
export function projectEffect(root: Chunk, matchName: string): ApplicableEffect | undefined {
  if (!offeredEffect(matchName)) return undefined;
  const definitions = projectDefinitions(root);
  const definition = definitions.get(matchName);
  if (!definition) return undefined;
  let template = projectTemplates.get(definition);
  if (!template) {
    template = { matchName, definition, instance: freshInstance(matchName, definition, streamPool(definitions)).sspc };
    projectTemplates.set(definition, template);
  }
  return { matchName, name: definitionName(definition) ?? catalogName(matchName) ?? matchName, template };
}

/** Applies an effect, at its defaults, to the end of each layer's effects, as one undoable step. */
export function applyLibraryEffect(editor: Editor, comp: CompItem, layerIds: number[], effect: ApplicableEffect): void {
  if (!layerIds.length) return;
  editor.perform(`Add ${effect.name}`, [comp], () => {
    for (const id of layerIds) addEffects(editor, comp, id, [{ template: effect.template, instance: newInstance(effect.template) }]);
  });
}
