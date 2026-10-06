import { memo, useState } from "react";
import { useEditing } from "./editing.tsx";
import { Icon, type IconName } from "./icons.tsx";

interface Tool {
  id: string;
  icon: IconName;
  name: string;
  shortcut: string;
  flyout?: boolean;
}

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
    { id: "rect", icon: "rect", name: "Rectangle Tool", shortcut: "Q", flyout: true },
    { id: "pen", icon: "pen", name: "Pen Tool", shortcut: "G", flyout: true },
    { id: "type", icon: "type", name: "Horizontal Type Tool", shortcut: "Ctrl+T", flyout: true },
    { id: "brush", icon: "brush", name: "Brush Tool", shortcut: "Ctrl+B" },
    { id: "clone", icon: "clone", name: "Clone Stamp Tool", shortcut: "Ctrl+B" },
    { id: "eraser", icon: "eraser", name: "Eraser Tool", shortcut: "Ctrl+B" },
    { id: "roto", icon: "roto", name: "Roto Brush Tool", shortcut: "Alt+W", flyout: true },
    { id: "puppet", icon: "puppet", name: "Puppet Position Pin Tool", shortcut: "Ctrl+P", flyout: true },
  ],
];

const WORKSPACES = ["Default", "Review", "Learn", "Standard", "Small Screen", "Libraries"];

/** The Tools strip: tool buttons on the left, snapping, and the workspace switcher on the right. */
export const Toolbar = memo(function Toolbar({ onHome }: { onHome: () => void }) {
  const editing = useEditing();
  const [localTool, setLocalTool] = useState("selection");
  const tool = editing.setTool ? editing.tool : localTool;
  const setTool = editing.setTool ?? setLocalTool;
  const [snapping, setSnapping] = useState(false);
  return (
    <div className="toolbar" role="toolbar" aria-label="Tools">
      <button type="button" className="tool" title="Home" aria-label="Home" onClick={onHome}>
        <Icon name="home" />
      </button>
      <span className="tool-sep" />
      {TOOL_GROUPS.map((group, g) => (
        <div key={g} className="tool-group">
          {group.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tool ${tool === t.id ? "active" : ""}`}
              title={`${t.name} (${t.shortcut})`}
              aria-label={t.name}
              aria-pressed={tool === t.id}
              onClick={() => setTool(t.id)}
            >
              <Icon name={t.icon} />
              {t.flyout && <span className="tool-flyout" aria-hidden="true" />}
            </button>
          ))}
        </div>
      ))}
      <span className="tool-sep" />
      <label className="snapping">
        <input type="checkbox" checked={snapping} onChange={(e) => setSnapping(e.target.checked)} />
        <span className="ae-check-box" aria-hidden="true">
          {snapping && <Icon name="check" size={10} />}
        </span>
        <Icon name="magnet" size={14} />
        <span>Snapping</span>
      </label>
      <nav className="workspaces" aria-label="Workspaces">
        {WORKSPACES.map((w, i) => (
          <span key={w} className={`workspace ${i === 0 ? "active" : ""}`} aria-current={i === 0 ? "true" : undefined}>
            {w}
            {i === 0 && <Icon name="menu" size={12} />}
          </span>
        ))}
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
