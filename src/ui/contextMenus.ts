// The entries of AE's right-click menus (Project panel, Timeline layers,
// Composition viewer). Entries without an action are shown disabled.
import { createContext } from "react";
import type { CompItem, Item, Layer, Project } from "../aep/model.ts";
import type { LayerSwitch } from "../edit/editor.ts";
import type { MenuEntries, MenuEntry } from "./ContextMenu.tsx";
import { blendingModeName, LABEL_NAMES } from "./format.ts";
import type { LayerCommand } from "./layerCommands.ts";
import type { TransformDialogKind } from "./MenuBar.tsx";

/** What the app can do from a context menu. */
export interface AppActions {
  openComp(id: number): void;
  /** Selects an item in the Project panel (opening its folders) and shows the panel. */
  revealInProject(id: number): void;
  selectLayer(compId: number, layerId: number | undefined): void;
  locateFootage(): void;
  /** Searches this machine's disks again for the project's missing footage. */
  reloadFootage?: () => void;
  /** Present when the Effect Controls panel can show the layer. */
  showEffectControls?: (compId: number, layerId: number) => void;
  /** Editing, when the project is editable. Layer commands act on the selected layer, which a context menu selects first. */
  layerCommand?: (command: LayerCommand) => void;
  canLayerCommand?: (command: LayerCommand, comp: CompItem, layer: Layer | undefined) => boolean;
  setBlendingMode?: (comp: CompItem, layer: Layer, mode: number) => void;
  setLayerSwitch?: (comp: CompItem, layer: Layer, name: LayerSwitch, on: boolean) => void;
  /** Project operations, when the project is editable. They act on the Project panel's selection, which a context menu selects first. */
  projectCommand?: (command: ProjectItemCommand) => void;
  openCompSettings?: (compId: number) => void;
  addToRenderQueue?: (compId: number) => void;
  /** Applies an Effects & Presets effect to layers of a comp (by default the active comp's selected layer). */
  applyEffect?: (matchName: string, target?: { compId: number; layerIds: number[] }) => void;
  /** Opens a Layer > Transform value dialog for the selected layer. */
  transformDialog?: (kind: TransformDialogKind) => void;
  /** Layer > Time > Freeze Frame on the selected layer, at the current time. */
  freezeFrame?: () => void;
  canFreezeFrame?: (comp: CompItem, layer: Layer) => boolean;
  setLayerLabel?: (comp: CompItem, layer: Layer, label: number) => void;
  setLayerQuality?: (comp: CompItem, layer: Layer, quality: number) => void;
  /** Project operations on the Project panel's selection. */
  setItemLabel?: (label: number) => void;
  newCompFromSelection?: () => void;
  reduceProject?: () => void;
  removeUnusedFootage?: () => void;
  /** Saves the project as a .zip with its footage. */
  collectFiles?: () => void;
}

export type ProjectItemCommand = "rename" | "duplicate" | "delete" | "replace-footage" | "new-folder" | "new-comp" | "import";

const projectEntry = (a: AppActions, label: string, cmd: ProjectItemCommand, shortcut?: string): MenuEntry => ({
  label,
  shortcut,
  onSelect: a.projectCommand ? () => a.projectCommand!(cmd) : undefined,
});

/** A layer command entry, enabled when the command applies to `layer` (or to the comp, for new layers). */
function command(a: AppActions, label: string, cmd: LayerCommand, comp: CompItem, layer: Layer | undefined, shortcut?: string): MenuEntry {
  const can = a.layerCommand && a.canLayerCommand?.(cmd, comp, layer);
  return { label, shortcut, onSelect: can ? () => a.layerCommand!(cmd) : undefined };
}

/** Provided by the app; panels read it to build their context menus. */
export const AppActionsContext = createContext<AppActions | null>(null);

const item = (label: string, onSelect?: () => void, shortcut?: string): MenuEntry => ({ label, onSelect, shortcut });
const dialog = (a: AppActions, kind: TransformDialogKind) => (a.transformDialog ? () => a.transformDialog!(kind) : undefined);
const dependencies = (a: AppActions): MenuEntry =>
  sub("Dependencies", [
    item("Collect Files...", a.collectFiles),
    item("Consolidate All Footage"),
    item("Remove Unused Footage", a.removeUnusedFootage),
    item("Reduce Project", a.reduceProject),
  ]);
const sub = (label: string, submenu: MenuEntries): MenuEntry => ({ label, submenu });

/** AE's blending mode menu, in its groups. */
const BLEND_GROUPS = [
  [5212, 5213, 5214],
  [5215, 5216, 5218, 5219, 5217, 5247],
  [5220, 5221, 5222, 5224, 5225, 5223, 5246],
  [5226, 5227, 5228, 5229, 5230, 5231, 5232],
  [5233, 5234, 5235, 5248, 5249],
  [5236, 5237, 5238, 5239],
  [5240, 5241, 5242, 5243],
  [5244, 5245],
];

