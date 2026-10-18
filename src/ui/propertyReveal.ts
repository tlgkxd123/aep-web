// After Effects' shortcuts that show only some of a layer's properties in the Timeline (A, P, S, R and T the Transform
// ones, M the mask paths, E the effects, U the keyframed properties...): what each shows, and the store through which
// the keys and the menus reach the Timeline of a comp.
import type { CompItem, Layer, Property, PropertyValue } from "../aep/model.ts";
import { specDefault } from "../aep/synthesize.ts";
import { effectRenderer } from "../render/registry.ts";
import { outlineChildren, paramDef, type DisplayNode, type OutlineContext } from "./properties.ts";

export type RevealKind =
  | "anchor"
  | "position"
  | "scale"
  | "rotation"
  | "opacity"
  | "maskPath"
  | "masks"
  | "maskFeather"
  | "maskOpacity"
  | "effects"
  | "missingEffects"
  | "expressions"
  | "keyframes"
  | "animation"
  | "modified"
  | "audioLevels"
  | "timeRemap"
  | "material"
  | "selected";

export interface RevealSpec {
  kind: RevealKind;
  label: string;
  /** Its shortcut: a letter, or the letter pressed twice. */
  keys?: string;
}

/** In After Effects' order (Help > Keyboard Shortcuts, "Showing properties in the Timeline panel"). */
export const REVEALS: readonly RevealSpec[] = [
  { kind: "anchor", label: "Anchor Point", keys: "A" },
  { kind: "position", label: "Position", keys: "P" },
  { kind: "scale", label: "Scale", keys: "S" },
  { kind: "rotation", label: "Rotation and Orientation", keys: "R" },
  { kind: "opacity", label: "Opacity", keys: "T" },
  { kind: "maskPath", label: "Mask Path", keys: "M" },
  { kind: "masks", label: "Mask Properties", keys: "MM" },
  { kind: "maskFeather", label: "Mask Feather", keys: "F" },
  { kind: "maskOpacity", label: "Mask Opacity", keys: "TT" },
  { kind: "effects", label: "Effects", keys: "E" },
  { kind: "missingEffects", label: "Missing Effects", keys: "FF" },
  { kind: "expressions", label: "Expressions", keys: "EE" },
  { kind: "keyframes", label: "Properties with Keyframes", keys: "U" },
  { kind: "animation", label: "Properties with Animation" },
  { kind: "modified", label: "Modified Properties", keys: "UU" },
  { kind: "audioLevels", label: "Audio Levels", keys: "L" },
  { kind: "timeRemap", label: "Time Remap", keys: "RR" },
  { kind: "material", label: "Material Options", keys: "AA" },
  { kind: "selected", label: "Selected Properties", keys: "SS" },
];

const BY_KEYS = new Map(REVEALS.flatMap((r) => (r.keys ? [[r.keys, r.kind] as const] : [])));

/** The reveal a key asks for: `letter` pressed once, or twice in quick succession with `twice`. */
export function revealForKey(letter: string, twice: boolean): RevealKind | undefined {
  const key = letter.toUpperCase();
  return (twice ? BY_KEYS.get(key + key) : undefined) ?? BY_KEYS.get(key);
}

const TRANSFORM_KINDS: Partial<Record<RevealKind, ReadonlySet<string>>> = {
  anchor: new Set(["ADBE Anchor Point"]),
  position: new Set(["ADBE Position", "ADBE Position_0", "ADBE Position_1", "ADBE Position_2"]),
  scale: new Set(["ADBE Scale"]),
  rotation: new Set(["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z"]),
  opacity: new Set(["ADBE Opacity"]),
};

const MASK_KINDS: Partial<Record<RevealKind, string>> = { maskPath: "ADBE Mask Shape", maskFeather: "ADBE Mask Feather", maskOpacity: "ADBE Mask Opacity" };

/** What a layer of the Timeline shows: the reveals asked for, and for "selected" the rows selected at the time. */
export interface LayerReveal {
  kinds: readonly RevealKind[];
  selected?: ReadonlySet<string>;
}

/** A row a revealed layer lists, with whether a group row is shown open (its revealed children follow it). */
export interface RevealRow {
  node: DisplayNode;
  key: string;
  depth: number;
  open: boolean;
}

