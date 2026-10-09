// Adding, removing and toggling expressions from any panel, the property right-click
// menu, and the request that opens a property's expression field in the Timeline.
import type { CompItem, Layer, Property, PropertyNode } from "../aep/model.ts";
import { canSetExpression, hasNumericValue, isEditableProperty } from "../edit/editor.ts";
import { canStore, storedProperty, toggleStopwatch } from "../edit/stored-property.ts";
import type { MenuEntries } from "./ContextMenu.tsx";
import { attempt, type Editing } from "./editing.tsx";
import { defaultExpression, propertyChain } from "./expressionPath.ts";

/**
 * Where a property sits on its layer: its index path through the property tree. It survives edits, which
 * re-derive the layer's property objects from the file.
 */
export interface PropertyAddress {
  compId: number;
  layerId: number;
  path: number[];
}

export function addressOf(comp: CompItem, layer: Layer, prop: Property): PropertyAddress | undefined {
  const chain = propertyChain(layer, prop);
  if (!chain) return undefined;
  const path: number[] = [];
  let level: readonly PropertyNode[] = layer.properties;
  for (const node of chain) {
    path.push(level.indexOf(node));
    level = node.kind === "group" ? node.children : [];
  }
  return { compId: comp.id, layerId: layer.id, path };
}

export function resolveAddress(layer: Layer, address: PropertyAddress): Property | undefined {
  let level: readonly PropertyNode[] = layer.properties;
  let node: PropertyNode | undefined;
  for (const i of address.path) {
    node = level[i];
    if (!node) return undefined;
    level = node.kind === "group" ? node.children : [];
  }
  return node?.kind === "property" ? node : undefined;
}

let request: PropertyAddress | null = null;
const listeners = new Set<() => void>();

/** The property whose expression field should open for typing (set when an expression is added). */
export const expressionFocus = {
  get: (): PropertyAddress | null => request,
  set(next: PropertyAddress | null): void {
    request = next;
    for (const l of listeners) l();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const sameAddress = (a: PropertyAddress | null, b: PropertyAddress | undefined) =>
  !!a && !!b && a.compId === b.compId && a.layerId === b.layerId && a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i]);

/**
 * Whether the property can take an expression: stored in the file, or left out by After Effects at its default
 * in a way the editor can write first.
 */
export function canHaveExpression(editing: Editing, layer: Layer, prop: Property): boolean {
  return canSetExpression(prop) || (!!prop.synthesized && canStore(editing.editor, layer, prop));
}

/** Adds the default expression and opens it for typing, or removes the expression (Alt+click on a stopwatch). */
export function toggleExpression(editing: Editing, comp: CompItem, layer: Layer, prop: Property): void {
  const editor = editing.editor;
  if (!editor) return;
  if (prop.expression) {
    attempt(editing, () => editor.setExpression(comp, layer, prop, ""));
    return;
  }
  addExpression(editing, comp, layer, prop);
}

export function addExpression(editing: Editing, comp: CompItem, layer: Layer, prop: Property): void {
  const editor = editing.editor;
  if (!editor) return;
  const address = addressOf(comp, layer, prop);
  if (!prop.expression) {
    attempt(editing, () =>
      editor.perform("Add expression", [comp], () => {
        const stored = storedProperty(editor, comp, layer, prop);
        editor.setExpression(comp, stored.layer, stored.prop, defaultExpression(stored.layer, stored.prop));
      }),
    );
  }
  if (address) expressionFocus.set(address);
}

/** Right-click menu of a property: expression commands and keyframing. */
export function propertyMenu(editing: Editing, comp: CompItem, layer: Layer, prop: Property, time: number): MenuEntries {
  const editor = editing.editor;
  if (!editor || !canHaveExpression(editing, layer, prop)) return [{ label: "This property cannot have an expression", disabled: true }];
  const has = !!prop.expression;
  const entries: MenuEntries = [
    { label: has ? "Edit Expression" : "Add Expression", shortcut: "Alt+click stopwatch", onSelect: () => addExpression(editing, comp, layer, prop) },
  ];
  if (has) {
    entries.push(
      {
        label: prop.expressionEnabled ? "Disable Expression" : "Enable Expression",
        onSelect: () => attempt(editing, () => editor.setExpressionEnabled(comp, layer, prop, !prop.expressionEnabled)),
      },
      { label: "Remove Expression", onSelect: () => attempt(editing, () => editor.setExpression(comp, layer, prop, "")) },
    );
  }
  if ((isEditableProperty(prop) || (prop.synthesized && hasNumericValue(prop) && canStore(editor, layer, prop))) && prop.canVaryOverTime) {
    entries.push("-", {
      label: prop.keyframes.length ? "Remove All Keyframes" : "Add Keyframe",
      onSelect: () => attempt(editing, () => toggleStopwatch(editor, comp, layer, prop, time)),
    });
  }
  return entries;
}
