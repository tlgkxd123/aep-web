import { memo, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { FootageItem, Item, Project } from "../aep/model.ts";
import { footageStore } from "../media/store.ts";
import { openContextMenu } from "./ContextMenu.tsx";
import { AppActionsContext, projectItemMenu, projectPanelMenu } from "./contextMenus.ts";
import { ITEM_MIME, useEditing } from "./editing.tsx";
import { bitsPerChannel, colorCss, fpsLabel, fpsShort, labelColor, labelName, timecode } from "./format.ts";
import { Icon } from "./icons.tsx";
import { ItemIcon } from "./itemIcons.tsx";
import { LocateFootageButtons, useFootageVersion } from "./LocateFootage.tsx";

const isMissing = (item: Item) => item.kind === "footage" && !footageStore.isLocated(item);

type SortKey = "name" | "label" | "type" | "size" | "fps" | "path";

const COLUMNS: { key: SortKey; title: string; className: string }[] = [
  { key: "name", title: "Name", className: "pc-name" },
  { key: "label", title: "Label", className: "pc-label" },
  { key: "type", title: "Type", className: "pc-type" },
  { key: "size", title: "Size", className: "pc-size" },
  { key: "fps", title: "Frame Rate", className: "pc-fps" },
  { key: "path", title: "File Path", className: "pc-path" },
];

const FILE_TYPES: Record<string, string> = {
  png: "PNG file", jpg: "JPEG", jpeg: "JPEG", mov: "QuickTime", mp4: "MPEG", m4v: "MPEG", avi: "AVI", mxf: "MXF",
  wav: "WAV", mp3: "MP3", aif: "AIFF", aiff: "AIFF", exr: "OpenEXR", gif: "GIF", psd: "Photoshop", ai: "Illustrator",
  tif: "TIFF", tiff: "TIFF", dpx: "DPX", tga: "Targa", svg: "SVG", hdr: "Radiance",
};

function fileType(item: Item & { kind: "footage" }): string {
  const source = item.mainSource;
  if (source.sourceType === "SolidSource") return "Solid";
  if (source.sourceType === "PlaceholderSource") return "Placeholder";
  const ext = (/\.([a-z0-9]+)(?:\]|$)/i.exec(item.name)?.[1] ?? /\.([a-z0-9]+)$/i.exec(source.file)?.[1] ?? "").toLowerCase();
  const base = FILE_TYPES[ext] ?? (ext ? ext.toUpperCase() : "Footage");
  return /\[\d+-\d+\]/.test(item.name) ? `${base.replace(/ file$/, "")} Sequence` : base;
}

function typeName(item: Item): string {
  if (item.kind === "folder") return "Folder";
  if (item.kind === "comp") return "Composition";
  return fileType(item);
}

const sizeText = (item: Item) => (item.kind !== "folder" && item.width ? `${item.width} x ${item.height}` : "");

function fpsText(item: Item): string {
  if (item.kind === "comp") return fpsShort(item.frameRate);
  if (item.kind === "footage" && item.mainSource.sourceType === "FileSource" && !item.mainSource.isStill) return fpsShort(item.frameRate);
  return "";
}

const pathText = (item: Item) => (item.kind === "footage" && item.mainSource.sourceType === "FileSource" ? item.mainSource.file : "");

