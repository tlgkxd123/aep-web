import { useEffect, useState } from "react";
import { browseLocal, type LocalEntry, type LocalListing } from "../media/localFootage.ts";
import { isImportable } from "../media/probe.ts";
import { bytesLabel } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Dialog } from "./Dialog.tsx";

const LAST_FOLDER = "aep-web.importFolder";

function lastFolder(): string {
  try {
    return localStorage.getItem(LAST_FOLDER) ?? "";
  } catch {
    return "";
  }
}

/**
 * File > Import > File through the dev server: browses this machine's folders
 * so the footage keeps its real absolute path, like AE's Import File dialog.
 */
export function ImportDialog({
  title,
  action,
  multiple,
  onChoose,
  onSystemDialog,
  onCancel,
}: {
  title: string;
  /** The confirm button, "Import" or "Replace". */
  action: string;
  multiple: boolean;
  onChoose: (paths: string[]) => void;
  /** Falls back to the browser's own file dialog (the file then has no known path). */
  onSystemDialog: () => void;
  onCancel: () => void;
}) {
  const [listing, setListing] = useState<LocalListing>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);

  const go = (dir: string, fallBack = false) => {
    setError(undefined);
    browseLocal(dir).then(
      (l) => {
        setListing(l);
        setSelected([]);
        try {
          localStorage.setItem(LAST_FOLDER, l.dir);
        } catch {
          // Private windows may refuse storage; the dialog then starts at the drives.
        }
      },
      (e: Error) => (fallBack && dir ? go("") : setError(`Could not open ${dir || "the list of drives"}: ${e.message}`)),
    );
  };
  // The last folder may have gone since: then the drives.
  useEffect(() => go(lastFolder(), true), []);

  const entries = [...(listing?.entries ?? [])]
    .filter((e) => e.folder || isImportable(e.name))
    .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  const click = (entry: LocalEntry, add: boolean) => {
    if (entry.folder) return setSelected([]);
    setSelected((prev) => (multiple && add ? (prev.includes(entry.path) ? prev.filter((p) => p !== entry.path) : [...prev, entry.path]) : [entry.path]));
  };
  const open = (entry: LocalEntry) => (entry.folder ? go(entry.path) : onChoose([entry.path]));
  const names = selected.map((p) => p.split(/[\\/]/).pop()).join(" ");

  return (
    <Dialog title={title} className="import-dialog" onCancel={onCancel}>
      <div className="imp-bar">
        <button type="button" className="imp-up" aria-label="Up one level" disabled={listing?.parent == null} onClick={() => listing?.parent != null && go(listing.parent)}>
          <Icon name="chevronRight" size={12} className="imp-up-icon" />
        </button>
        <input
          key={listing?.dir}
          className="imp-path"
          aria-label="Folder"
          defaultValue={listing?.dir ?? ""}
          placeholder="This PC"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            go(e.currentTarget.value.trim().replace(/^"(.*)"$/, "$1"));
          }}
        />
      </div>
      <div className="imp-list" role="listbox" aria-label="Files" aria-multiselectable={multiple}>
        {error && <p className="panel-empty">{error}</p>}
        {entries.map((entry) => (
          <div
            key={entry.path}
            role="option"
            aria-selected={selected.includes(entry.path)}
            className={`imp-row ${selected.includes(entry.path) ? "selected" : ""}`}
            onClick={(e) => click(entry, e.ctrlKey || e.metaKey)}
            onDoubleClick={() => open(entry)}
            onKeyDown={(e) => e.key === "Enter" && open(entry)}
            tabIndex={0}
          >
            <Icon name={entry.folder ? "folder" : /\.(mp4|m4v|mov)$/i.test(entry.name) ? "footage" : "still"} size={14} />
            <span className="imp-name">{entry.name}</span>
            <span className="imp-size dim">{entry.size !== undefined ? bytesLabel(entry.size) : ""}</span>
          </div>
        ))}
        {listing && !entries.length && !error && <p className="panel-empty">No importable files in this folder.</p>}
      </div>
      <div className="imp-foot">
        <span className="dim">File name:</span>
        <span className="imp-selection" aria-label="Selected files">
          {names}
        </span>
      </div>
      <div className="imp-foot">
        <span className="dim">Import As:</span>
        <span>Footage</span>
      </div>
      <div className="dialog-actions">
        <button type="button" className="ae-link" onClick={onSystemDialog}>
          Use the system file dialog…
        </button>
        <span className="dialog-spacer" />
        <button type="button" className="ae-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ae-primary" disabled={!selected.length} onClick={() => onChoose(selected)}>
          {action}
        </button>
      </div>
    </Dialog>
  );
}
