import { memo, useContext, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { Item, Project } from "../aep/model.ts";
import { footageStore } from "../media/store.ts";
import { openContextMenu } from "./ContextMenu.tsx";
import { AppActionsContext, projectItemMenu, projectPanelMenu } from "./contextMenus.ts";
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

/** AE's Project panel: item info header, search, sortable item columns and the colour-depth footer. */
export const ProjectPanel = memo(function ProjectPanel({
  project,
  selectedId,
  onSelect,
  onOpenItem,
}: {
  project: Project;
  selectedId: number | undefined;
  onSelect: (id: number) => void;
  onOpenItem: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(ancestors(project, selectedId)));
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  useFootageVersion();

  const actions = useContext(AppActionsContext);

  useEffect(() => {
    setExpanded(new Set(ancestors(project, selectedId)));
  }, [project]);

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
  }, [project]);

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
  }, [project, expanded, query, sort]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent) => {
    const index = rows.findIndex((r) => r.item.id === selectedId);
    const row = rows[index];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) onSelect(next.item.id);
    } else if (row && e.key === "ArrowRight" && row.item.kind === "folder" && !expanded.has(row.item.id)) {
      toggle(row.item.id);
    } else if (row && e.key === "ArrowLeft") {
      if (row.item.kind === "folder" && expanded.has(row.item.id)) toggle(row.item.id);
      else if (row.item.parentFolderId && project.items.has(row.item.parentFolderId)) onSelect(row.item.parentFolderId);
    } else if (row && e.key === "Enter") {
      if (row.item.kind === "folder") toggle(row.item.id);
      else onOpenItem(row.item.id);
    }
  };

  const selected = selectedId !== undefined ? project.items.get(selectedId) : undefined;

  return (
    <div className="project">
      <ItemInfo item={selected} uses={selected ? (uses.get(selected.id) ?? 0) : 0} />
      <label className="search-field proj-search">
        <Icon name="search" size={12} />
        <input type="search" placeholder="" aria-label="Search project" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="proj-scroll" onContextMenu={(e) => actions && openContextMenu(e, projectPanelMenu(actions))}>
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
          <div className="proj-rows" role="tree" aria-label="Project items" tabIndex={0} onKeyDown={onKeyDown}>
            {rows.map(({ item, depth }) => {
              const isFolder = item.kind === "folder";
              const open = isFolder && (expanded.has(item.id) || !!query.trim());
              const missing = isMissing(item);
              return (
                <div
                  key={item.id}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-selected={item.id === selectedId}
                  aria-expanded={isFolder ? open : undefined}
                  className={`proj-row ${item.id === selectedId ? "selected" : ""} ${missing ? "missing" : ""}`}
                  onClick={() => onSelect(item.id)}
                  onDoubleClick={() => (isFolder ? toggle(item.id) : onOpenItem(item.id))}
                  onContextMenu={(e) => {
                    if (!actions) return;
                    onSelect(item.id);
                    openContextMenu(e, projectItemMenu(item, actions));
                  }}
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
                    <span className="cell-text">{item.name || "(unnamed)"}</span>
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
        <span className="foot-btn" title="Create a new Folder" aria-hidden="true">
          <Icon name="folder" size={14} />
        </span>
        <span className="foot-btn" title="Create a new Composition" aria-hidden="true">
          <Icon name="comp" size={14} />
        </span>
        <span className="foot-btn" title="Composition Flowchart" aria-hidden="true">
          <Icon name="flowchart" size={14} />
        </span>
        <LocateFootageButtons />
        <span className="foot-bpc" title="Project color depth">
          {bitsPerChannel(project.bitsPerChannel)} bpc
        </span>
        <span className="foot-btn foot-end" title="Delete" aria-hidden="true">
          <Icon name="trash" size={14} />
        </span>
      </footer>
    </div>
  );
});