function sortValue(item: Item, key: SortKey): string | number {
  switch (key) {
    case "label":
      return item.label;
    case "type":
      return typeName(item);
    case "size":
      return item.kind === "folder" ? 0 : item.width * item.height;
    case "fps":
      return item.kind === "folder" ? 0 : item.frameRate;
    case "path":
      return pathText(item);
    default:
      return item.name;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

interface Row {
  item: Item;
  depth: number;
}

function ancestors(project: Project, id: number | undefined): number[] {
  const out: number[] = [];
  let item = id !== undefined ? project.items.get(id) : undefined;
  while (item && item.parentFolderId && project.items.has(item.parentFolderId)) {
    out.push(item.parentFolderId);
    item = project.items.get(item.parentFolderId);
  }
  return out;
}

function ItemInfo({ item, uses }: { item: Item | undefined; uses: number }) {
  if (!item || item.kind === "folder") return <div className="proj-info empty" />;
  const isFootage = item.kind === "footage";
  const solid = isFootage && item.mainSource.sourceType === "SolidSource" ? item.mainSource.color : undefined;
  const background = item.kind === "comp" ? colorCss(item.bgColor) : solid ? colorCss(solid) : undefined;
  const aspect = item.width && item.height ? (item.width * item.pixelAspect) / item.height : 16 / 9;
  const box = aspect >= 72 / 48 ? { width: 72, height: Math.max(6, 72 / aspect) } : { width: Math.max(6, 48 * aspect), height: 48 };
  const lines: string[] = [];
  if (item.width) lines.push(`${item.width} x ${item.height} (${item.pixelAspect.toFixed(2)})`);
  if (item.duration) lines.push(`Δ ${timecode(item.duration, item.frameRate || 24)}, ${fpsLabel(item.frameRate)} fps`);
  if (isFootage && item.mainSource.sourceType === "FileSource" && item.width === 0) lines.push("Audio only");
  if (solid) lines.push("Solid");
  if (isFootage && item.mainSource.sourceType === "PlaceholderSource") lines.push("Placeholder");
  else if (isMissing(item)) lines.push("Missing: use Locate Footage below");
  return (
    <div className="proj-info">
      <div className="proj-thumb-box">
        <div className="proj-thumb" style={{ ...box, background }}>
          {!background && <ItemIcon item={item} size={20} />}
        </div>
      </div>
      <div className="proj-meta">
        <div className="proj-meta-name">
          <span className="proj-meta-title">{item.name}</span>
          {uses > 0 && (
            <span className="dim">
              <Icon name="chevronDown" size={10} />, used {uses} {uses === 1 ? "time" : "times"}
            </span>
          )}
        </div>
        {lines.map((line) => (
          <div key={line}>{line}</div>
        ))}
        {item.comment && <div className="dim">{item.comment}</div>}
      </div>
    </div>
  );
}

/** Editing of the project's items from the panel (see useProjectOps). */
export interface ProjectPanelOps {
  rename(item: Item, name: string): void;
  move(items: Item[], folderId: number): void;
  /** Edit > Clear: asks first when the items are in use. */
  remove(items: Item[]): void;
  newFolder(): void;
  newComp(): void;
  importFiles(files: File[], folderId: number): void;
  replace(item: FootageItem, file: File): void;
  /** The item whose name is being edited. */
  renamingId: number | undefined;
  onRenamingChange(id: number | undefined): void;
}

const ITEMS_TYPE = "application/x-aep-items";
const isFileFootage = (item: Item): item is FootageItem => item.kind === "footage" && item.mainSource.sourceType === "FileSource";

function RenameField({ initial, onDone }: { initial: string; onDone: (name: string | undefined) => void }) {
  const done = useRef(false);
  const finish = (name: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="proj-rename"
      aria-label="Item name"
      defaultValue={initial}
      autoFocus
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(undefined);
      }}
      onBlur={(e) => finish(e.target.value)}
    />
  );
}

