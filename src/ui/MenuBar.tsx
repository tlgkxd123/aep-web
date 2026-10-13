import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CatalogCategory } from "../edit/effectCatalog.ts";
import { QUICK_START_TEMPLATES, type QuickStartId } from "../quickstart/catalog.ts";
import { openMenuSheet, type MenuEntries } from "./ContextMenu.tsx";
import { Icon } from "./icons.tsx";
import type { LayerCommand } from "./layerCommands.ts";

export type MenuCommand =
  | "open"
  | "close"
  | "close-project"
  | "exit"
  | "show-project"
  | "show-effect-controls"
  | "show-render-queue"
  | "add-to-render-queue"
  | "show-chunks"
  | "show-composition"
  | "home"
  | LayerCommand
  | "new-project"
  | "new-folder"
  | "new-comp"
  | "new-comp-from-selection"
  | "comp-settings"
  | "trim-comp"
  | "play-preview"
  | "save"
  | "save-as"
  | "save-copy"
  | "save-zip"
  | "export-viz"
  | "increment-save"
  | "revert"
  | "import"
  | "replace-footage"
  | "reload-footage"
  | "remove-unused-footage"
  | "reduce-project"
  | "find"
  | "cut"
  | "copy"
  | "paste"
  | "duplicate"
  | "clear"
  | "split-layer"
  | "select-all"
  | "deselect-all"
  | "keyboard-shortcuts"
  | "open-layer-source"
  | "reveal-layer-source"
  | "layer-settings"
  | "freeze-frame"
  | "toggle-3d"
  | "toggle-guide"
  | "toggle-environment"
  | "toggle-preserve-transparency"
  | "next-blending-mode"
  | "previous-blending-mode"
  | "browse-presets"
  | "zoom-in"
  | "zoom-out"
  | "toggle-grid"
  | "toggle-layer-controls"
  | "go-to-time"
  | "toggle-sapphire"
  | "particle-match"
  | "add-footage-to-comp"
  | "last-effect"
  | "remove-all-effects"
  | `transform-dialog:${TransformDialogKind}`
  | `panel:${string}`
  | `help:${string}`
  | `apply-effect:${string}`
  | `quick-start:${QuickStartId}`;

/** The Layer > Transform value dialogs. */
export type TransformDialogKind = "anchor" | "position" | "scale" | "rotation" | "opacity";

/** Prefix of the Effect menu commands that apply a library effect, followed by its match name. */
export const APPLY_EFFECT = "apply-effect:";
export const applyEffectCommand = (matchName: string): MenuCommand => `${APPLY_EFFECT}${matchName}`;
/** Prefix of the Window menu commands that open a panel of the right-hand stack, followed by its name. */
export const SHOW_PANEL = "panel:";
/** Prefix of the Help menu commands that open a help page, followed by its address. */
export const OPEN_HELP = "help:";
export const TRANSFORM_DIALOG = "transform-dialog:";
/** Prefix of the File > New > New Project from Template commands, followed by the Quick Start template's id. */
export const QUICK_START = "quick-start:";
export const quickStartCommand = (id: QuickStartId): MenuCommand => `${QUICK_START}${id}`;

/**
 * Submenus whose entries the app builds from the project (blending modes, labels, history...), keyed by these names.
 * Without entries they open empty.
 */
export type DynamicMenu =
  | "recent"
  | "history"
  | "label"
  | "purge"
  | "quality"
  | "switches"
  | "frame-blending"
  | "blending-mode"
  | "track-matte"
  | "resolution"
  | "renderer"
  | "workspace";

interface Item {
  label: string;
  shortcut?: string;
  command?: MenuCommand;
  submenu?: boolean;
  /** The submenu's entries, for submenus this viewer can open. */
  items?: Entry[];
  /** The app provides the submenu's entries. */
  dynamic?: DynamicMenu;
  needsProject?: boolean;
  /** Entries the app built: they carry their own action and state instead of a command. */
  onSelect?: () => void;
  checked?: boolean;
  disabled?: boolean;
}

type Entry = Item | "-";

const sub = (label: string, items: Entry[]): Item => ({ label, submenu: true, items });
const dyn = (label: string, dynamic: DynamicMenu): Item => ({ label, submenu: true, dynamic });
const help = (label: string, url: string, shortcut?: string): Item => ({ label, shortcut, command: `${OPEN_HELP}${url}` });
const panel = (label: string, shortcut?: string): Item => ({ label, shortcut, command: `${SHOW_PANEL}${label}`, needsProject: true });

