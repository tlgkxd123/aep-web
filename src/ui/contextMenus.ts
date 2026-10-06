// The entries of AE's right-click menus (Project panel, Timeline layers,
// Composition viewer). Entries without an action are shown disabled.
import { createContext } from "react";
import type { CompItem, Item, Layer, Project } from "../aep/model.ts";
import type { MenuEntries, MenuEntry } from "./ContextMenu.tsx";
import { blendingModeName } from "./format.ts";

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
}

/** Provided by the app; panels read it to build their context menus. */
export const AppActionsContext = createContext<AppActions | null>(null);

const item = (label: string, onSelect?: () => void, shortcut?: string): MenuEntry => ({ label, onSelect, shortcut });
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

function blendingModes(current: number): MenuEntries {
  const out: MenuEntries = [];
  BLEND_GROUPS.forEach((group, i) => {
    if (i) out.push("-");
    for (const mode of group) out.push({ label: blendingModeName(mode), checked: mode === current });
  });
  return out;
}

const newLayerEntries = (): MenuEntries => [
  item("Text", undefined, "Ctrl+Alt+Shift+T"),
  item("Solid...", undefined, "Ctrl+Y"),
  item("Light...", undefined, "Ctrl+Alt+Shift+L"),
  item("Camera...", undefined, "Ctrl+Alt+Shift+C"),
  item("Null Object", undefined, "Ctrl+Alt+Shift+Y"),
  item("Shape Layer"),
  item("Adjustment Layer", undefined, "Ctrl+Alt+Y"),
];

export function projectItemMenu(target: Item, a: AppActions): MenuEntries {
  if (target.kind === "comp") {
    return [
      item("Open Composition", () => a.openComp(target.id)),
      "-",
      item("Composition Settings...", undefined, "Ctrl+K"),
      item("Rename"),
      "-",
      item("Add To Render Queue", undefined, "Ctrl+M"),
      item("Add To Adobe Media Encoder Queue...", undefined, "Ctrl+Alt+M"),
      "-",
      item("Duplicate", undefined, "Ctrl+D"),
      item("Delete"),
      "-",
      item("New Comp from Selection"),
      sub("Dependencies", [item("Reduce Project"), item("Remove Unused Footage"), item("Consolidate All Footage")]),
    ];
  }
  if (target.kind === "footage") {
    const file = target.mainSource.sourceType === "FileSource";
    return [
      sub("Interpret Footage", [item("Main...", undefined, "Ctrl+Alt+G"), item("Proxy..."), "-", item("Remember Interpretation"), item("Apply Interpretation")]),
      sub("Replace Footage", [item("File...", undefined, "Ctrl+H"), item("With Layered Comp"), item("Placeholder..."), item("Solid...")]),
      item("Reload Footage", file ? a.reloadFootage : undefined, "Ctrl+Alt+L"),
      item("Locate Footage...", file ? a.locateFootage : undefined),
      "-",
      item("Rename"),
      item("New Comp from Selection"),
      "-",
      item("Delete"),
    ];
  }
  return [item("Rename"), item("New Folder", undefined, "Ctrl+Alt+Shift+N"), "-", item("Delete")];
}

export function projectPanelMenu(a: AppActions): MenuEntries {
  return [
    item("New Composition...", undefined, "Ctrl+N"),
    item("New Folder", undefined, "Ctrl+Alt+Shift+N"),
    "-",
    sub("Import", [item("File...", undefined, "Ctrl+I"), item("Multiple Files...", undefined, "Ctrl+Alt+I"), item("Placeholder..."), item("Solid...")]),
    "-",
    item("Locate Footage...", a.locateFootage),
    item("Reload Footage", a.reloadFootage),
  ];
}

export function layerMenu(project: Project, comp: CompItem, layer: Layer, a: AppActions): MenuEntries {
  const source = project.items.get(layer.sourceId);
  return [
    item("Reveal Layer Source in Project", source ? () => a.revealInProject(source.id) : undefined),
    item("Open Layer Source", source?.kind === "comp" ? () => a.openComp(source.id) : source ? () => a.revealInProject(source.id) : undefined),
    item("Effect Controls", a.showEffectControls ? () => a.showEffectControls!(comp.id, layer.id) : undefined, "F3"),
    "-",
    sub("Mask", [item("New Mask"), item("Mask Shape...", undefined, "Ctrl+Shift+M"), item("Mask Feather...", undefined, "Ctrl+Shift+F"), item("Mask Opacity...")]),
    sub("Transform", [
      item("Reset"),
      "-",
      item("Anchor Point..."),
      item("Position...", undefined, "Ctrl+Shift+P"),
      item("Scale..."),
      item("Rotation...", undefined, "Ctrl+Shift+R"),
      item("Opacity...", undefined, "Ctrl+Shift+O"),
      "-",
      item("Flip Horizontal"),
      item("Flip Vertical"),
      item("Center Anchor Point in Layer Content", undefined, "Ctrl+Alt+Home"),
      item("Center In View", undefined, "Ctrl+Home"),
      item("Fit to Comp", undefined, "Ctrl+Alt+F"),
      item("Fit to Comp Width", undefined, "Ctrl+Alt+Shift+H"),
      item("Fit to Comp Height", undefined, "Ctrl+Alt+Shift+G"),
    ]),
    sub("Time", [
      item("Enable Time Remapping", undefined, "Ctrl+Alt+T"),
      item("Time-Reverse Layer", undefined, "Ctrl+Alt+R"),
      item("Time Stretch..."),
      item("Freeze Frame"),
    ]),
    sub("Blending Mode", blendingModes(layer.blendingMode)),
    sub("Layer Styles", [item("Drop Shadow"), item("Inner Shadow"), item("Outer Glow"), item("Inner Glow"), item("Bevel and Emboss"), item("Satin"), item("Color Overlay"), item("Gradient Overlay"), item("Stroke")]),
    sub("Switches", [
      { label: "Hide Other Video" },
      { label: "Show All Video" },
      { label: "Unlock All Layers" },
      "-",
      { label: "Shy", checked: layer.shy },
      { label: "Lock", checked: layer.locked },
      { label: "3D Layer", checked: layer.threeDLayer },
      { label: "Motion Blur", checked: layer.motionBlur },
      { label: "Adjustment Layer", checked: layer.adjustmentLayer },
      { label: "Collapse", checked: layer.collapseTransformation },
    ]),
    "-",
    item("Pre-compose...", undefined, "Ctrl+Shift+C"),
    item("Rename"),
    item("Duplicate", undefined, "Ctrl+D"),
    item("Delete"),
  ];
}

export function viewerMenu(comp: CompItem, a: AppActions): MenuEntries {
  return [
    sub("New", newLayerEntries()),
    "-",
    item("Composition Settings...", undefined, "Ctrl+K"),
    item("Reveal Composition in Project", () => a.revealInProject(comp.id)),
    "-",
    item("Add To Render Queue", undefined, "Ctrl+M"),
  ];
}
