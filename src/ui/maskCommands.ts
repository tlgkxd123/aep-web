// The Timeline's mask and shape commands: a mask's Mode popup, Inverted switch and context menu (mode,
// inversion, lock, feather falloff, colour, rename, duplicate, delete), a shape layer's Contents "Add" menu,
// and the context menu of its groups and items (rename, duplicate, delete).
import type { CompItem, Layer, PropertyGroup } from "../aep/model.ts";
import {
  deleteMasks,
  duplicateMasks,
  layerMasks,
  MaskFeatherFalloff,
  MaskMode,
  newMask,
  renameMask,
  setMaskColor,
  setMaskFeatherFalloff,
  setMaskInverted,
  setMaskLocked,
  setMaskMode,
} from "../edit/masks.ts";
import { addShapes, deleteShapeItems, duplicateShapeItems, renameShapeGroup, type ShapeKind } from "../edit/shapes.ts";
import type { MenuEntries } from "./ContextMenu.tsx";
import { drawOptions } from "./drawTools.ts";
import { attempt, type Editing } from "./editing.tsx";
import { LABEL_COLORS, LABEL_NAMES, maskModeName } from "./format.ts";

const MODES = [MaskMode.NONE, MaskMode.ADD, MaskMode.SUBTRACT, MaskMode.INTERSECT, MaskMode.LIGHTEN, MaskMode.DARKEN, MaskMode.DIFFERENCE];

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** The Mode popup of a mask row. */
export function maskModeEntries(editing: Editing, comp: CompItem, layer: Layer, mask: PropertyGroup): MenuEntries {
  const { editor } = editing;
  const editable = !!editor && !layer.locked;
  return MODES.map((mode) => ({
    label: maskModeName(mode),
    checked: mask.mask?.maskMode === mode,
    onSelect: editable ? () => attempt(editing, () => setMaskMode(editor!, comp, layer, [mask], mode)) : undefined,
  }));
}

export function toggleMaskInverted(editing: Editing, comp: CompItem, layer: Layer, mask: PropertyGroup): void {
  const { editor } = editing;
  if (editor && !layer.locked) attempt(editing, () => setMaskInverted(editor, comp, layer, [mask], !mask.mask?.inverted));
}

/** A mask row's context menu; `onRename` starts renaming it in place. */
export function maskMenu(editing: Editing, comp: CompItem, layer: Layer, mask: PropertyGroup, onRename?: () => void): MenuEntries {
  const { editor } = editing;
  const editable = !!editor && !layer.locked;
  const run = (edit: () => void) => (editable ? () => attempt(editing, edit) : undefined);
  const info = mask.mask;
  return [
    { label: "Mode", submenu: maskModeEntries(editing, comp, layer, mask) },
    { label: "Inverted", checked: !!info?.inverted, onSelect: run(() => setMaskInverted(editor!, comp, layer, [mask], !info?.inverted)) },
    { label: "Locked", checked: !!info?.locked, onSelect: run(() => setMaskLocked(editor!, comp, layer, [mask], !info?.locked)) },
    {
      label: "Feather Falloff",
      submenu: [
        { label: "Smooth", checked: info?.maskFeatherFalloff !== MaskFeatherFalloff.LINEAR, onSelect: run(() => setMaskFeatherFalloff(editor!, comp, layer, [mask], MaskFeatherFalloff.SMOOTH)) },
        { label: "Linear", checked: info?.maskFeatherFalloff === MaskFeatherFalloff.LINEAR, onSelect: run(() => setMaskFeatherFalloff(editor!, comp, layer, [mask], MaskFeatherFalloff.LINEAR)) },
      ],
    },
    {
      label: "Mask Color",
      submenu: LABEL_COLORS.slice(1).map((hex, i) => ({ label: LABEL_NAMES[i + 1], onSelect: run(() => setMaskColor(editor!, comp, layer, [mask], rgb(hex))) })),
    },
    "-",
    { label: "Rename", shortcut: "Enter", onSelect: editable ? onRename : undefined },
    { label: "Duplicate Mask", shortcut: "Ctrl+D", onSelect: run(() => duplicateMasks(editor!, comp, layer, [mask])) },
    { label: "Delete Mask", shortcut: "Delete", onSelect: run(() => deleteMasks(editor!, comp, layer, [mask])) },
  ];
}

