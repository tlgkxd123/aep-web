// Switching an effect on and off and deleting it, from the Effect Controls panel and the Timeline.
import type { CompItem, Layer, PropertyGroup } from "../aep/model.ts";
import type { MenuEntries } from "./ContextMenu.tsx";
import { attempt, type Editing } from "./editing.tsx";

export function toggleEffect(editing: Editing, comp: CompItem, layer: Layer, effect: PropertyGroup): void {
  const editor = editing.editor;
  if (editor) attempt(editing, () => editor.setEffectEnabled(comp, layer, effect, !effect.enabled));
}

export function deleteEffect(editing: Editing, comp: CompItem, layer: Layer, effect: PropertyGroup): void {
  const editor = editing.editor;
  if (editor) attempt(editing, () => editor.removeEffect(comp, layer, effect));
}

/** Right-click menu of an effect. */
export function effectMenu(editing: Editing, comp: CompItem, layer: Layer, effect: PropertyGroup): MenuEntries {
  const editable = !!editing.editor && !layer.locked;
  return [
    { label: "Effect On", checked: effect.enabled, disabled: !editable, onSelect: () => toggleEffect(editing, comp, layer, effect) },
    "-",
    { label: "Delete Effect", shortcut: "Delete", disabled: !editable, onSelect: () => deleteEffect(editing, comp, layer, effect) },
  ];
}