/** AE's Project panel: item info header, search, sortable item columns and the colour-depth footer. */
export const ProjectPanel = memo(function ProjectPanel({
  project,
  selectedId,
  onSelect,
  onOpenItem,
  selectedIds,
  onSelectIds,
  ops,
}: {
  project: Project;
  selectedId: number | undefined;
  onSelect: (id: number) => void;
  onOpenItem: (id: number) => void;
  /** The whole selection (Ctrl/Shift-click), when the host tracks it. */
  selectedIds?: readonly number[];
  onSelectIds?: (ids: number[]) => void;
  ops?: ProjectPanelOps;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(ancestors(project, selectedId)));
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [dropTarget, setDropTarget] = useState<number>();
  const renameTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rowsRef = useRef<HTMLDivElement>(null);
  useFootageVersion();
  // New solids and the Solids folder change the item tree inside the same project object.
  const { revision } = useEditing();

  const actions = useContext(AppActionsContext);

  useEffect(() => {
    setExpanded(new Set(ancestors(project, selectedId)));
  }, [project.file]);

  // Reveal items that commands select (an import into a folder, a new folder inside another).
  useEffect(() => {
    const up = ancestors(project, selectedId);
    if (up.length) setExpanded((prev) => (up.every((id) => prev.has(id)) ? prev : new Set([...prev, ...up])));
  }, [selectedId, project.items]);

  const selection = selectedIds ?? (selectedId !== undefined ? [selectedId] : []);
  const isSelected = (id: number) => selection.includes(id);
  const renamingId = ops?.renamingId;
  const startRename = (id: number) => {
    if (ops) ops.onRenamingChange(id);
  };
  const finishRename = (item: Item, name: string | undefined) => {
    ops?.onRenamingChange(undefined);
    if (name !== undefined && name !== item.name) ops?.rename(item, name);
    rowsRef.current?.focus();
  };

  // Revealing an item (e.g. a layer's source) opens the folders that hold it.
  useEffect(() => {
    const path = ancestors(project, selectedId);
    setExpanded((prev) => (path.every((id) => prev.has(id)) ? prev : new Set([...prev, ...path])));
  }, [selectedId]);

  const uses = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of project.items.values()) {
      if (item.kind !== "comp") continue;
      for (const layer of item.layers) counts.set(layer.sourceId, (counts.get(layer.sourceId) ?? 0) + 1);
    }
    return counts;
  }, [project, revision]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const compare = (a: Item, b: Item) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      const primary = typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va), String(vb));
      return (primary || collator.compare(a.name, b.name)) * sort.dir;
    };
    const matches = (item: Item): boolean =>
      item.name.toLowerCase().includes(q) || (item.kind === "folder" && item.items.some(matches));
    const out: Row[] = [];
    const walk = (items: Item[], depth: number) => {
      for (const item of [...items].sort(compare)) {
        if (q && !matches(item)) continue;
        out.push({ item, depth });
        if (item.kind === "folder" && (q || expanded.has(item.id))) walk(item.items, depth + 1);
      }
    };
    walk(project.rootFolder.items, 0);
    return out;
  }, [project, expanded, query, sort, revision]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const select = (ids: number[]) => {
    if (onSelectIds) onSelectIds(ids);
    else if (ids.length) onSelect(ids[0]);
  };

  const clickRow = (e: MouseEvent, item: Item) => {
    if (onSelectIds && (e.ctrlKey || e.metaKey)) {
      const rest = selection.filter((id) => id !== item.id);
      return select(rest.length === selection.length ? [item.id, ...selection] : rest);
    }
    if (onSelectIds && e.shiftKey && selectedId !== undefined) {
      const a = rows.findIndex((r) => r.item.id === selectedId);
      const b = rows.findIndex((r) => r.item.id === item.id);
      if (a >= 0 && b >= 0) {
        const range = rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.item.id);
        return select([selectedId, ...range.filter((id) => id !== selectedId)]);
      }
    }
    select([item.id]);
  };

  /** A click on the name of the only selected item renames it, like Explorer's slow double-click. */
  const clickName = (e: MouseEvent, item: Item) => {
    clearTimeout(renameTimer.current);
    if (!ops || e.ctrlKey || e.metaKey || e.shiftKey || e.detail > 1) return;
    if (selection.length === 1 && selection[0] === item.id) renameTimer.current = setTimeout(() => startRename(item.id), 500);
  };

  const selectedItems = () => selection.map((id) => project.items.get(id)).filter((i): i is Item => !!i);

  const onKeyDown = (e: KeyboardEvent) => {
    const index = rows.findIndex((r) => r.item.id === selectedId);
    const row = rows[index];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) select([next.item.id]);
    } else if (ops && row && e.key === "Enter" && e.code !== "NumpadEnter" && !e.altKey) {
      e.preventDefault();
      startRename(row.item.id);
    } else if (ops && (e.key === "Delete" || e.key === "Backspace") && selection.length) {
      e.preventDefault();
      ops.remove(selectedItems());
    } else if (row && e.key === "ArrowRight" && row.item.kind === "folder" && !expanded.has(row.item.id)) {
      toggle(row.item.id);
    } else if (row && e.key === "ArrowLeft") {
      if (row.item.kind === "folder" && expanded.has(row.item.id)) toggle(row.item.id);
      else if (row.item.parentFolderId && project.items.has(row.item.parentFolderId)) select([row.item.parentFolderId]);
    } else if (row && e.key === "Enter") {
      if (row.item.kind === "folder") toggle(row.item.id);
      else onOpenItem(row.item.id);
    }
  };

  const selected = selectedId !== undefined ? project.items.get(selectedId) : undefined;

  const dragKind = (e: DragEvent) => {
    const types = Array.from(e.dataTransfer?.types ?? []);
    return types.includes(ITEMS_TYPE) ? "items" : types.includes("Files") ? "files" : undefined;
  };
  /** Dropping on a folder puts the items in it; on another item, in that item's folder; below the rows, at the root. */
  const dropFolder = (target: Item | undefined) => (!target ? 0 : target.kind === "folder" ? target.id : target.parentFolderId);
  const dragOver = (e: DragEvent, target: Item | undefined) => {
    const kind = dragKind(e);
    if (!ops || !kind) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = kind === "items" ? "move" : "copy";
    const id = target && e.altKey && kind === "files" && isFileFootage(target) ? target.id : dropFolder(target);
    if (dropTarget !== id) setDropTarget(id);
  };
  const drop = (e: DragEvent, target: Item | undefined) => {
    const kind = dragKind(e);
    setDropTarget(undefined);
    if (!ops || !kind || e.defaultPrevented) return;
    // Handled here: the window's drop handler sees the default prevented and leaves it.
    e.preventDefault();
    const folderId = dropFolder(target);
    if (folderId) setExpanded((prev) => (prev.has(folderId) ? prev : new Set([...prev, folderId])));
    if (kind === "items") {
      e.stopPropagation();
      const ids = JSON.parse(e.dataTransfer.getData(ITEMS_TYPE) || "[]") as number[];
      const items = ids.map((id) => project.items.get(id)).filter((i): i is Item => !!i);
      if (items.length) ops.move(items, folderId);
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    if (e.altKey && target && isFileFootage(target)) ops.replace(target, files[0]);
    else ops.importFiles(files, folderId);
  };

  return (
    <div className="project">
      <ItemInfo item={selected} uses={selected ? (uses.get(selected.id) ?? 0) : 0} />
      <label className="search-field proj-search">
        <Icon name="search" size={12} />
        <input type="search" placeholder="" aria-label="Search project" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div
        className={`proj-scroll ${dropTarget === 0 ? "drop-root" : ""}`}
        onContextMenu={(e) => actions && openContextMenu(e, projectPanelMenu(actions))}
        onDragOver={(e) => dragOver(e, undefined)}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropTarget(undefined)}
        onDrop={(e) => drop(e, undefined)}
      >
        <div className="proj-table">
          <div className="proj-head" role="presentation">
            {COLUMNS.map((col) => (
              <button
                key={col.key}
                type="button"
                className={`proj-col ${col.className} ${sort.key === col.key ? "sorted" : ""}`}
                aria-label={`Sort by ${col.title}`}
                onClick={() => setSort((s) => ({ key: col.key, dir: s.key === col.key ? (-s.dir as 1 | -1) : 1 }))}
              >
                {col.key === "label" ? <Icon name="tag" size={12} /> : col.title}
                {sort.key === col.key && col.key !== "label" && (
                  <Icon name="chevronDown" size={10} className={sort.dir === 1 ? "sort-asc" : "sort-desc"} />
                )}
              </button>
            ))}
          </div>
          <div
            ref={rowsRef}
            className="proj-rows"
            role="tree"
            aria-label="Project items"
            aria-multiselectable={onSelectIds ? true : undefined}
            tabIndex={0}
            onKeyDown={onKeyDown}
          >
            {rows.map(({ item, depth }) => {
              const isFolder = item.kind === "folder";
              const open = isFolder && (expanded.has(item.id) || !!query.trim());
              const missing = isMissing(item);
              const renaming = renamingId === item.id;
              return (
                <div
                  key={item.id}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-selected={isSelected(item.id)}
                  aria-expanded={isFolder ? open : undefined}
                  className={`proj-row ${isSelected(item.id) ? "selected" : ""} ${missing ? "missing" : ""} ${dropTarget === item.id ? "drop-target" : ""}`}
                  onClick={(e) => clickRow(e, item)}
                  onDoubleClick={() => {
                    clearTimeout(renameTimer.current);
                    if (isFolder) toggle(item.id);
                    else onOpenItem(item.id);
                  }}
                  onContextMenu={(e) => {
                    if (!actions) return;
                    if (!isSelected(item.id)) onSelect(item.id);
                    openContextMenu(e, projectItemMenu(item, actions));
                  }}
                  draggable={!renaming && (!!ops || !isFolder)}
                  onDragStart={(e) => {
                    // Moves the selection between folders, or drops this item into a comp.
                    if (ops) e.dataTransfer.setData(ITEMS_TYPE, JSON.stringify(isSelected(item.id) ? selection : [item.id]));
                    if (!isFolder) e.dataTransfer.setData(ITEM_MIME, String(item.id));
                    e.dataTransfer.effectAllowed = ops ? (isFolder ? "move" : "copyMove") : "copy";
                    if (!isSelected(item.id)) onSelect(item.id);
                  }}
                  onDragOver={(e) => dragOver(e, item)}
                  onDrop={(e) => drop(e, item)}
                  title={pathText(item) || undefined}
                >
                  <span className="pc-name" style={{ paddingLeft: 4 + depth * 14 }}>
                    {isFolder ? (
                      <span
                        className={`twirl ${open ? "open" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(item.id);
                        }}
                        aria-hidden="true"
                      >
                        <Icon name="twirl" size={10} />
                      </span>
                    ) : (
                      <span className="twirl-space" />
                    )}
                    <ItemIcon item={item} />
                    {renaming ? (
                      <RenameField initial={item.name} onDone={(name) => finishRename(item, name)} />
                    ) : (
                      <span className="cell-text" onClick={(e) => clickName(e, item)}>
                        {item.name || "(unnamed)"}
                      </span>
                    )}
                    {missing && (
                      <span className="missing-mark" title="Missing footage" aria-label="missing">
                        <Icon name="warning" size={10} />
                      </span>
                    )}
                  </span>
                  <span className="pc-label">
                    <span className="label-chip" style={{ background: labelColor(item.label) }} title={labelName(item.label)} />
                  </span>
                  <span className="pc-type">{typeName(item)}</span>
                  <span className="pc-size">{sizeText(item)}</span>
                  <span className="pc-fps">{fpsText(item)}</span>
                  <span className="pc-path">{pathText(item)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <footer className="panel-foot proj-foot">
        <span className="foot-btn" title="Interpret Footage" aria-hidden="true">
          <Icon name="interpret" size={14} />
        </span>
        {ops ? (
          <>
            <button type="button" className="foot-btn" title="Create a new Folder" aria-label="Create a new Folder" onClick={ops.newFolder}>
              <Icon name="folder" size={14} />
            </button>
            <button type="button" className="foot-btn" title="Create a new Composition" aria-label="Create a new Composition" onClick={ops.newComp}>
              <Icon name="comp" size={14} />
            </button>
          </>
        ) : (
          <>
            <span className="foot-btn" title="Create a new Folder" aria-hidden="true">
              <Icon name="folder" size={14} />
            </span>
            <span className="foot-btn" title="Create a new Composition" aria-hidden="true">
              <Icon name="comp" size={14} />
            </span>
          </>
        )}
        <span className="foot-btn" title="Composition Flowchart" aria-hidden="true">
          <Icon name="flowchart" size={14} />
        </span>
        <LocateFootageButtons />
        <span className="foot-bpc" title="Project color depth">
          {bitsPerChannel(project.bitsPerChannel)} bpc
        </span>
        {ops ? (
          <button
            type="button"
            className="foot-btn foot-end"
            title="Delete"
            aria-label="Delete selected items"
            disabled={!selection.length}
            onClick={() => ops.remove(selectedItems())}
          >
            <Icon name="trash" size={14} />
          </button>
        ) : (
          <span className="foot-btn foot-end" title="Delete" aria-hidden="true">
            <Icon name="trash" size={14} />
          </span>
        )}
      </footer>
    </div>
  );
});