const TRANSFORM_ITEMS: Entry[] = [
  { label: "Reset", command: "reset-transform" },
  { label: "Anchor Point...", command: "transform-dialog:anchor" },
  { label: "Position...", shortcut: "Ctrl+Shift+P", command: "transform-dialog:position" },
  { label: "Scale...", command: "transform-dialog:scale" },
  { label: "Orientation...", shortcut: "Ctrl+Alt+Shift+R" },
  { label: "Rotation...", shortcut: "Ctrl+Shift+R", command: "transform-dialog:rotation" },
  { label: "Opacity...", shortcut: "Ctrl+Shift+O", command: "transform-dialog:opacity" },
  "-",
  { label: "Flip Horizontal", command: "flip-horizontal" },
  { label: "Flip Vertical", command: "flip-vertical" },
  { label: "Center Anchor Point in Layer Content", shortcut: "Ctrl+Alt+Home", command: "center-anchor" },
  { label: "Center In View", shortcut: "Ctrl+Home", command: "center-in-view" },
  "-",
  { label: "Fit to Comp", shortcut: "Ctrl+Alt+F", command: "fit-to-comp" },
  { label: "Fit to Comp Width", shortcut: "Ctrl+Alt+Shift+H", command: "fit-to-comp-width" },
  { label: "Fit to Comp Height", shortcut: "Ctrl+Alt+Shift+G", command: "fit-to-comp-height" },
  "-",
  { label: "Auto-Orient...", shortcut: "Ctrl+Alt+O" },
];

