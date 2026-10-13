// Effects added to layers from templates: an effect's definition (LIST:EfDf) and a
// fresh instance (LIST:sspc), as After Effects writes them. A project lists every
// effect it uses in its plug-in list (LIST:Pefl) and defines each once in LIST:EfdG;
// an instance is the effect's match name and its LIST:sspc in the layer's Effects
// group. Instances keep their full parameter list (parT): After Effects writes it
// only in the first instance of an effect but reads it in any, and the parser needs
// it in whichever instance it reaches first.
import { decodePard, type Pard } from "../aep/decode.ts";
import type { CompItem, Layer, PropertyGroup } from "../aep/model.ts";
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import { doubles, leaf, list, readDoubles, utf8Chunk, type Transaction } from "./chunks.ts";
import type { Editor } from "./editor.ts";
import { fixedUtf8, setExpressionFlags } from "./encode.ts";
import { layerTimebase, setTimebase, tdmnName } from "./layer-templates.ts";

export interface EffectTemplate {
  matchName: string;
  definition: Chunk;
  instance: Chunk;
}

const EFFECT_PARADE = "ADBE Effect Parade";
const GROUP_END = "ADBE Group End";
/** The name a group or effect stores when it has none of its own. */
export const UNNAMED = "-_0_/-";
/** Groups the Effects group comes before in a layer (Masks and the rest come before it). */
const AFTER_PARADE = new Set(["ADBE Essential Properties", "ADBE Transform Group"]);

export function clone(chunk: Chunk): Chunk {
  return { ...chunk, offset: -1, data: chunk.data.slice(), children: chunk.children?.map(clone) };
}

/** A fresh instance of the template, to fill in before `addEffects`. */
export function newInstance(template: EffectTemplate): Chunk {
  return clone(template.instance);
}

const paramName = (matchName: string, n: number) => `${matchName}-${String(n).padStart(4, "0")}`;

interface ParamDefinition {
  /** Position in the effect's parameter list. */
  order: number;
  pard: Pard;
}

const definitionCache = new WeakMap<Chunk, Map<string, ParamDefinition>>();

/** The parameter definitions (parT) of an instance, by match name. */
function definitions(sspc: Chunk): Map<string, ParamDefinition> {
  const parT = findList(sspc, "parT");
  if (!parT) throw new Error("the effect template has no parameter list");
  let defs = definitionCache.get(parT);
  if (defs) return defs;
  defs = new Map();
  let current = "";
  for (const c of parT.children ?? []) {
    if (c.type === "tdmn") current = tdmnName(c);
    else if (c.type === "pard") defs.set(current, { order: defs.size, pard: decodePard(c) });
  }
  definitionCache.set(parT, defs);
  return defs;
}

/** Index of the first child of the parameter list after `at` (the lists following a parameter's tdmn belong to it). */
function afterParam(children: Chunk[], at: number): number {
  let i = at + 1;
  while (i < children.length && children[i].type === "LIST") i++;
  return i;
}

/** The `listType` list (tdbs, or aRbs for arbitrary data) stored for parameter `name`. */
function paramList(tdgp: Chunk, name: string, listType: string): Chunk | undefined {
  const children = tdgp.children ?? [];
  const at = children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === name);
  if (at < 0) return undefined;
  return children.slice(at + 1, afterParam(children, at)).find((c) => c.listType === listType);
}

/** A tdsn payload: the name as a Utf8 chunk. */
export function nameData(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const data = new Uint8Array(8 + bytes.length + (bytes.length & 1));
  data.set(new TextEncoder().encode("Utf8"));
  new DataView(data.buffer).setUint32(4, bytes.length);
  data.set(bytes, 8);
  return data;
}

/** Names a tdsn. One read from a file holds its name as a child chunk, which is written instead of its data. */
export function setName(tdsn: Chunk, text: string): void {
  tdsn.data = nameData(text);
  tdsn.children = [utf8Chunk(text)];
}

/**
 * The tdbs of parameter `n`, written when the instance does not store it: After
 * Effects leaves parameters at their defaults out, and stores a changed one as it
 * stores every parameter of that control type, under its name with its slider range.
 */
