// Properties After Effects left out of the file because they held their default
// (unchanged effect parameters, Transform properties) are filled in by the parser
// as `synthesized`. Before one is edited its chunks are written: Transform ones
// from AE's templates, effect parameters by copying how another stored instance of
// the same parameter (or one of the same kind) is written in the project.
import type { CompItem, Layer, Project, Property, PropertyGroup, PropertyNode, PropertyValue } from "../aep/model.ts";
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import { leaf, type Transaction } from "./chunks.ts";
import type { CommandOptions, Editor } from "./editor.ts";
import { fixedUtf8, setExpressionFlags, stampTimeBase } from "./encode.ts";
import { layerTimebase } from "./layer-templates.ts";
import { editable, isTransformValue } from "./transform-ops.ts";

const EFFECT_PARADE = "ADBE Effect Parade";

/** The effect a parameter belongs to, and the parameter's position among its children. */
function effectOf(layer: Layer, prop: Property): { effect: PropertyGroup; effectIndex: number } | undefined {
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === EFFECT_PARADE);
  const effects = parade?.children.filter((n): n is PropertyGroup => n.kind === "group") ?? [];
  const effectIndex = effects.findIndex((e) => e.children.includes(prop));
  return effectIndex >= 0 ? { effect: effects[effectIndex], effectIndex } : undefined;
}

/** Stored effect parameters without keyframes, by match name and by kind, rebuilt after each edit. */
const donorIndex = new WeakMap<Project, { revision: number; byName: Map<string, Chunk>; byKind: Map<string, Chunk> }>();
const kindKey = (p: Property) => `${p.controlType}|${p.propertyValueType}`;

function donors(editor: Editor) {
  const cached = donorIndex.get(editor.project);
  if (cached?.revision === editor.revision) return cached;
  const byName = new Map<string, Chunk>();
  const byKind = new Map<string, Chunk>();
  const walk = (nodes: readonly PropertyNode[], inEffect: boolean) => {
    for (const n of nodes) {
      if (n.kind === "group") walk(n.children, inEffect || !!n.isEffect);
      else if (inEffect && n.chunk && !n.synthesized && !findList(n.chunk, "list") && findChild(n.chunk, "tdb4")) {
        if (!byName.has(n.matchName) || n.expression) byName.set(n.matchName, n.chunk);
        if (n.controlType !== undefined && !byKind.has(kindKey(n))) byKind.set(kindKey(n), n.chunk);
      }
    }
  };
  for (const item of editor.project.items.values()) if (item.kind === "comp") for (const layer of item.layers) walk(layer.properties, false);
  const index = { revision: editor.revision, byName, byKind };
  donorIndex.set(editor.project, index);
  return index;
}

function donorFor(editor: Editor, prop: Property): Chunk | undefined {
  const index = donors(editor);
  return index.byName.get(prop.matchName) ?? index.byKind.get(kindKey(prop));
}

/** Whether `prop` can be edited: stored, or left out by After Effects in a way the editor can write back. */
export function canStore(editor: Editor | undefined, layer: Layer, prop: Property): boolean {
  if (!prop.synthesized) return !!prop.chunk;
  if (!editor) return false;
  if (isTransformValue(prop.matchName)) return true;
  return !!effectOf(layer, prop) && !!donorFor(editor, prop);
}

function clone(chunk: Chunk): Chunk {
  return { ...chunk, offset: -1, data: chunk.data.slice(), children: chunk.children?.map(clone) };
}

/** Writes an effect parameter's chunks (copied from `donor`) into its effect, in parameter order. */
function writeEffectParam(tx: Transaction, comp: CompItem, layer: Layer, effect: PropertyGroup, prop: Property, donor: Chunk): void {
  const tdgp = effect.chunk && findList(effect.chunk, "tdgp");
  if (!tdgp?.children) throw new Error(`the effect "${effect.name}" has no parameter list`);
  const tdbs = clone(donor);
  tdbs.children = (tdbs.children ?? []).filter((c) => c.type !== "Utf8" && !(c.type === "LIST" && c.listType === "list"));
  const tdb4 = findChild(tdbs, "tdb4");
  if (tdb4) {
    setExpressionFlags(tdb4.data, false, false);
    stampTimeBase(tdb4.data, layerTimebase(comp, layer), comp.pixelAspect);
  }
  const number = (name: string) => (name.startsWith(`${effect.matchName}-`) ? Number(name.slice(effect.matchName.length + 1)) : Infinity);
  const target = number(prop.matchName);
  const children = tdgp.children;
  let at = children.findIndex((c) => c.type === "tdmn" && number(new TextDecoder().decode(c.data).replace(/\0.*$/s, "")) > target);
  if (at < 0) at = children.length;
  tx.setChildren(tdgp, [...children.slice(0, at), leaf("tdmn", fixedUtf8(prop.matchName, 40)), tdbs, ...children.slice(at)]);
}

/**
 * The layer and property to edit, with the property's chunks written first when After Effects left it out (its
 * value is kept). Run inside `editor.perform`, so the write joins the edit's undo step.
 */
export function storedProperty(editor: Editor, comp: CompItem, layer: Layer, prop: Property): { layer: Layer; prop: Property } {
  if (!prop.synthesized) return { layer, prop };
  if (isTransformValue(prop.matchName)) {
    const found = editable(editor, comp, layer.id, prop.matchName);
    if (!found) throw new Error(`"${prop.name}" cannot be edited`);
    return found;
  }
  const owner = effectOf(layer, prop);
  const donor = donorFor(editor, prop);
  if (!owner || !donor) throw new Error(`"${prop.name}" is not stored in the project and cannot be edited yet`);
  const value: PropertyValue = prop.value;
  editor.perform("", [comp], (tx) => writeEffectParam(tx, comp, layer, owner.effect, prop, donor));
  // The layer's properties were re-derived from the file: find the parameter again by its effect's position.
  const next = comp.layers.find((l) => l.id === layer.id);
  const effect = next && findEffect(next, owner.effectIndex);
  const stored = effect?.children.find((n): n is Property => n.kind === "property" && n.matchName === prop.matchName);
  if (!next || !stored || stored.synthesized) throw new Error(`"${prop.name}" could not be written to the project`);
  // The copied chunks hold the donor's value; the parameter keeps the default it showed.
  if (value !== null) editor.setValue(comp, next, stored, value, 0);
  return { layer: next, prop: stored };
}

function findEffect(layer: Layer, index: number): PropertyGroup | undefined {
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === EFFECT_PARADE);
  return parade?.children.filter((n): n is PropertyGroup => n.kind === "group")[index];
}

/** Sets a value the way the panels do, writing a left-out property first, as one undo step. */
export function setPropertyValue(editor: Editor, comp: CompItem, layer: Layer, prop: Property, value: PropertyValue, time: number, options: CommandOptions = {}): void {
  if (!prop.synthesized) return editor.setValue(comp, layer, prop, value, time, options);
  editor.perform(`Change ${prop.name}`, [comp], () => {
    const stored = storedProperty(editor, comp, layer, prop);
    editor.setValue(comp, stored.layer, stored.prop, value, time);
  }, options);
}

/** The stopwatch on any property, writing a left-out one first. */
export function toggleStopwatch(editor: Editor, comp: CompItem, layer: Layer, prop: Property, time: number): void {
  editor.perform(prop.keyframes.length ? `Remove keyframes from ${prop.name}` : `Add keyframe to ${prop.name}`, [comp], () => {
    const stored = storedProperty(editor, comp, layer, prop);
    editor.toggleStopwatch(comp, stored.layer, stored.prop, time);
  });
}