/** Entries without a command, dynamic submenu or items stay disabled: they need Adobe services, other applications or features this app lacks. */
const MENUS: { name: string; items: Entry[] }[] = [
  {
    name: "File",
    items: [
      sub("New", [
        { label: "New Project", shortcut: "Ctrl+Alt+N", command: "new-project" },
        sub(
          "New Project from Template",
          QUICK_START_TEMPLATES.map((t) => ({ label: `${t.name}...`, command: quickStartCommand(t.id) })),
        ),
        { label: "New Team Project..." },
        { label: "New Folder", shortcut: "Ctrl+Alt+Shift+N", command: "new-folder", needsProject: true },
        { label: "Adobe Photoshop File..." },
        { label: "Maxon Cinema 4D File..." },
      ]),
      { label: "Open Project...", shortcut: "Ctrl+O", command: "open" },
      { label: "Open Team Project..." },
      dyn("Open Recent", "recent"),
      "-",
      { label: "Close", shortcut: "Ctrl+W", command: "close", needsProject: true },
      { label: "Close Project", command: "close-project", needsProject: true },
      { label: "Save", shortcut: "Ctrl+S", command: "save", needsProject: true },
      sub("Save As", [
        { label: "Save As...", shortcut: "Ctrl+Shift+S", command: "save-as", needsProject: true },
        { label: "Save a Copy...", command: "save-copy", needsProject: true },
        { label: "Save As Zip with Footage...", command: "save-zip", needsProject: true },
        { label: "Save a Copy As XML..." },
      ]),
      { label: "Increment and Save", shortcut: "Ctrl+Alt+Shift+S", command: "increment-save", needsProject: true },
      { label: "Revert", command: "revert", needsProject: true },
      "-",
      sub("Import", [
        { label: "File...", shortcut: "Ctrl+I", command: "import", needsProject: true },
        { label: "Multiple Files...", shortcut: "Ctrl+Alt+I", command: "import", needsProject: true },
        { label: "Dependencies", submenu: true },
        { label: "Adobe Premiere Pro Project..." },
        { label: "Placeholder..." },
        { label: "Solid..." },
      ]),
      { label: "Import Recent Footage", submenu: true },
      sub("Export", [
        { label: "Add to Adobe Media Encoder Queue...", shortcut: "Ctrl+Alt+M" },
        { label: "Add to Render Queue", command: "add-to-render-queue", needsProject: true },
        { label: "Avee Player Template (.viz)...", command: "export-viz", needsProject: true },
      ]),
      "-",
      { label: "Find...", shortcut: "Ctrl+F", command: "find", needsProject: true },
      { label: "Add Footage to Comp", shortcut: "Ctrl+/", command: "add-footage-to-comp", needsProject: true },
      { label: "New Comp from Selection", shortcut: "Alt+\\", command: "new-comp-from-selection", needsProject: true },
      "-",
      sub("Dependencies", [
        { label: "Collect Files...", command: "save-zip", needsProject: true },
        { label: "Consolidate All Footage" },
        { label: "Remove Unused Footage", command: "remove-unused-footage", needsProject: true },
        { label: "Reduce Project", command: "reduce-project", needsProject: true },
      ]),
      { label: "Watch Folder..." },
      { label: "Scripts", submenu: true },
      { label: "Create Proxy", submenu: true },
      { label: "Set Proxy", submenu: true },
      { label: "Interpret Footage", submenu: true },
      sub("Replace Footage", [
        { label: "File...", shortcut: "Ctrl+H", command: "replace-footage", needsProject: true },
        { label: "With Layered Comp" },
        { label: "Placeholder..." },
        { label: "Solid..." },
      ]),
      { label: "Reload Footage", shortcut: "Ctrl+Alt+L", command: "reload-footage", needsProject: true },
      "-",
      { label: "Project Settings...", shortcut: "Ctrl+Alt+Shift+K" },
      "-",
      { label: "Exit", shortcut: "Ctrl+Q", command: "exit", needsProject: true },
    ],
  },
  {
    name: "Edit",
    items: [
      { label: "Undo", shortcut: "Ctrl+Z", command: "undo", needsProject: true },
      { label: "Redo", shortcut: "Ctrl+Shift+Z", command: "redo", needsProject: true },
      dyn("History", "history"),
      "-",
      { label: "Cut", shortcut: "Ctrl+X", command: "cut", needsProject: true },
      { label: "Copy", shortcut: "Ctrl+C", command: "copy", needsProject: true },
      { label: "Copy with Property Links", shortcut: "Ctrl+Alt+C" },
      { label: "Copy Expression Only" },
      { label: "Paste", shortcut: "Ctrl+V", command: "paste", needsProject: true },
      { label: "Clear", shortcut: "Delete", command: "clear", needsProject: true },
      "-",
      { label: "Duplicate", shortcut: "Ctrl+D", command: "duplicate", needsProject: true },
      { label: "Split Layer", shortcut: "Ctrl+Shift+D", command: "split-layer", needsProject: true },
      { label: "Lift Work Area" },
      { label: "Extract Work Area" },
      { label: "Select All", shortcut: "Ctrl+A", command: "select-all", needsProject: true },
      { label: "Deselect All", shortcut: "Ctrl+Shift+A", command: "deselect-all", needsProject: true },
      "-",
      dyn("Label", "label"),
      dyn("Purge", "purge"),
      "-",
      { label: "Edit Original...", shortcut: "Ctrl+E" },
      "-",
      { label: "Templates", submenu: true },
      { label: "Preferences", submenu: true },
      { label: "Keyboard Shortcuts", shortcut: "Ctrl+Alt+'", command: "keyboard-shortcuts" },
    ],
  },
  {
    name: "Composition",
    items: [
      { label: "New Composition...", shortcut: "Ctrl+N", command: "new-comp", needsProject: true },
      "-",
      { label: "Composition Settings...", shortcut: "Ctrl+K", command: "comp-settings", needsProject: true },
      { label: "Set Poster Time" },
      { label: "Trim Comp to Work Area", shortcut: "Ctrl+Shift+X", command: "trim-comp", needsProject: true },
      { label: "Crop Comp to Region of Interest" },
      "-",
      { label: "Add to Render Queue", shortcut: "Ctrl+M", command: "add-to-render-queue", needsProject: true },
      { label: "Add Output Module" },
      "-",
      sub("Preview", [{ label: "Play Current Preview", shortcut: "Space", command: "play-preview", needsProject: true }]),
      dyn("Preview Renderer", "renderer"),
      { label: "Save Frame As", submenu: true },
      { label: "Pre-render...", command: "add-to-render-queue", needsProject: true },
      { label: "Save Current Preview...", shortcut: "Ctrl+Num 0" },
      "-",
      { label: "Composition Flowchart", shortcut: "Ctrl+Shift+F11" },
      { label: "Composition Mini-Flowchart", shortcut: "Tab" },
    ],
  },
  {
    name: "Layer",
    items: [
      sub("New", [
        { label: "Text", shortcut: "Ctrl+Alt+Shift+T" },
        { label: "Solid...", shortcut: "Ctrl+Y", command: "new-solid" },
        { label: "Light...", shortcut: "Ctrl+Alt+Shift+L" },
        { label: "Camera...", shortcut: "Ctrl+Alt+Shift+C" },
        { label: "Null Object", shortcut: "Ctrl+Alt+Shift+Y", command: "new-null" },
        { label: "Shape Layer", command: "new-shape" },
        { label: "Adjustment Layer", shortcut: "Ctrl+Alt+Y", command: "new-adjustment" },
        { label: "Content-Aware Fill Layer..." },
        { label: "Adobe Photoshop File..." },
        { label: "Maxon Cinema 4D File..." },
      ]),
      { label: "Layer Settings...", shortcut: "Ctrl+Shift+Y", command: "layer-settings", needsProject: true },
      "-",
      { label: "Open Layer" },
      { label: "Open Layer Source", shortcut: "Alt+Num Enter", command: "open-layer-source", needsProject: true },
      { label: "Reveal in Explorer" },
      "-",
      { label: "Mask", submenu: true },
      { label: "Mask and Shape Path", submenu: true },
      dyn("Quality", "quality"),
      dyn("Switches", "switches"),
      sub("Transform", TRANSFORM_ITEMS),
      sub("Time", [
        { label: "Enable Time Remapping", shortcut: "Ctrl+Alt+T", command: "time-remap" },
        { label: "Time-Reverse Layer", shortcut: "Ctrl+Alt+R" },
        { label: "Time Stretch..." },
        { label: "Freeze Frame", command: "freeze-frame", needsProject: true },
      ]),
      dyn("Frame Blending", "frame-blending"),
      { label: "3D Layer", command: "toggle-3d", needsProject: true },
      { label: "Guide Layer", command: "toggle-guide", needsProject: true },
      { label: "Environment Layer", command: "toggle-environment", needsProject: true },
      { label: "Markers", submenu: true },
      "-",
      { label: "Preserve Transparency", command: "toggle-preserve-transparency", needsProject: true },
      dyn("Blending Mode", "blending-mode"),
      { label: "Next Blending Mode", shortcut: "Shift+=", command: "next-blending-mode", needsProject: true },
      { label: "Previous Blending Mode", shortcut: "Shift+-", command: "previous-blending-mode", needsProject: true },
      dyn("Track Matte", "track-matte"),
      { label: "Layer Styles", submenu: true },
      "-",
      sub("Arrange", [
        { label: "Bring Layer to Front", shortcut: "Ctrl+Shift+]", command: "bring-to-front" },
        { label: "Bring Layer Forward", shortcut: "Ctrl+]", command: "bring-forward" },
        { label: "Send Layer Backward", shortcut: "Ctrl+[", command: "send-backward" },
        { label: "Send Layer to Back", shortcut: "Ctrl+Shift+[", command: "send-to-back" },
      ]),
      "-",
      sub("Reveal", [
        { label: "Reveal Layer Source in Project", command: "reveal-layer-source", needsProject: true },
        { label: "Reveal Layer in Project Flowchart" },
        { label: "Reveal Expression Errors" },
      ]),
      { label: "Create", submenu: true },
      { label: "Camera", submenu: true },
      { label: "Auto-trace..." },
      { label: "Pre-compose...", shortcut: "Ctrl+Shift+C" },
    ],
  },
  {
    name: "Effect",
    items: [
      { label: "Effect Controls", shortcut: "F3", command: "show-effect-controls", needsProject: true },
      { label: "Last Effect", shortcut: "Ctrl+Alt+Shift+E", command: "last-effect", needsProject: true },
      { label: "Remove All", shortcut: "Ctrl+Shift+E", command: "remove-all-effects", needsProject: true },
      "-",
    ],
  },
  {
    name: "Animation",
    items: [
      { label: "Save Animation Preset..." },
      { label: "Apply Animation Preset..." },
      { label: "Recent Animation Presets", submenu: true },
      { label: "Browse Presets...", command: "browse-presets", needsProject: true },
      "-",
      { label: "Add Keyframe" },
      { label: "Toggle Hold Keyframe", shortcut: "Ctrl+Alt+H" },
      { label: "Keyframe Interpolation...", shortcut: "Ctrl+Alt+K" },
      { label: "Keyframe Velocity...", shortcut: "Ctrl+Shift+K" },
      { label: "Keyframe Assistant", submenu: true },
      "-",
      { label: "Animate Text", submenu: true },
      { label: "Add Text Selector", submenu: true },
      { label: "Remove All Text Animators" },
      "-",
      { label: "Add Expression", shortcut: "Alt+Shift+=" },
      { label: "Separate Dimensions" },
      { label: "Track Camera" },
      { label: "Warp Stabilizer VFX" },
      { label: "Track Motion" },
      { label: "Track Mask" },
      "-",
      { label: "Reveal Properties with Keyframes", shortcut: "U" },
      { label: "Reveal Properties with Animation" },
      { label: "Reveal All Modified Properties" },
    ],
  },
  {
    name: "View",
    items: [
      { label: "New Viewer", shortcut: "Ctrl+Alt+Shift+N" },
      "-",
      { label: "Zoom In", shortcut: ".", command: "zoom-in", needsProject: true },
      { label: "Zoom Out", shortcut: ",", command: "zoom-out", needsProject: true },
      "-",
      dyn("Resolution", "resolution"),
      "-",
      { label: "Use Display Color Management", shortcut: "Shift+Num /" },
      { label: "Simulate Output", submenu: true },
      "-",
      { label: "Show Rulers", shortcut: "Ctrl+R" },
      { label: "Show Guides", shortcut: "Ctrl+;" },
      { label: "Snap to Guides", shortcut: "Ctrl+Shift+;" },
      { label: "Lock Guides", shortcut: "Ctrl+Alt+Shift+;" },
      { label: "Clear Guides" },
      { label: "Show Grid", shortcut: "Ctrl+'", command: "toggle-grid", needsProject: true },
      { label: "Snap to Grid", shortcut: "Ctrl+Shift+'" },
      "-",
      { label: "View Options...", shortcut: "Ctrl+Alt+U" },
      { label: "Show Layer Controls", shortcut: "Ctrl+Shift+H", command: "toggle-layer-controls", needsProject: true },
      { label: "Reset 3D View" },
      "-",
      { label: "Render Sapphire effects", command: "toggle-sapphire" },
      "-",
      { label: "Go To Time...", shortcut: "Alt+Shift+J", command: "go-to-time", needsProject: true },
    ],
  },
  {
    name: "Window",
    items: [
      dyn("Workspace", "workspace"),
      { label: "Find Extensions on Exchange..." },
      { label: "Extensions", submenu: true },
      "-",
      panel("Align"),
      panel("Audio"),
      { label: "Brushes" },
      { label: "Character", shortcut: "Ctrl+6" },
      { label: "Composition", command: "show-composition", needsProject: true },
      { label: "Content-Aware Fill" },
      { label: "Effect Controls", shortcut: "F3", command: "show-effect-controls", needsProject: true },
      panel("Effects & Presets", "Ctrl+5"),
      { label: "Essential Graphics" },
      panel("Info", "Ctrl+2"),
      panel("Libraries"),
      { label: "Lumetri Scopes" },
      { label: "Paragraph", shortcut: "Ctrl+7" },
      panel("Preview", "Ctrl+3"),
      { label: "Project", shortcut: "Ctrl+0", command: "show-project", needsProject: true },
      { label: "Properties" },
      { label: "Render Queue", shortcut: "Ctrl+Alt+0", command: "show-render-queue", needsProject: true },
      { label: "RIFX Chunks (developer)", command: "show-chunks", needsProject: true },
      { label: "Tools", shortcut: "Ctrl+1" },
      { label: "Tracker" },
      { label: "Wiggler" },
    ],
  },
  {
    name: "Extra",
    items: [{ label: "Particle Match...", command: "particle-match" }],
  },
  {
    name: "Help",
    items: [
      { label: "Home", command: "home" },
      "-",
      help("After Effects Help", "https://helpx.adobe.com/after-effects/user-guide.html", "F1"),
      help("Scripting Help", "https://ae-scripting.docsforadobe.dev/"),
      help("Expression Reference", "https://helpx.adobe.com/after-effects/using/expression-language-reference.html"),
      help("Effect Reference", "https://helpx.adobe.com/after-effects/using/effects-animation-presets-overview.html"),
      { label: "Keyboard Shortcuts", command: "keyboard-shortcuts" },
      "-",
      { label: "Enable Logging" },
      { label: "Show Log Files" },
    ],
  },
];