/** The blending modes in menu order, which Layer > Next / Previous Blending Mode step through. */
export const BLENDING_MODE_ORDER: readonly number[] = BLEND_GROUPS.flat();

/** AE's blending mode list with the current mode checked; `pick` makes the entries live. */
export function blendingModeEntries(current: number, pick?: (mode: number) => void): MenuEntries {
  const out: MenuEntries = [];
  BLEND_GROUPS.forEach((group, i) => {
    if (i) out.push("-");
    for (const mode of group) out.push({ label: blendingModeName(mode), checked: mode === current, onSelect: pick ? () => pick(mode) : undefined });
  });
  return out;
}

/** AE's label colours, with `current` checked; `pick` makes the entries live. */
export function labelEntries(current: number | undefined, pick?: (label: number) => void): MenuEntries {
  return LABEL_NAMES.map((name, label) => ({ label: name, checked: label === current, onSelect: pick ? () => pick(label) : undefined }));
}

export const QUALITY = { WIREFRAME: 4612, DRAFT: 4613, BEST: 4614 } as const;
/** Quality, frame blending and track mattes do not apply to cameras and lights. */
export const isAVLayer = (layer: Layer) => layer.layerType !== "CameraLayer" && layer.layerType !== "LightLayer";

/** Layer > Quality: Best, Draft, Wireframe. */
export function qualityEntries(layer: Layer, pick?: (quality: number) => void): MenuEntries {
  const live = pick && isAVLayer(layer) ? pick : undefined;
  return (
    [
      ["Best", QUALITY.BEST],
      ["Draft", QUALITY.DRAFT],
      ["Wireframe", QUALITY.WIREFRAME],
    ] as const
  ).map(([label, quality]) => ({ label, checked: layer.quality === quality, onSelect: live && (() => live(quality)) }));
}

/** Layer > Frame Blending: Off, Frame Mix, Pixel Motion. */
export function frameBlendingEntries(layer: Layer, pick?: (type: number) => void): MenuEntries {
  const live = pick && isAVLayer(layer) ? pick : undefined;
  return (
    [
      ["Off", 4012],
      ["Frame Mix", 4013],
      ["Pixel Motion", 4014],
    ] as const
  ).map(([label, type]) => ({ label, checked: layer.frameBlendingType === type, onSelect: live && (() => live(type)) }));
}

function blendingModes(comp: CompItem, layer: Layer, a: AppActions): MenuEntries {
  return blendingModeEntries(layer.blendingMode, a.setBlendingMode ? (mode) => a.setBlendingMode!(comp, layer, mode) : undefined);
}

const newLayerEntries = (comp: CompItem, a: AppActions): MenuEntries => [
  item("Text", undefined, "Ctrl+Alt+Shift+T"),
  command(a, "Solid...", "new-solid", comp, undefined, "Ctrl+Y"),
  item("Light...", undefined, "Ctrl+Alt+Shift+L"),
  item("Camera...", undefined, "Ctrl+Alt+Shift+C"),
  command(a, "Null Object", "new-null", comp, undefined, "Ctrl+Alt+Shift+Y"),
  command(a, "Shape Layer", "new-shape", comp, undefined),
  command(a, "Adjustment Layer", "new-adjustment", comp, undefined, "Ctrl+Alt+Y"),
];

/** A layer switch entry: checked when on, toggles it when the project is editable. */
function switchEntry(a: AppActions, label: string, comp: CompItem, layer: Layer, name: LayerSwitch): MenuEntry {
  const on = !!layer[name];
  return { label, checked: on, onSelect: a.setLayerSwitch ? () => a.setLayerSwitch!(comp, layer, name, !on) : undefined };
}

/** Sets a switch on several layers at once (Hide Other Video, Show All Video, Unlock All Layers). */
function switchAll(a: AppActions, label: string, comp: CompItem, layers: Layer[], name: LayerSwitch, on: boolean): MenuEntry {
  const affected = layers.filter((l) => !!l[name] !== on);
  return { label, onSelect: a.setLayerSwitch && affected.length ? () => affected.forEach((l) => a.setLayerSwitch!(comp, l, name, on)) : undefined };
}

/**
 * The folders `items` can move to, as dragging them in the Project panel does: the project root, then every folder by
 * its path. Folders the items already sit in, and the moved folders and their contents, are disabled.
 */
