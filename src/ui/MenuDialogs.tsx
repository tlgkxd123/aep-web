// The small dialogs menu commands open: Layer > Transform values, View > Go To Time, Layer > Layer Settings and
// Keyboard Shortcuts.
import { useId, useState, type FormEvent } from "react";
import type { CompItem, Layer } from "../aep/model.ts";
import { transformValueAt } from "../edit/transform-ops.ts";
import { Dialog } from "./Dialog.tsx";
import { parseTimecode, timecode } from "./format.ts";
import { menuShortcuts, type TransformDialogKind } from "./MenuBar.tsx";
import "./menuDialogs.css";

const TRANSFORM: Record<TransformDialogKind, { title: string; matchName: string; fields: string[]; unit?: string }> = {
  anchor: { title: "Anchor Point", matchName: "ADBE Anchor Point", fields: ["X", "Y", "Z"] },
  position: { title: "Position", matchName: "ADBE Position", fields: ["X", "Y", "Z"] },
  scale: { title: "Scale", matchName: "ADBE Scale", fields: ["Width", "Height", "Depth"], unit: "%" },
  rotation: { title: "Rotation", matchName: "ADBE Rotate Z", fields: ["Degrees"], unit: "°" },
  opacity: { title: "Opacity", matchName: "ADBE Opacity", fields: ["Opacity"], unit: "%" },
};

export const transformMatchName = (kind: TransformDialogKind) => TRANSFORM[kind].matchName;

const numberText = (v: number) => String(Number(v.toFixed(3)));

/** Layer > Transform > Anchor Point... / Position... / Scale... / Rotation... / Opacity...: the value at the current time. */
export function TransformDialog({
  kind,
  layer,
  time,
  onOk,
  onCancel,
}: {
  kind: TransformDialogKind;
  layer: Layer;
  time: number;
  onOk: (value: number | number[]) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const spec = TRANSFORM[kind];
  const current = transformValueAt(layer, spec.matchName, time);
  const count = spec.fields.length === 1 ? 1 : Math.min(layer.threeDLayer ? 3 : 2, current.length || 2);
  const [texts, setTexts] = useState(() => Array.from({ length: count }, (_, i) => numberText(current[i] ?? 0)));
  const values = texts.map((t) => Number(t));
  const valid = texts.every((t) => t.trim() !== "") && values.every(Number.isFinite) && (kind !== "opacity" || (values[0] >= 0 && values[0] <= 100));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onOk(count === 1 ? values[0] : values);
  };
  return (
    <Dialog title={spec.title} className="menu-dialog" onCancel={onCancel}>
      <form onSubmit={submit}>
        <div className="md-fields">
          {texts.map((text, i) => (
            <div key={i} className="md-row">
              <label htmlFor={`${id}-${i}`}>{spec.fields[i]}:</label>
              <input
                id={`${id}-${i}`}
                className="ae-field"
                inputMode="decimal"
                value={text}
                autoFocus={i === 0}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setTexts(texts.map((t, j) => (j === i ? e.target.value : t)))}
              />
              <span className="dim">{spec.unit}</span>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="submit" className="ae-primary" disabled={!valid}>
            OK
          </button>
          <button type="button" className="ae-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** View > Go To Time: a timecode or frame number in the comp's display time. */
export function GoToTimeDialog({ comp, time, onOk, onCancel }: { comp: CompItem; time: number; onOk: (time: number) => void; onCancel: () => void }) {
  const id = useId();
  const [text, setText] = useState(() => timecode(time + comp.displayStartTime, comp.frameRate));
  const parsed = parseTimecode(text, comp.frameRate);
  const target = parsed === undefined ? undefined : parsed - comp.displayStartTime;
  const valid = target !== undefined && target >= 0 && target < comp.duration;
  return (
    <Dialog title="Go to Time" className="menu-dialog" onCancel={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onOk(target);
        }}
      >
        <div className="md-fields">
          <div className="md-row">
            <label htmlFor={id}>Time:</label>
            <input id={id} className="ae-field" value={text} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setText(e.target.value)} />
            <span className="dim">{`Base ${Math.round(comp.frameRate)}`}</span>
          </div>
        </div>
        <div className="dialog-actions">
          <button type="submit" className="ae-primary" disabled={!valid}>
            OK
          </button>
          <button type="button" className="ae-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Layer > Layer Settings: the layer's name. */
export function LayerSettingsDialog({ layer, onOk, onCancel }: { layer: Layer; onOk: (name: string) => void; onCancel: () => void }) {
  const id = useId();
  const [name, setName] = useState(layer.name);
  return (
    <Dialog title="Layer Settings" className="menu-dialog" onCancel={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onOk(name.trim());
        }}
      >
        <div className="md-fields">
          <div className="md-row">
            <label htmlFor={id}>Name:</label>
            <input id={id} className="ae-field" value={name} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
            <span />
          </div>
        </div>
        <div className="dialog-actions">
          <button type="submit" className="ae-primary">
            OK
          </button>
          <button type="button" className="ae-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Edit > Keyboard Shortcuts: the shortcuts of the menu commands this app carries out. */
export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows = menuShortcuts();
  return (
    <Dialog title="Keyboard Shortcuts" className="menu-dialog md-shortcuts" onCancel={onClose}>
      <table className="md-table">
        <thead>
          <tr>
            <th scope="col">Menu</th>
            <th scope="col">Command</th>
            <th scope="col">Shortcut</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.menu}/${r.label}/${r.shortcut}`}>
              <td>{r.menu}</td>
              <td>{r.label}</td>
              <td>
                <kbd>{r.shortcut}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dialog-actions">
        <button type="button" className="ae-primary" autoFocus onClick={onClose}>
          OK
        </button>
      </div>
    </Dialog>
  );
}