/** Every menu command with its shortcut, menu by menu, for the Keyboard Shortcuts list. */
export function menuShortcuts(): { menu: string; label: string; shortcut: string }[] {
  const out: { menu: string; label: string; shortcut: string }[] = [];
  const visit = (menu: string, entries: Entry[]) => {
    for (const e of entries) {
      if (e === "-") continue;
      if (e.shortcut && e.command && !out.some((o) => o.shortcut === e.shortcut && o.label === e.label)) out.push({ menu, label: e.label, shortcut: e.shortcut });
      if (e.items) visit(menu, e.items);
    }
  };
  for (const m of MENUS) visit(m.name, m.items);
  return out;
}

/** App-built entries as menu bar entries. */
function fromEntries(entries: MenuEntries): Entry[] {
  return entries.map((e): Entry =>
    e === "-"
      ? "-"
      : {
          label: e.label,
          shortcut: e.shortcut,
          onSelect: e.onSelect,
          checked: e.checked,
          disabled: e.disabled || (!e.onSelect && !e.submenu),
          ...(e.submenu && { submenu: true, items: fromEntries(e.submenu) }),
        },
  );
}

interface MenuState {
  hasProject: boolean;
  enabled?: (command: MenuCommand) => boolean;
  /** A label that depends on the project, such as "Undo Move". */
  label?: (command: MenuCommand) => string | undefined;
  /** Whether a command that toggles a setting has it on; undefined for other commands. */
  checked?: (command: MenuCommand) => boolean | undefined;
  /** The entries of the dynamic submenus. */
  dynamic?: (menu: DynamicMenu) => MenuEntries | undefined;
  run: (command: MenuCommand) => void;
  /** Closes the menu before an app-built entry runs. */
  close: () => void;
}

