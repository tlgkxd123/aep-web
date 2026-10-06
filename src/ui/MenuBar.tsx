import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import type { LayerCommand } from "./layerCommands.ts";

export type MenuCommand =
  | "open"
  | "close-project"
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
  | "comp-settings"
  | "save"
  | "save-as"
  | "import"
  | "replace-footage"
  | "duplicate"
  | "clear";

interface Item {
  label: string;
  shortcut?: string;
  command?: MenuCommand;
  submenu?: boolean;
  /** The submenu's entries, for submenus this viewer can open. */
  items?: Entry[];
  needsProject?: boolean;
}

type Entry = Item | "-";

const MENUS: { name: string; items: Entry[] }[] = [
  {
    name: "File",
    items: [
      {
        label: "New",
        submenu: true,
        items: [
          { label: "New Project", shortcut: "Ctrl+Alt+N", command: "new-project" },
          { label: "New Team Project..." },
          { label: "New Folder", shortcut: "Ctrl+Alt+Shift+N", command: "new-folder", needsProject: true },
          { label: "Adobe Photoshop File..." },
          { label: "Maxon Cinema 4D File..." },
        ],
      },
      { label: "Open Project...", shortcut: "Ctrl+O", command: "open" },
      { label: "Open Team Project..." },
      { label: "Open Recent", submenu: true },
      "-",
      { label: "Close", shortcut: "Ctrl+W" },
      { label: "Close Project", command: "close-project", needsProject: true },
      { label: "Save", shortcut: "Ctrl+S", command: "save", needsProject: true },
      {
        label: "Save As",
        submenu: true,
        items: [
          { label: "Save As...", shortcut: "Ctrl+Shift+S", command: "save-as", needsProject: true },
          { label: "Save a Copy..." },
          { label: "Save a Copy As XML..." },
        ],
      },
      { label: "Increment and Save", shortcut: "Ctrl+Alt+Shift+S" },
      { label: "Revert" },
      "-",
      {
        label: "Import",
        submenu: true,
        items: [
          { label: "File...", shortcut: "Ctrl+I", command: "import", needsProject: true },
          { label: "Multiple Files...", shortcut: "Ctrl+Alt+I", command: "import", needsProject: true },
          { label: "Dependencies", submenu: true },
          { label: "Adobe Premiere Pro Project..." },
          { label: "Placeholder..." },
          { label: "Solid..." },
        ],
      },
      { label: "Import Recent Footage", submenu: true },
      { label: "Export", submenu: true },
      "-",
      { label: "Find...", shortcut: "Ctrl+F" },
      { label: "Add Footage to Comp", shortcut: "Ctrl+/" },
      { label: "New Comp from Selection", shortcut: "Alt+\\" },
      "-",
      { label: "Dependencies", submenu: true },
      { label: "Watch Folder..." },
      { label: "Scripts", submenu: true },
      { label: "Create Proxy", submenu: true },
      { label: "Set Proxy", submenu: true },
      { label: "Interpret Footage", submenu: true },
      {
        label: "Replace Footage",
        submenu: true,
        items: [
          { label: "File...", shortcut: "Ctrl+H", command: "replace-footage", needsProject: true },
          { label: "With Layered Comp" },
          { label: "Placeholder..." },
          { label: "Solid..." },
        ],
      },
      { label: "Reload Footage", shortcut: "Ctrl+Alt+L" },
      "-",
      { label: "Project Settings...", shortcut: "Ctrl+Alt+Shift+K" },
      "-",
      { label: "Exit", shortcut: "Ctrl+Q" },
    ],
  },
  {
    name: "Edit",
    items: [
      { label: "Undo", shortcut: "Ctrl+Z", command: "undo", needsProject: true },
      { label: "Redo", shortcut: "Ctrl+Shift+Z", command: "redo", needsProject: true },
      { label: "History", submenu: true },
      "-",
      { label: "Cut", shortcut: "Ctrl+X" },
      { label: "Copy", shortcut: "Ctrl+C" },
      { label: "Copy with Property Links", shortcut: "Ctrl+Alt+C" },
      { label: "Copy Expression Only" },
      { label: "Paste", shortcut: "Ctrl+V" },
      { label: "Clear", shortcut: "Delete", command: "clear", needsProject: true },
      "-",
      { label: "Duplicate", shortcut: "Ctrl+D", command: "duplicate", needsProject: true },
      { label: "Split Layer", shortcut: "Ctrl+Shift+D" },
      { label: "Lift Work Area" },
      { label: "Extract Work Area" },
      { label: "Select All", shortcut: "Ctrl+A" },
      { label: "Deselect All", shortcut: "Ctrl+Shift+A" },
      "-",
      { label: "Label", submenu: true },
      { label: "Purge", submenu: true },
      "-",
      { label: "Edit Original...", shortcut: "Ctrl+E" },
      "-",
      { label: "Templates", submenu: true },
      { label: "Preferences", submenu: true },
      { label: "Keyboard Shortcuts", shortcut: "Ctrl+Alt+'" },
    ],
  },
  {
    name: "Composition",
    items: [
      { label: "New Composition...", shortcut: "Ctrl+N", command: "new-comp", needsProject: true },
      "-",
      { label: "Composition Settings...", shortcut: "Ctrl+K", command: "comp-settings", needsProject: true },
      { label: "Set Poster Time" },
      { label: "Trim Comp to Work Area", shortcut: "Ctrl+Shift+X" },
      { label: "Crop Comp to Region of Interest" },
      "-",
      { label: "Add to Render Queue", shortcut: "Ctrl+M", command: "add-to-render-queue", needsProject: true },
      { label: "Add Output Module" },
      "-",
      { label: "Preview", submenu: true },
      { label: "Save Frame As", submenu: true },
      { label: "Pre-render..." },
      { label: "Save Current Preview...", shortcut: "Ctrl+Num 0" },
      "-",
      { label: "Composition Flowchart", shortcut: "Ctrl+Shift+F11" },
      { label: "Composition Mini-Flowchart", shortcut: "Tab" },
    ],
  },
  {
    name: "Layer",
    items: [
      {
        label: "New",
        submenu: true,
        items: [
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
        ],
      },
      { label: "Layer Settings...", shortcut: "Ctrl+Shift+Y" },
      "-",
      { label: "Open Layer" },
      { label: "Open Layer Source", shortcut: "Alt+Num Enter" },
      { label: "Reveal in Explorer" },
      "-",
      { label: "Mask", submenu: true },
      { label: "Mask and Shape Path", submenu: true },
      { label: "Quality", submenu: true },
      { label: "Switches", submenu: true },
      {
        label: "Transform",
        submenu: true,
        items: [
          { label: "Reset", command: "reset-transform" },
          { label: "Anchor Point..." },
          { label: "Position...", shortcut: "Ctrl+Shift+P" },
          { label: "Scale..." },
          { label: "Orientation...", shortcut: "Ctrl+Alt+Shift+R" },
          { label: "Rotation...", shortcut: "Ctrl+Shift+R" },
          { label: "Opacity...", shortcut: "Ctrl+Shift+O" },
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
        ],
      },
      { label: "Time", submenu: true },
      { label: "Frame Blending", submenu: true },
      { label: "3D Layer" },
      { label: "Guide Layer" },
      { label: "Environment Layer" },
      { label: "Markers", submenu: true },
      "-",
      { label: "Preserve Transparency" },
      { label: "Blending Mode", submenu: true },
      { label: "Next Blending Mode", shortcut: "Shift+=" },
      { label: "Previous Blending Mode", shortcut: "Shift+-" },
      { label: "Track Matte", submenu: true },
      { label: "Layer Styles", submenu: true },
      "-",
      {
        label: "Arrange",
        submenu: true,
        items: [
          { label: "Bring Layer to Front", shortcut: "Ctrl+Shift+]", command: "bring-to-front" },
          { label: "Bring Layer Forward", shortcut: "Ctrl+]", command: "bring-forward" },
          { label: "Send Layer Backward", shortcut: "Ctrl+[", command: "send-backward" },
          { label: "Send Layer to Back", shortcut: "Ctrl+Shift+[", command: "send-to-back" },
        ],
      },
      "-",
      { label: "Reveal", submenu: true },
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
      { label: "Last Effect", shortcut: "Ctrl+Alt+Shift+E" },
      { label: "Remove All", shortcut: "Ctrl+Shift+E" },
      "-",
      ...[
        "3D Channel", "Audio", "Blur & Sharpen", "Channel", "Color Correction", "Distort", "Expression Controls",
        "Generate", "Immersive Video", "Keying", "Matte", "Noise & Grain", "Obsolete", "Perspective", "Simulation",
        "Stylize", "Text", "Time", "Transition", "Utility",
      ].map((label): Item => ({ label, submenu: true })),
    ],
  },
  {
    name: "Animation",
    items: [
      { label: "Save Animation Preset..." },
      { label: "Apply Animation Preset..." },
      { label: "Recent Animation Presets", submenu: true },
      { label: "Browse Presets..." },
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
      { label: "Zoom In", shortcut: "." },
      { label: "Zoom Out", shortcut: "," },
      "-",
      { label: "Resolution", submenu: true },
      "-",
      { label: "Use Display Color Management", shortcut: "Shift+Num /" },
      { label: "Simulate Output", submenu: true },
      "-",
      { label: "Show Rulers", shortcut: "Ctrl+R" },
      { label: "Show Guides", shortcut: "Ctrl+;" },
      { label: "Snap to Guides", shortcut: "Ctrl+Shift+;" },
      { label: "Lock Guides", shortcut: "Ctrl+Alt+Shift+;" },
      { label: "Clear Guides" },
      { label: "Show Grid", shortcut: "Ctrl+'" },
      { label: "Snap to Grid", shortcut: "Ctrl+Shift+'" },
      "-",
      { label: "View Options...", shortcut: "Ctrl+Alt+U" },
      { label: "Show Layer Controls", shortcut: "Ctrl+Shift+H" },
      { label: "Reset 3D View" },
      "-",
      { label: "Go To Time...", shortcut: "Alt+Shift+J" },
    ],
  },
  {
    name: "Window",
    items: [
      { label: "Workspace", submenu: true },
      { label: "Find Extensions on Exchange..." },
      { label: "Extensions", submenu: true },
      "-",
      { label: "Align" },
      { label: "Audio" },
      { label: "Brushes" },
      { label: "Character", shortcut: "Ctrl+6" },
      { label: "Composition", command: "show-composition", needsProject: true },
      { label: "Content-Aware Fill" },
      { label: "Effect Controls", shortcut: "F3", command: "show-effect-controls", needsProject: true },
      { label: "Effects & Presets", shortcut: "Ctrl+5" },
      { label: "Essential Graphics" },
      { label: "Info", shortcut: "Ctrl+2" },
      { label: "Libraries" },
      { label: "Lumetri Scopes" },
      { label: "Paragraph", shortcut: "Ctrl+7" },
      { label: "Preview", shortcut: "Ctrl+3" },
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
    name: "Help",
    items: [
      { label: "Home", command: "home" },
      "-",
      { label: "After Effects Help", shortcut: "F1" },
      { label: "Scripting Help" },
      { label: "Expression Reference" },
      { label: "Effect Reference" },
      { label: "Keyboard Shortcuts" },
      "-",
      { label: "Enable Logging" },
      { label: "Show Log Files" },
    ],
  },
];

interface MenuState {
  hasProject: boolean;
  enabled?: (command: MenuCommand) => boolean;
  /** A label that depends on the project, such as "Undo Move". */
  label?: (command: MenuCommand) => string | undefined;
  run: (command: MenuCommand) => void;
}

const runnable = (entry: Item, state: MenuState): boolean =>
  entry.items
    ? entry.items.some((e) => e !== "-" && runnable(e, state))
    : !!entry.command && !(entry.needsProject && !state.hasProject) && (state.enabled?.(entry.command) ?? true);

function MenuList({ name, entries, state, className }: { name: string; entries: Entry[]; state: MenuState; className?: string }) {
  const [sub, setSub] = useState<number>();
  return (
    <div className={`menu-pop ${className ?? ""}`} role="menu" aria-label={name}>
      {entries.map((entry, j) => {
        if (entry === "-") return <div key={j} className="menu-sep" role="separator" />;
        const label = (entry.command && state.label?.(entry.command)) || entry.label;
        const button = (
          <button
            key={j}
            type="button"
            role="menuitem"
            className={`menu-item ${entry.items && sub === j ? "open" : ""}`}
            aria-haspopup={entry.items ? "menu" : undefined}
            aria-expanded={entry.items ? sub === j : undefined}
            disabled={!runnable(entry, state)}
            onPointerEnter={() => setSub(entry.items ? j : undefined)}
            onClick={() => {
              if (entry.items) setSub(sub === j ? undefined : j);
              else if (entry.command) state.run(entry.command);
            }}
          >
            <span className="menu-label">{label}</span>
            <span className="menu-shortcut">{entry.shortcut}</span>
            <span className="menu-sub">{entry.submenu && <Icon name="chevronRight" size={10} />}</span>
          </button>
        );
        if (!entry.items) return button;
        return (
          <div key={j} className="menu-item-wrap">
            {button}
            {sub === j && <MenuList name={entry.label} entries={entry.items} state={state} className="menu-sub-pop" />}
          </div>
        );
      })}
    </div>
  );
}

/** The application menu bar. Only commands this viewer can carry out are enabled. */
export const MenuBar = memo(function MenuBar({
  hasProject,
  onCommand,
  enabled,
  label,
}: {
  hasProject: boolean;
  onCommand: (command: MenuCommand) => void;
  enabled?: (command: MenuCommand) => boolean;
  label?: (command: MenuCommand) => string | undefined;
}) {
  const [open, setOpen] = useState<number>();
  const bar = useRef<HTMLDivElement>(null);
  const state: MenuState = {
    hasProject,
    enabled,
    label,
    run: (command) => {
      setOpen(undefined);
      onCommand(command);
    },
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

  return (
    <div className="menubar" role="menubar" aria-label="Application menu" ref={bar}>
      {MENUS.map((menu, i) => (
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