/** Layer > Mask, acting on all the masks of the selected layer. */
export function layerMaskEntries(editing: Editing, comp: CompItem, layer: Layer): MenuEntries {
  const { editor } = editing;
  const editable = !!editor && !layer.locked && layer.layerType !== "CameraLayer" && layer.layerType !== "LightLayer";
  const masks = layerMasks(layer);
  const run = (edit: () => void) => (editable && masks.length ? () => attempt(editing, edit) : undefined);
  const inverted = masks.length > 0 && masks.every((m) => m.mask?.inverted);
  const locked = masks.length > 0 && masks.every((m) => m.mask?.locked);
  return [
    { label: "New Mask", shortcut: "Ctrl+Shift+N", onSelect: editable ? () => attempt(editing, () => newMask(editor!, comp, layer)) : undefined },
    "-",
    {
      label: "Mask Mode",
      submenu: MODES.map((mode) => ({
        label: maskModeName(mode),
        checked: masks.length > 0 && masks.every((m) => m.mask?.maskMode === mode),
        onSelect: run(() => setMaskMode(editor!, comp, layer, masks, mode)),
      })),
    },
    { label: "Inverted", shortcut: "Ctrl+Shift+I", checked: inverted, onSelect: run(() => setMaskInverted(editor!, comp, layer, masks, !inverted)) },
    { label: "Locked", checked: locked, onSelect: run(() => setMaskLocked(editor!, comp, layer, masks, !locked)) },
    "-",
    { label: "Remove All Masks", onSelect: run(() => deleteMasks(editor!, comp, layer, masks)) },
  ];
}

export function renameMaskTo(editing: Editing, comp: CompItem, layer: Layer, mask: PropertyGroup, name: string): void {
  if (editing.editor && name.trim() && name !== mask.name) attempt(editing, () => renameMask(editing.editor!, comp, layer, mask, name));
}

const ADDABLE: [ShapeKind, string][] = [
  ["rect", "Rectangle"],
  ["ellipse", "Ellipse"],
  ["star", "Polystar"],
  ["polygon", "Polygon"],
  ["path", "Path"],
];

/** A shape layer's Contents "Add" menu: a new group with the Tools panel's Fill and Stroke. */
export function contentsAddEntries(editing: Editing, comp: CompItem, layer: Layer): MenuEntries {
  const { editor } = editing;
  const editable = !!editor && !layer.locked;
  return ADDABLE.map(([kind, label]) => ({
    label,
    onSelect: editable
      ? () =>
          attempt(editing, () => {
            const paint = drawOptions.get();
            const path = { closed: true, vertices: [[-50, -50], [50, -50], [50, 50], [-50, 50]], inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]] };
            addShapes(editor!, comp, layer.id, [{ kind, center: [0, 0], size: [100, 100], points: 5, outerRadius: 50, innerRadius: 25, path, paint }]);
          })
      : undefined,
  }));
}

/** A shape group's or item's context menu. */
export function shapeItemMenu(editing: Editing, comp: CompItem, layer: Layer, item: PropertyGroup, onRename?: () => void): MenuEntries {
  const { editor } = editing;
  const editable = !!editor && !layer.locked;
  const run = (edit: () => void) => (editable ? () => attempt(editing, edit) : undefined);
  return [
    { label: "Rename", shortcut: "Enter", onSelect: editable ? onRename : undefined },
    { label: "Duplicate", shortcut: "Ctrl+D", onSelect: run(() => duplicateShapeItems(editor!, comp, layer, [item])) },
    { label: "Delete", shortcut: "Delete", onSelect: run(() => deleteShapeItems(editor!, comp, layer, [item])) },
  ];
}

export function renameShapeItemTo(editing: Editing, comp: CompItem, item: PropertyGroup, name: string): void {
  if (editing.editor && name.trim() && name !== item.name) attempt(editing, () => renameShapeGroup(editing.editor!, comp, item, name));
}

/** Whether `group` is a group or item inside a shape layer's contents. */
export const isShapeItem = (group: PropertyGroup) =>
  group.matchName === "ADBE Vector Group" || /^ADBE Vector (Shape - |Graphic - |Filter - )/.test(group.matchName);