/** The submenu entries of `entry`, built by the app for dynamic submenus. */
const subEntries = (entry: Item, state: MenuState): Entry[] | undefined =>
  entry.dynamic ? fromEntries(state.dynamic?.(entry.dynamic) ?? []) : entry.items;

const runnable = (entry: Item, state: MenuState): boolean => {
  if (entry.disabled) return false;
  const items = subEntries(entry, state);
  if (items) return items.some((e) => e !== "-" && runnable(e, state));
  if (entry.onSelect) return true;
  return !!entry.command && !(entry.needsProject && !state.hasProject) && (state.enabled?.(entry.command) ?? true);
};

const isChecked = (entry: Item, state: MenuState): boolean | undefined =>
  entry.checked ?? (entry.command ? state.checked?.(entry.command) : undefined);

function choose(entry: Item, state: MenuState): void {
  if (entry.onSelect) {
    state.close();
    entry.onSelect();
  } else if (entry.command) state.run(entry.command);
}

function MenuList({ name, entries, state, className }: { name: string; entries: Entry[]; state: MenuState; className?: string }) {
  const [sub, setSub] = useState<number>();
  const pop = useRef<HTMLDivElement>(null);
  // A submenu taller than the room below its item (an Effect menu category) moves up to stay in the window.
  useLayoutEffect(() => {
    const el = pop.current;
    if (!el || !className) return;
    const over = el.getBoundingClientRect().bottom - (window.innerHeight - 4);
    if (over > 0) el.style.transform = `translateY(${-over}px)`;
  }, [className]);
  return (
    <div className={`menu-pop ${className ?? ""}`} role="menu" aria-label={name} ref={pop}>
      {entries.map((entry, j) => {
        if (entry === "-") return <div key={j} className="menu-sep" role="separator" />;
        const label = (entry.command && state.label?.(entry.command)) || entry.label;
        const checked = isChecked(entry, state);
        const items = sub === j ? subEntries(entry, state) : entry.dynamic ? [] : entry.items;
        const button = (
          <button
            key={j}
            type="button"
            role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
            className={`menu-item ${items && sub === j ? "open" : ""}`}
            aria-haspopup={items ? "menu" : undefined}
            aria-expanded={items ? sub === j : undefined}
            aria-checked={checked}
            disabled={!runnable(entry, state)}
            onPointerEnter={() => setSub(items ? j : undefined)}
            onClick={() => {
              if (items) setSub(sub === j ? undefined : j);
              else choose(entry, state);
            }}
          >
            {checked && (
              <span className="menu-check">
                <Icon name="check" size={10} />
              </span>
            )}
            <span className="menu-label">{label}</span>
            <span className="menu-shortcut">{entry.shortcut}</span>
            <span className="menu-sub">{entry.submenu && <Icon name="chevronRight" size={10} />}</span>
          </button>
        );
        if (!items) return button;
        return (
          <div key={j} className="menu-item-wrap">
            {button}
            {sub === j && <MenuList name={entry.label} entries={items} state={state} className="menu-sub-pop" />}
          </div>
        );
      })}
    </div>
  );
}