function stream(sspc: Chunk, matchName: string, n: number): { tdbs: Chunk; pard: Pard } {
  const name = paramName(matchName, n);
  const defs = definitions(sspc);
  const def = defs.get(name);
  if (!def) throw new Error(`${matchName} has no parameter ${n}`);
  const tdgp = findList(sspc, "tdgp");
  if (!tdgp?.children) throw new Error("the effect template has no parameters");
  const existing = paramList(tdgp, name, "tdbs");
  if (existing) return { tdbs: existing, pard: def.pard };
  const children = tdgp.children;
  let donor: Chunk | undefined;
  let current = "";
  for (const c of children) {
    if (c.type === "tdmn") current = tdmnName(c);
    else if (c.listType === "tdbs" && defs.get(current)?.pard.controlType === def.pard.controlType && !findList(c, "list")) {
      donor = c;
      break;
    }
  }
  if (!donor) throw new Error(`no stored parameter of ${matchName} has the control type of ${name}`);
  const tdbs = clone(donor);
  tdbs.children = (tdbs.children ?? []).filter((c) => c.type !== "Utf8");
  for (const c of tdbs.children) {
    if (c.type === "tdsn") setName(c, def.pard.name);
    else if (c.type === "tdb4") setExpressionFlags(c.data, false, false);
    else if (c.type === "tdum" && def.pard.sliderMin !== undefined) c.data = doubles([def.pard.sliderMin]);
    else if (c.type === "tduM" && def.pard.sliderMax !== undefined) c.data = doubles([def.pard.sliderMax]);
    else if (c.type === "tdpi") c.data = new Uint8Array(c.data.length);
  }
  // In definition order: after the stored parameter defined last before it.
  let at = children.findIndex((c) => c.type === "tdmn");
  let before = -1;
  children.forEach((c, i) => {
    const order = c.type === "tdmn" ? (defs.get(tdmnName(c))?.order ?? -1) : -1;
    if (order >= 0 && order < def.order && order > before) {
      before = order;
      at = afterParam(children, i);
    }
  });
  children.splice(at < 0 ? children.length : at, 0, leaf("tdmn", fixedUtf8(name, 40)), tdbs);
  return { tdbs, pard: def.pard };
}

function storedValues(sspc: Chunk, matchName: string, n: number): { cdat: Chunk; values: number[]; pard: Pard } {
  const { tdbs, pard } = stream(sspc, matchName, n);
  const cdat = findChild(tdbs, "cdat");
  if (!cdat) throw new Error(`${paramName(matchName, n)} has no static value in the effect template`);
  return { cdat, values: readDoubles(cdat.data), pard };
}

/** Names an instance, as renaming an effect in Effect Controls does ("Bass" for a Slider Control). */
export function setInstanceName(sspc: Chunk, name: string): void {
  const tdsn = findChild(findList(sspc, "tdgp"), "tdsn");
  if (!tdsn) throw new Error("the effect template has no name");
  setName(tdsn, name);
}

/** Sets a static number, angle, popup choice (1-based) or checkbox (0, 1) of an instance, within its valid range. */
export function setInstanceNumber(sspc: Chunk, matchName: string, n: number, value: number): void {
  const { cdat, values, pard } = storedValues(sspc, matchName, n);
  const [min, max] = pard.optionCount ? [1, pard.optionCount] : [pard.min ?? -Infinity, pard.max ?? Infinity];
  values[0] = Math.max(min, Math.min(max, value));
  cdat.data = doubles(values);
}

/** Sets a static colour (0–1 RGB, opaque) of an instance. */
export function setInstanceColor(sspc: Chunk, matchName: string, n: number, rgb: readonly number[]): void {
  const { cdat, values } = storedValues(sspc, matchName, n);
  [values[0], values[1], values[2], values[3]] = [255, ...rgb.slice(0, 3).map((c) => Math.max(0, Math.min(1, c)) * 255)];
  cdat.data = doubles(values);
}

/** Sets a static point of an instance: x and y as shares of the layer's size, z (3D points) in pixels. */
export function setInstancePoint(sspc: Chunk, matchName: string, n: number, point: readonly number[]): void {
  const { cdat, values } = storedValues(sspc, matchName, n);
  point.forEach((v, i) => (values[i] = v));
  cdat.data = doubles(values);
}

