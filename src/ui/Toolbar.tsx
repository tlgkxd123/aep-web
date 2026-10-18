import { memo, useState, type MouseEvent } from "react";
import { openMenuBelow } from "./ContextMenu.tsx";
import {
  isPenTool,
  isShapeTool,
  PEN_TOOLS,
  rememberTool,
  SHAPE_TOOLS,
  shownTool,
  TOOL_NAMES,
  TYPE_TOOLS,
  useDrawOptions,
  drawOptions,
} from "./drawTools.ts";
import { useEditing } from "./editing.tsx";
import { colorCss } from "./format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { ScrubNumber } from "./TransformValue.tsx";
import "./drawing.css";

interface Tool {
  id: string;
  icon: IconName;
  name: string;
  shortcut: string;
  flyout?: boolean;
  /** The tools this button stands for, the last one picked shown (Rectangle, Pen and Type). */
  group?: { name: "shape" | "pen" | "type"; tools: readonly string[] };
}

const SHORTCUTS: Record<string, string> = { shape: "Q", pen: "G", type: "Ctrl+T" };

const TOOL_GROUPS: Tool[][] = [
  [
    { id: "selection", icon: "selection", name: "Selection Tool", shortcut: "V" },
    { id: "hand", icon: "hand", name: "Hand Tool", shortcut: "H" },
    { id: "zoom", icon: "zoom", name: "Zoom Tool", shortcut: "Z" },
  ],
  [
    { id: "orbit", icon: "orbit", name: "Orbit Around Cursor Tool", shortcut: "1", flyout: true },
    { id: "pan", icon: "pan", name: "Pan Under Cursor Tool", shortcut: "2", flyout: true },
    { id: "dolly", icon: "dolly", name: "Dolly Towards Cursor Tool", shortcut: "3", flyout: true },
  ],
  [
    { id: "rotation", icon: "rotation", name: "Rotation Tool", shortcut: "W" },
    { id: "anchor", icon: "anchor", name: "Pan Behind (Anchor Point) Tool", shortcut: "Y" },
    { id: "rect", icon: "rect", name: "Rectangle Tool", shortcut: "Q", flyout: true, group: { name: "shape", tools: SHAPE_TOOLS } },
    { id: "pen", icon: "pen", name: "Pen Tool", shortcut: "G", flyout: true, group: { name: "pen", tools: PEN_TOOLS } },
    { id: "type", icon: "type", name: "Horizontal Type Tool", shortcut: "Ctrl+T", flyout: true, group: { name: "type", tools: TYPE_TOOLS } },
    { id: "brush", icon: "brush", name: "Brush Tool", shortcut: "Ctrl+B" },
    { id: "clone", icon: "clone", name: "Clone Stamp Tool", shortcut: "Ctrl+B" },
    { id: "eraser", icon: "eraser", name: "Eraser Tool", shortcut: "Ctrl+B" },
    { id: "roto", icon: "roto", name: "Roto Brush Tool", shortcut: "Alt+W", flyout: true },
    { id: "puppet", icon: "puppet", name: "Puppet Position Pin Tool", shortcut: "Ctrl+P", flyout: true },
  ],
];

export const WORKSPACES = ["Default", "Review", "Learn", "Standard", "Small Screen", "Libraries"] as const;
export type Workspace = (typeof WORKSPACES)[number];

/** The tools the Composition viewer carries out, the ones compact screens offer. */
const WORKING_TOOLS = new Set(["selection", "hand", "zoom", "rotation", "anchor", "rect", "pen", "type"]);

const toHex = (c: readonly number[]) => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** The options of the shape tools and the Pen: what they create, the Fill and Stroke and the stroke width. */
function DrawToolOptions({ penOnly }: { penOnly: boolean }) {
  const options = useDrawOptions();
  const paint = (kind: "fill" | "stroke") => {
    const color = options[kind];
    const label = kind === "fill" ? "Fill" : "Stroke";
    return (
      <span className="tool-paint">
        <button
          type="button"
          className={`tool-paint-toggle ${color ? "on" : ""}`}
          title={`${label}: ${color ? "Solid Color" : "None"} (click to turn ${color ? "off" : "on"})`}
          aria-label={`${label} on`}
          aria-pressed={!!color}
          onClick={() => drawOptions.set({ [kind]: color ? null : (kind === "fill" ? [1, 0, 0] : [1, 1, 1]) })}
        >
          {label}:
        </button>
        <label className={`tool-swatch ${kind} ${color ? "" : "none"}`} title={`${label} Color`} style={{ background: color ? colorCss(color) : undefined }}>
          <input type="color" aria-label={`${label} Color`} value={toHex(color ?? [1, 1, 1])} onChange={(e) => drawOptions.set({ [kind]: fromHex(e.target.value) })} />
        </label>
      </span>
    );
  };
  return (
    <div className="tool-options" role="group" aria-label="Tool options">
      {!penOnly && <span className="tool-sep" />}
      <button
        type="button"
        className={`tool ${options.creates === "shape" ? "active" : ""}`}
        title="Tool Creates Shape (on a selected shape layer)"
        aria-pressed={options.creates === "shape"}
        onClick={() => drawOptions.set({ creates: "shape" })}
      >
        <Icon name="star" size={14} />
      </button>
      <button
        type="button"
        className={`tool ${options.creates === "mask" ? "active" : ""}`}
        title="Tool Creates Mask (on a selected shape layer)"
        aria-pressed={options.creates === "mask"}
        onClick={() => drawOptions.set({ creates: "mask" })}
      >
        <Icon name="maskPath" size={14} />
      </button>
      {paint("fill")}
      {paint("stroke")}
      <span className="tool-stroke-width" title="Stroke Width">
        <ScrubNumber
          value={options.strokeWidth}
          text={`${Math.round(options.strokeWidth * 10) / 10} px`}
          label="Stroke Width"
          step={0.5}
          onChange={(v) => drawOptions.set({ strokeWidth: Math.max(0, Math.round(v * 10) / 10) })}
          onEnd={() => {}}
        />
      </span>
    </div>
  );
}