export function moveToEntries(project: Project, items: Item[], move: (folderId: number) => void): MenuEntries {
  const moving = new Set(items.map((i) => i.id));
  const path = (folder: Item): string => {
    const parent = project.items.get(folder.parentFolderId);
    return parent?.kind === "folder" ? `${path(parent)} / ${folder.name}` : folder.name;
  };
  const insideMoved = (folderId: number): boolean => {
    for (let id = folderId; id; id = project.items.get(id)?.parentFolderId ?? 0) if (moving.has(id)) return true;
    return false;
  };
  const entry = (label: string, folderId: number): MenuEntry =>
    item(label, items.every((i) => i.parentFolderId === folderId) || insideMoved(folderId) ? undefined : () => move(folderId));
  const folders = [...project.items.values()]
    .filter((i) => i.kind === "folder")
    .map((f) => ({ id: f.id, label: path(f) }))
    .sort((x, y) => x.label.localeCompare(y.label));
  return [entry("Project Root", 0), ...(folders.length ? ["-" as const] : []), ...folders.map((f) => entry(f.label, f.id))];
}

/** `moveTo` lists the folders the selection can move to, when the project is editable. */
export function projectItemMenu(target: Item, a: AppActions, moveTo?: MenuEntries): MenuEntries {
  const move = moveTo ? [sub("Move To", moveTo)] : [];
  if (target.kind === "comp") {
    return [
      item("Open Composition", () => a.openComp(target.id)),
      "-",
      item("Composition Settings...", a.openCompSettings && (() => a.openCompSettings!(target.id)), "Ctrl+K"),
      projectEntry(a, "Rename", "rename"),
      ...move,
      "-",
      item("Add To Render Queue", a.addToRenderQueue && (() => a.addToRenderQueue!(target.id)), "Ctrl+M"),
      item("Add To Adobe Media Encoder Queue...", undefined, "Ctrl+Alt+M"),
      "-",
      projectEntry(a, "Duplicate", "duplicate", "Ctrl+D"),
      projectEntry(a, "Delete", "delete"),
      "-",
      item("New Comp from Selection", a.newCompFromSelection, "Alt+\\"),
      dependencies(a),
      sub("Label", labelEntries(target.label, a.setItemLabel)),
    ];
  }
  if (target.kind === "footage") {
    const file = target.mainSource.sourceType === "FileSource";
    return [
      sub("Interpret Footage", [item("Main...", undefined, "Ctrl+Alt+G"), item("Proxy..."), "-", item("Remember Interpretation"), item("Apply Interpretation")]),
      sub("Replace Footage", [
        file ? projectEntry(a, "File...", "replace-footage", "Ctrl+H") : item("File...", undefined, "Ctrl+H"),
        item("With Layered Comp"),
        item("Placeholder..."),
        item("Solid..."),
      ]),
      item("Reload Footage", file ? a.reloadFootage : undefined, "Ctrl+Alt+L"),
      item("Locate Footage...", file ? a.locateFootage : undefined),
      "-",
      projectEntry(a, "Rename", "rename"),
      ...move,
      item("New Comp from Selection", a.newCompFromSelection, "Alt+\\"),
      sub("Label", labelEntries(target.label, a.setItemLabel)),
      "-",
      projectEntry(a, "Delete", "delete"),
    ];
  }
  return [
    projectEntry(a, "Rename", "rename"),
    ...move,
    projectEntry(a, "New Folder", "new-folder", "Ctrl+Alt+Shift+N"),
    sub("Label", labelEntries(target.label, a.setItemLabel)),
    "-",
    projectEntry(a, "Delete", "delete"),
  ];
}

export function projectPanelMenu(a: AppActions): MenuEntries {
  return [
    projectEntry(a, "New Composition...", "new-comp", "Ctrl+N"),
    projectEntry(a, "New Folder", "new-folder", "Ctrl+Alt+Shift+N"),
    "-",
    sub("Import", [
      projectEntry(a, "File...", "import", "Ctrl+I"),
      projectEntry(a, "Multiple Files...", "import", "Ctrl+Alt+I"),
      item("Placeholder..."),
      item("Solid..."),
    ]),
    "-",
    item("Locate Footage...", a.locateFootage),
    item("Reload Footage", a.reloadFootage),
    "-",
    dependencies(a),
  ];
}

/** Layer > Switches. */
export function layerSwitchEntries(comp: CompItem, layer: Layer, a: AppActions): MenuEntries {
  return [
    switchAll(a, "Hide Other Video", comp, comp.layers.filter((l) => l.id !== layer.id), "enabled", false),
    switchAll(a, "Show All Video", comp, comp.layers, "enabled", true),
    switchAll(a, "Unlock All Layers", comp, comp.layers, "locked", false),
    "-",
    switchEntry(a, "Shy", comp, layer, "shy"),
    switchEntry(a, "Lock", comp, layer, "locked"),
    switchEntry(a, "Audio", comp, layer, "audioEnabled"),
    switchEntry(a, "Video", comp, layer, "enabled"),
    switchEntry(a, "Solo", comp, layer, "solo"),
    switchEntry(a, "Effect", comp, layer, "effectsActive"),
    switchEntry(a, "3D Layer", comp, layer, "threeDLayer"),
    switchEntry(a, "Motion Blur", comp, layer, "motionBlur"),
    switchEntry(a, "Adjustment Layer", comp, layer, "adjustmentLayer"),
    switchEntry(a, "Collapse", comp, layer, "collapseTransformation"),
  ];
}