/** Layer parameters set on instances, by parameter name: adding an instance points them again after clearing the rest. */
const layerReferences = new WeakMap<Chunk, Map<string, number>>();

function setReference(ref: Chunk, value: number): void {
  const data = ref.data.slice();
  new DataView(data.buffer).setInt32(0, value);
  ref.data = data;
}

/**
 * Points a layer parameter (the layer's id) or a mask parameter (the mask's 1-based index) of an instance, as
 * Editor.setLayerReference and setMaskReference point an effect's.
 */
export function setInstanceReference(sspc: Chunk, matchName: string, n: number, value: number): void {
  const { tdbs } = stream(sspc, matchName, n);
  const layer = findChild(tdbs, "tdpi");
  const ref = layer ?? findChild(tdbs, "tdli");
  if (!ref || ref.data.length < 4) throw new Error(`${paramName(matchName, n)} is not a layer or mask parameter`);
  setReference(ref, value);
  if (layer) {
    const refs = layerReferences.get(sspc) ?? new Map<string, number>();
    refs.set(paramName(matchName, n), value);
    layerReferences.set(sspc, refs);
  }
}

function arbitraryData(sspc: Chunk, matchName: string, n: number): Chunk | undefined {
  const tdgp = findList(sspc, "tdgp");
  return findChild(tdgp && paramList(tdgp, paramName(matchName, n), "aRbs"), "aRbp");
}

/** Replaces the arbitrary data (aRbp) of parameter `n` with `edit` of it. */
export function setInstanceData(sspc: Chunk, matchName: string, n: number, edit: (data: Uint8Array) => Uint8Array): void {
  const aRbp = arbitraryData(sspc, matchName, n);
  if (!aRbp) throw new Error(`${paramName(matchName, n)} holds no arbitrary data in the effect template`);
  aRbp.data = edit(aRbp.data);
}

/** Whether parameter `n` of an effect stores arbitrary data (curves) the editor can rewrite. */
export function hasEffectData(effect: PropertyGroup, n: number): boolean {
  return !!effect.chunk && !!arbitraryData(effect.chunk, effect.matchName, n);
}

/**
 * Replaces the arbitrary data (aRbp) of parameter `n` of an effect in `comp` with `edit` of it, as one undoable
 * step (consecutive steps with the same `coalesce` key, a drag, make one).
 */
export function setEffectData(
  editor: Editor,
  comp: CompItem,
  effect: PropertyGroup,
  n: number,
  edit: (data: Uint8Array) => Uint8Array,
  options: { label?: string; coalesce?: string } = {},
): void {
  const aRbp = effect.chunk && arbitraryData(effect.chunk, effect.matchName, n);
  if (!aRbp) throw new Error(`${paramName(effect.matchName, n)} holds no arbitrary data`);
  editor.perform(options.label ?? `Change ${effect.name}`, [comp], (tx) => tx.setData(aRbp, edit(aRbp.data)), { coalesce: options.coalesce });
}

const effectsGroup = (layer: Layer): Chunk | undefined => {
  const children = findList(layer.chunk, "tdgp")?.children ?? [];
  const at = children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === EFFECT_PARADE);
  return at >= 0 && children[at + 1]?.listType === "tdgp" ? children[at + 1] : undefined;
};

/** The layer's Effects group, written (empty) when the layer has none. */
function ensureEffectsGroup(tx: Transaction, layer: Layer): Chunk {
  const existing = effectsGroup(layer);
  if (existing) return existing;
  const root = findList(layer.chunk, "tdgp");
  if (!root?.children) throw new Error(`layer "${layer.name}" has no property groups`);
  const group = list("tdgp", [leaf("tdsb", new Uint8Array([0, 0, 0, 1])), leaf("tdsn", nameData(UNNAMED)), leaf("tdmn", fixedUtf8(GROUP_END, 40))]);
  const children = root.children;
  let at = children.findIndex((c) => c.type === "tdmn" && AFTER_PARADE.has(tdmnName(c)));
  if (at < 0) at = children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === GROUP_END);
  if (at < 0) at = children.length;
  tx.setChildren(root, [...children.slice(0, at), leaf("tdmn", fixedUtf8(EFFECT_PARADE, 40)), group, ...children.slice(at)]);
  return group;
}