/** The Effect menu's categories, each listing its effects. */
function effectMenuItems(categories: readonly CatalogCategory[] | undefined): Entry[] {
  return (categories ?? []).map(({ name, effects }): Item => {
    const items = effects.map((e): Item => ({ label: e.name, command: applyEffectCommand(e.matchName), needsProject: true }));
    return items.length ? { label: name, submenu: true, items } : { label: name, submenu: true };
  });
}

/** Menu entries as the sheet of compact screens lists them. */
function sheetEntries(entries: Entry[], state: MenuState): MenuEntries {
  return entries.map((entry): MenuEntries[number] => {
    if (entry === "-") return "-";
    const text = (entry.command && state.label?.(entry.command)) || entry.label;
    const items = subEntries(entry, state);
    if (entry.submenu) return items ? { label: text, submenu: sheetEntries(items, state) } : { label: text, disabled: true };
    return {
      label: text,
      shortcut: entry.shortcut,
      checked: isChecked(entry, state),
      onSelect: runnable(entry, state) ? () => choose(entry, state) : undefined,
    };
  });
}

/**
 * The application menu bar. Only commands this viewer can carry out are enabled. On compact screens it is one Menu
 * button whose sheet lists the menus, headed `title`.
 */
export const MenuBar = memo(function MenuBar({
  hasProject,
  onCommand,
  enabled,
  label,
  checked,
  dynamic,
  effects,
  compact = false,
  title = "Menu",
}: {
  hasProject: boolean;
  onCommand: (command: MenuCommand) => void;
  enabled?: (command: MenuCommand) => boolean;
  label?: (command: MenuCommand) => string | undefined;
  checked?: (command: MenuCommand) => boolean | undefined;
  dynamic?: (menu: DynamicMenu) => MenuEntries | undefined;
  /** The Effects & Presets categories, listed in the Effect menu. */
  effects?: readonly CatalogCategory[];
  compact?: boolean;
  title?: string;
}) {
  const menus = useMemo(
    () => MENUS.map((menu) => (menu.name === "Effect" ? { ...menu, items: [...menu.items, ...effectMenuItems(effects)] } : menu)),
    [effects],
  );
  const [open, setOpen] = useState<number>();
  const bar = useRef<HTMLDivElement>(null);
  const state: MenuState = {
    hasProject,
    enabled,
    label,
    checked,
    dynamic,
    run: (command) => {
      setOpen(undefined);
      onCommand(command);
    },
    close: () => setOpen(undefined),
  };

  useEffect(() => {
    if (open === undefined) return;
    const close = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) setOpen(undefined);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(undefined);
      if (e.key === "ArrowRight") setOpen((i) => ((i ?? 0) + 1) % MENUS.length);
      if (e.key === "ArrowLeft") setOpen((i) => ((i ?? 0) + MENUS.length - 1) % MENUS.length);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  if (compact) {
    return (
      <button
        type="button"
        className="mtop-btn"
        aria-label="Menu"
        aria-haspopup="menu"
        onClick={() => openMenuSheet(title, menus.map((menu) => ({ label: menu.name, submenu: sheetEntries(menu.items, state) })))}
      >
        <Icon name="menu" size={18} />
      </button>
    );
  }
  return (
    <div className="menubar" role="menubar" aria-label="Application menu" ref={bar}>
      {menus.map((menu, i) => (
        <div key={menu.name} className="menu-root">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            className={`menu-title ${open === i ? "open" : ""}`}
            onClick={() => setOpen(open === i ? undefined : i)}
            onPointerEnter={() => open !== undefined && setOpen(i)}
          >
            {menu.name}
          </button>
          {open === i && <MenuList name={menu.name} entries={menu.items} state={state} />}
        </div>
      ))}
    </div>
  );
});