/** `rename` makes the layer's name editable where the panel can (the Timeline). */
export function layerMenu(project: Project, comp: CompItem, layer: Layer, a: AppActions, rename?: () => void): MenuEntries {
  const source = project.items.get(layer.sourceId);
  return [
    item("Reveal Layer Source in Project", source ? () => a.revealInProject(source.id) : undefined),
    item("Open Layer Source", source?.kind === "comp" ? () => a.openComp(source.id) : source ? () => a.revealInProject(source.id) : undefined),
    item("Effect Controls", a.showEffectControls ? () => a.showEffectControls!(comp.id, layer.id) : undefined, "F3"),
    "-",
    sub("Mask", [item("New Mask"), item("Mask Shape...", undefined, "Ctrl+Shift+M"), item("Mask Feather...", undefined, "Ctrl+Shift+F"), item("Mask Opacity...")]),
    sub("Transform", [
      command(a, "Reset", "reset-transform", comp, layer),
      "-",
      item("Anchor Point...", dialog(a, "anchor")),
      item("Position...", dialog(a, "position"), "Ctrl+Shift+P"),
      item("Scale...", dialog(a, "scale")),
      item("Rotation...", dialog(a, "rotation"), "Ctrl+Shift+R"),
      item("Opacity...", dialog(a, "opacity"), "Ctrl+Shift+O"),
      "-",
      command(a, "Flip Horizontal", "flip-horizontal", comp, layer),
      command(a, "Flip Vertical", "flip-vertical", comp, layer),
      command(a, "Center Anchor Point in Layer Content", "center-anchor", comp, layer, "Ctrl+Alt+Home"),
      command(a, "Center In View", "center-in-view", comp, layer, "Ctrl+Home"),
      command(a, "Fit to Comp", "fit-to-comp", comp, layer, "Ctrl+Alt+F"),
      command(a, "Fit to Comp Width", "fit-to-comp-width", comp, layer, "Ctrl+Alt+Shift+H"),
      command(a, "Fit to Comp Height", "fit-to-comp-height", comp, layer, "Ctrl+Alt+Shift+G"),
    ]),
    sub("Time", [
      { ...command(a, "Enable Time Remapping", "time-remap", comp, layer, "Ctrl+Alt+T"), checked: layer.timeRemapEnabled },
      item("Time-Reverse Layer", undefined, "Ctrl+Alt+R"),
      item("Time Stretch..."),
      item("Freeze Frame", a.freezeFrame && a.canFreezeFrame?.(comp, layer) ? a.freezeFrame : undefined),
    ]),
    sub("Blending Mode", blendingModes(comp, layer, a)),
    sub("Label", labelEntries(layer.label, a.setLayerLabel && ((label) => a.setLayerLabel!(comp, layer, label)))),
    sub("Layer Styles", [item("Drop Shadow"), item("Inner Shadow"), item("Outer Glow"), item("Inner Glow"), item("Bevel and Emboss"), item("Satin"), item("Color Overlay"), item("Gradient Overlay"), item("Stroke")]),
    sub("Quality", qualityEntries(layer, a.setLayerQuality && ((q) => a.setLayerQuality!(comp, layer, q)))),
    sub("Switches", layerSwitchEntries(comp, layer, a)),
    sub("Arrange", [
      command(a, "Bring Layer to Front", "bring-to-front", comp, layer, "Ctrl+Shift+]"),
      command(a, "Bring Layer Forward", "bring-forward", comp, layer, "Ctrl+]"),
      command(a, "Send Layer Backward", "send-backward", comp, layer, "Ctrl+["),
      command(a, "Send Layer to Back", "send-to-back", comp, layer, "Ctrl+Shift+["),
    ]),
    "-",
    item("Pre-compose...", undefined, "Ctrl+Shift+C"),
    item("Rename", rename, "Enter"),
    command(a, "Duplicate", "duplicate-layer", comp, layer, "Ctrl+D"),
    command(a, "Delete", "delete-layer", comp, layer, "Delete"),
  ];
}

export function viewerMenu(comp: CompItem, a: AppActions): MenuEntries {
  return [
    sub("New", newLayerEntries(comp, a)),
    "-",
    item("Composition Settings...", a.openCompSettings && (() => a.openCompSettings!(comp.id)), "Ctrl+K"),
    item("Reveal Composition in Project", () => a.revealInProject(comp.id)),
    "-",
    item("Add To Render Queue", a.addToRenderQueue && (() => a.addToRenderQueue!(comp.id)), "Ctrl+M"),
  ];
}