/** Lists the effect in the project's plug-ins and definitions unless it is there. */
function register(tx: Transaction, root: Chunk, template: EffectTemplate): void {
  const name = template.matchName;
  const pefl = findList(root, "Pefl");
  if (!pefl) throw new Error("the project has no plug-in list (LIST:Pefl)");
  const listed = (pefl.children ?? []).some((c) => c.type === "pjef" && new TextDecoder().decode(c.data).replace(/\0.*$/s, "") === name);
  if (!listed) tx.setChildren(pefl, [...(pefl.children ?? []), leaf("pjef", new TextEncoder().encode(`${name}\0`))]);

  const efdg = findList(root, "EfdG");
  if (!efdg) {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, 1, true);
    const children = root.children ?? [];
    const at = children.indexOf(pefl) + 1;
    tx.setChildren(root, [...children.slice(0, at), list("EfdG", [leaf("EfDC", count), clone(template.definition)]), ...children.slice(at)]);
    return;
  }
  const defined = (efdg.children ?? []).some((c) => {
    const tdmn = c.listType === "EfDf" ? findChild(c, "tdmn") : undefined;
    return !!tdmn && tdmnName(tdmn) === name;
  });
  if (defined) return;
  tx.setChildren(efdg, [...(efdg.children ?? []), clone(template.definition)]);
  const efdc = findChild(efdg, "EfDC");
  if (efdc) {
    const count = (efdg.children ?? []).filter((c) => c.listType === "EfDf").length;
    tx.patch(efdc, (view) => view.setUint32(0, count, true), 4);
  }
}

/** Points every layer parameter at nothing, and the effect's own input (parameter 0) at its layer, as After Effects does. */
function bindLayer(sspc: Chunk, matchName: string, layerId: number): void {
  const children = findList(sspc, "tdgp")?.children ?? [];
  const own = paramName(matchName, 0);
  let current = "";
  for (const c of children) {
    if (c.type === "tdmn") current = tdmnName(c);
    else if (c.type === "LIST" && c.listType === "tdbs") {
      const tdpi = findChild(c, "tdpi");
      if (!tdpi || tdpi.data.length < 4) continue;
      const data = new Uint8Array(tdpi.data.length);
      new DataView(data.buffer).setInt32(0, current === own ? layerId : 0);
      tdpi.data = data;
    }
  }
}

/**
 * Appends effect instances (from `newInstance`, filled in) to the end of a layer's
 * Effects group, as one undoable step or one step of an enclosing `editor.perform`.
 */
export function addEffects(editor: Editor, comp: CompItem, layerId: number, effects: { template: EffectTemplate; instance: Chunk }[]): void {
  if (!effects.length) return;
  const label = effects.length > 1 ? "Add Effects" : `Add ${effects[0].template.matchName}`;
  editor.perform(label, [comp], (tx) => {
    const layer = comp.layers.find((l) => l.id === layerId);
    if (!layer) throw new Error(`layer ${layerId} is not in "${comp.name}"`);
    const timebase = layerTimebase(comp, layer);
    for (const { template } of effects) register(tx, editor.file.root, template);
    const group = ensureEffectsGroup(tx, layer);
    const added: Chunk[] = [];
    for (const { template, instance } of effects) {
      const sspc = clone(instance);
      bindLayer(sspc, template.matchName, layer.id);
      const tdgp = findList(sspc, "tdgp");
      for (const [name, id] of layerReferences.get(instance) ?? []) {
        const tdpi = findChild(tdgp && paramList(tdgp, name, "tdbs"), "tdpi");
        if (tdpi) setReference(tdpi, id);
      }
      setTimebase(sspc, timebase);
      added.push(leaf("tdmn", fixedUtf8(template.matchName, 40)), sspc);
    }
    const children = group.children ?? [];
    let end = children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === GROUP_END);
    if (end < 0) end = children.length;
    tx.setChildren(group, [...children.slice(0, end), ...added, ...children.slice(end)]);
  });
}