/** Where in the outline a row sits, for the reveals that depend on it. */
interface Within {
  mask: boolean;
  material: boolean;
  transform: boolean;
  effect?: string;
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

function sameValue(value: PropertyValue, other: PropertyValue | undefined): boolean {
  if (other === undefined || other === null || value === null) return value === other;
  if (typeof value === "number") return typeof other === "number" ? close(value, other) : Array.isArray(other) && close(value, other[0]);
  if (!Array.isArray(value)) return false;
  const list = typeof other === "number" ? [other] : Array.isArray(other) ? other : null;
  return !!list && value.every((v, i) => i >= list.length || close(v, list[i]));
}

/** After Effects' default for a Transform property of `layer` (what Layer > Transform > Reset gives it). */
function transformDefault(prop: Property, layer: Layer, comp: CompItem): PropertyValue | undefined {
  if (prop.matchName === "ADBE Anchor Point") return layer.sourceId && layer.width > 0 && layer.height > 0 ? [layer.width / 2, layer.height / 2, 0] : [0, 0, 0];
  if (prop.matchName === "ADBE Position") return [comp.width / 2, comp.height / 2, 0];
  if (prop.matchName === "ADBE Position_0") return comp.width / 2;
  if (prop.matchName === "ADBE Position_1") return comp.height / 2;
  return specDefault(prop.matchName);
}

/**
 * Whether a property differs from what After Effects gives a new one: keyframed, with an expression, or set to
 * another value. A stored property whose default is not known counts as changed, as After Effects stores what was set.
 */
function isModified(prop: Property, within: Within, ctx: OutlineContext, comp: CompItem): boolean {
  if (prop.keyframes.length || prop.expression) return true;
  if (prop.synthesized) return false;
  const fallback = within.transform ? transformDefault(prop, ctx.layer, comp) : within.effect ? paramDef(ctx.project, within.effect, prop.matchName)?.defaultValue : specDefault(prop.matchName);
  return fallback === undefined || !sameValue(prop.value, fallback);
}

/**
 * The rows a layer lists for its reveals, in outline order: properties directly (the Transform group's under the
 * layer, as After Effects shows them), each under the groups that hold it; Effects lists its effects closed.
 */
export function revealedRows(ctx: OutlineContext, comp: CompItem, nodes: DisplayNode[], layerKey: string, reveal: LayerReveal): RevealRow[] {
  const kinds = new Set(reveal.kinds);
  const rows: RevealRow[] = [];
  const shows = (prop: Property, key: string, within: Within): boolean => {
    for (const kind of kinds) {
      const transform = TRANSFORM_KINDS[kind];
      if (transform) {
        if (within.transform && transform.has(prop.matchName)) return true;
        continue;
      }
      const mask = MASK_KINDS[kind];
      if (mask) {
        if (within.mask && prop.matchName === mask) return true;
        continue;
      }
      switch (kind) {
        case "masks":
          if (within.mask) return true;
          break;
        case "material":
          if (within.material) return true;
          break;
        case "expressions":
          if (prop.expression) return true;
          break;
        case "keyframes":
          if (prop.keyframes.length) return true;
          break;
        case "animation":
          if (prop.keyframes.length || prop.expression) return true;
          break;
        case "modified":
          if (isModified(prop, within, ctx, comp)) return true;
          break;
        case "audioLevels":
          if (prop.matchName === "ADBE Audio Levels") return true;
          break;
        case "timeRemap":
          if (prop.matchName === "ADBE Time Remapping") return true;
          break;
        case "selected":
          if (reveal.selected?.has(key)) return true;
          break;
      }
    }
    return false;
  };
  /** Group rows shown closed when nothing inside them is revealed. */
  const showsClosed = (node: DisplayNode, key: string): boolean => {
    if (node.kind === "group" && node.group.isEffect) {
      if (kinds.has("effects")) return true;
      if (kinds.has("missingEffects") && !effectRenderer(node.group.matchName)) return true;
    }
    return kinds.has("selected") && !!reveal.selected?.has(key);
  };
  const walk = (list: DisplayNode[], depth: number, parentKey: string, within: Within): boolean => {
    let any = false;
    for (const node of list) {
      const key = `${parentKey}/${node.key}`;
      if (node.kind === "property") {
        if (shows(node.prop, key, within)) {
          rows.push({ node, key, depth, open: false });
          any = true;
        }
        continue;
      }
      const group = node.kind === "group" ? node.group : undefined;
      if (group?.matchName === "ADBE Transform Group") {
        if (walk(outlineChildren(node, ctx), depth, key, { ...within, transform: true })) any = true;
        continue;
      }
      const at = rows.length;
      rows.push({ node, key, depth, open: true });
      const inner: Within = {
        mask: within.mask || (node.kind === "group" && node.role === "mask"),
        material: within.material || group?.matchName === "ADBE Material Options Group",
        transform: false,
        effect: group?.isEffect ? group.matchName : within.effect,
      };
      if (walk(outlineChildren(node, ctx), depth + 1, key, inner)) {
        any = true;
      } else if (showsClosed(node, key)) {
        rows[at].open = false;
        any = true;
      } else {
        rows.length = at;
      }
    }
    return any;
  };
  walk(nodes, 1, layerKey, { mask: false, material: false, transform: false });
  return rows;
}

type CompReveals = ReadonlyMap<number, LayerReveal>;

let reveals: ReadonlyMap<number, CompReveals> = new Map();
const selections = new Map<number, ReadonlySet<string>>();
const listeners = new Set<() => void>();

function setComp(compId: number, next: CompReveals): void {
  const all = new Map(reveals);
  if (next.size) all.set(compId, next);
  else all.delete(compId);
  reveals = all;
  for (const l of listeners) l();
}

const sameKinds = (reveal: LayerReveal | undefined, kinds: readonly RevealKind[]) =>
  !!reveal && reveal.kinds.length === kinds.length && kinds.every((k) => reveal.kinds.includes(k));

/** The reveals of every comp's Timeline, by comp id and layer id. */
export const propertyReveals = {
  get: (): ReadonlyMap<number, CompReveals> => reveals,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** The property rows selected in a comp's Timeline, which "selected" shows. */
  noteSelection(compId: number, keys: ReadonlySet<string>): void {
    selections.set(compId, keys);
  },
  /**
   * After Effects' reveal shortcut on `layers` (the selected ones, or all of them when none is): only `kind`, or, with
   * `add` (Shift), `kind` added to or taken from what each shows. Asked again for layers that show only `kind`, it
   * closes them.
   */
  request(comp: CompItem, layers: readonly Layer[], kind: RevealKind, add = false): void {
    const current = reveals.get(comp.id) ?? new Map<number, LayerReveal>();
    const next = new Map(current);
    const selected = selections.get(comp.id);
    const snapshot = (layer: Layer) => (kind === "selected" ? new Set([...(selected ?? [])].filter((k) => k.startsWith(`L${layer.id}/`))) : undefined);
    if (!add) {
      const closing = layers.length > 0 && layers.every((l) => sameKinds(current.get(l.id), [kind]));
      for (const layer of layers) {
        if (closing) next.delete(layer.id);
        else next.set(layer.id, { kinds: [kind], selected: snapshot(layer) });
      }
    } else {
      for (const layer of layers) {
        const was = current.get(layer.id);
        const kinds = was?.kinds.includes(kind) ? was.kinds.filter((k) => k !== kind) : [...(was?.kinds ?? []), kind];
        if (kinds.length) next.set(layer.id, { kinds, selected: kind === "selected" ? snapshot(layer) : was?.selected });
        else next.delete(layer.id);
      }
    }
    setComp(comp.id, next);
  },
  /** Back to the layer's ordinary twirl-downs. */
  clear(compId: number, layerId: number): void {
    const current = reveals.get(compId);
    if (!current?.has(layerId)) return;
    const next = new Map(current);
    next.delete(layerId);
    setComp(compId, next);
  },
};

/** The layers a reveal shortcut acts on: the selected one, or every layer when none is. */
export const revealTargets = (comp: CompItem, selected: Layer | undefined): Layer[] => (selected ? [selected] : comp.layers);
