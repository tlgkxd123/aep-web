// Popup entries for the Timeline's per-layer columns (Mode, TrkMat, Parent & Link).
import type { CompItem, Layer } from "../aep/model.ts";
import type { Editor } from "../edit/editor.ts";
import type { MenuEntries } from "./ContextMenu.tsx";
import { blendingModeEntries } from "./contextMenus.ts";
import { attempt, type Editing } from "./editing.tsx";

const NO_MATTE = 5012;
const MATTES: [number, string][] = [
  [5013, "Alpha Matte"],
  [5014, "Alpha Inverted Matte"],
  [5015, "Luma Matte"],
  [5016, "Luma Inverted Matte"],
];

export { QUALITY } from "./contextMenus.ts";

export function modeEntries(editing: Editing, editor: Editor | undefined, comp: CompItem, layer: Layer): MenuEntries {
  return blendingModeEntries(layer.blendingMode, editor ? (mode) => attempt(editing, () => editor.setBlendingMode(comp, layer, mode)) : undefined);
}

/** No Track Matte, or a matte mode using the current matte layer (the layer above by default, as in AE). */
export function trackMatteEntries(editing: Editing, editor: Editor | undefined, comp: CompItem, layer: Layer): MenuEntries {
  const matteId = layer.trackMatteLayerId || comp.layers[layer.index - 2]?.id;
  const matte = comp.layers.find((l) => l.id === matteId);
  const set = (type: number) => (editor ? () => attempt(editing, () => editor.setTrackMatte(comp, layer, type, type === NO_MATTE ? undefined : matteId)) : undefined);
  return [
    { label: "No Track Matte", checked: layer.trackMatteType === NO_MATTE, onSelect: set(NO_MATTE) },
    "-",
    ...MATTES.map(([type, label]) => ({
      label: matte ? `${label} "${matte.name}"` : label,
      checked: layer.trackMatteType === type,
      onSelect: matte ? set(type) : undefined,
    })),
  ];
}

/** None, or any layer of the comp that is not the layer itself or one of its children. */
export function parentEntries(editing: Editing, editor: Editor | undefined, comp: CompItem, layer: Layer): MenuEntries {
  const descends = (candidate: Layer): boolean => {
    for (let l: Layer | undefined = candidate; l; l = comp.layers.find((p) => p.id === l!.parentId)) if (l.id === layer.id) return true;
    return false;
  };
  const set = (id: number) => (editor ? () => attempt(editing, () => editor.setParent(comp, layer, id)) : undefined);
  return [
    { label: "None", checked: !layer.parentId, onSelect: set(0) },
    "-",
    ...comp.layers
      .filter((l) => !descends(l))
      .map((l) => ({ label: `${l.index}. ${l.name}`, checked: layer.parentId === l.id, onSelect: set(l.id) })),
  ];
}