/**
 * The Tools strip: tool buttons on the left, snapping, and the workspace switcher on the right. Compact screens get
 * the working tools and snapping only.
 */
export const Toolbar = memo(function Toolbar({
  onHome,
  workspace = "Default",
  onWorkspace,
  compact = false,
}: {
  onHome: () => void;
  workspace?: Workspace;
  onWorkspace?: (w: Workspace) => void;
  compact?: boolean;
}) {
  const editing = useEditing();
  const [localTool, setLocalTool] = useState("selection");
  const tool = editing.setTool ? editing.tool : localTool;
  const pickTool = editing.setTool ?? setLocalTool;
  const setTool = (id: string) => {
    rememberTool(id);
    pickTool(id);
  };
  const [localSnapping, setLocalSnapping] = useState(false);
  const snapping = editing.setSnapping ? editing.snapping : localSnapping;
  const setSnapping = editing.setSnapping ?? setLocalSnapping;
  const flyout = (e: MouseEvent<HTMLElement>, t: Tool) => {
    if (!t.group) return;
    e.preventDefault();
    openMenuBelow(
      e.currentTarget,
      t.group.tools.map((id) => ({ label: TOOL_NAMES[id] ?? id, shortcut: SHORTCUTS[t.group!.name], checked: tool === id, onSelect: () => setTool(id) })),
    );
  };
  const toolButton = (t: Tool) => {
    const id = t.group ? (t.group.tools.includes(tool) ? tool : shownTool(t.group.name)) : t.id;
    const name = TOOL_NAMES[id] ?? t.name;
    // Compact screens have no right button and no flyout arrow: tapping the tool in use opens its flyout.
    const more = t.group ? (compact ? ", tap again for more" : ", right-click for more") : "";
    return (
      <button
        key={t.id}
        type="button"
        className={`tool ${tool === id ? "active" : ""}`}
        title={`${name} (${t.shortcut})${more}`}
        aria-label={name}
        aria-pressed={tool === id}
        aria-haspopup={compact && t.group ? "menu" : undefined}
        onClick={(e) => (compact && t.group && tool === id ? flyout(e, t) : setTool(id))}
        onContextMenu={(e) => flyout(e, t)}
      >
        <Icon name={(t.group ? id : t.icon) as IconName} />
        {t.flyout && !compact && (
          <span
            className="tool-flyout"
            aria-hidden="true"
            onClick={(e) => {
              e.stopPropagation();
              flyout(e, t);
            }}
          />
        )}
      </button>
    );
  };
  const drawing = isShapeTool(tool) || tool === "pen";
  const toolOptions = drawing && <DrawToolOptions penOnly={isPenTool(tool)} />;
  const snappingToggle = (
    <label className="snapping">
      <input type="checkbox" checked={snapping} onChange={(e) => setSnapping(e.target.checked)} />
      <span className="ae-check-box" aria-hidden="true">
        {snapping && <Icon name="check" size={10} />}
      </span>
      <Icon name="magnet" size={14} />
      <span>Snapping</span>
    </label>
  );
  if (compact) {
    return (
      <div className="toolbar compact" role="toolbar" aria-label="Tools">
        {TOOL_GROUPS.flat()
          .filter((t) => WORKING_TOOLS.has(t.id))
          .map(toolButton)}
        <span className="tool-sep" />
        {snappingToggle}
        {toolOptions}
      </div>
    );
  }
  return (
    <div className="toolbar" role="toolbar" aria-label="Tools">
      <button type="button" className="tool" title="Home" aria-label="Home" onClick={onHome}>
        <Icon name="home" />
      </button>
      <span className="tool-sep" />
      {TOOL_GROUPS.map((group, g) => (
        <div key={g} className="tool-group">
          {group.map(toolButton)}
        </div>
      ))}
      <span className="tool-sep" />
      {snappingToggle}
      {toolOptions}
      <nav className="workspaces" aria-label="Workspaces">
        {WORKSPACES.map((w) =>
          onWorkspace ? (
            <button
              key={w}
              type="button"
              className={`workspace ${w === workspace ? "active" : ""}`}
              aria-current={w === workspace ? "true" : undefined}
              onClick={() => onWorkspace(w)}
            >
              {w}
              {w === workspace && <Icon name="menu" size={12} />}
            </button>
          ) : (
            <span key={w} className={`workspace ${w === workspace ? "active" : ""}`} aria-current={w === workspace ? "true" : undefined}>
              {w}
              {w === workspace && <Icon name="menu" size={12} />}
            </span>
          ),
        )}
        <span className="workspace more" aria-hidden="true">
          <Icon name="overflow" size={12} />
        </span>
      </nav>
      <span className="tool help-search" aria-hidden="true">
        <Icon name="search" />
      </span>
    </div>
  );
});
