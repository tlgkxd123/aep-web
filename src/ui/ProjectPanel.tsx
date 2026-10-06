import { useState } from "react";
import type { Item, Project } from "../aep/model.ts";
import { colorCss, num } from "./format.ts";

interface Props {
  project: Project;
  selectedId: number | undefined;
  onSelect: (item: Item) => void;
}

function describe(item: Item): string {
  if (item.kind === "comp") return `${item.width}×${item.height}, ${num(item.duration)}s @ ${num(item.frameRate)} fps`;
  if (item.kind === "footage") {
    const size = item.width ? `${item.width}×${item.height}` : "no video";
    if (item.mainSource.sourceType === "SolidSource") return `solid ${size}`;
    if (item.mainSource.sourceType === "PlaceholderSource") return `placeholder ${size}`;
    return `${size}${item.duration ? `, ${num(item.duration)}s` : ""}`;
  }
  return `${item.items.length} items`;
}

function ItemRow({ item, depth, selectedId, onSelect }: { item: Item; depth: number } & Omit<Props, "project">) {
  const [open, setOpen] = useState(depth < 1);
  const isFolder = item.kind === "folder";
  const icon = isFolder ? (open ? "▾" : "▸") : item.kind === "comp" ? "◧" : "▭";
  return (
    <>
      <li
        className={`row ${selectedId === item.id ? "selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (isFolder ? setOpen(!open) : onSelect(item))}
        title={item.kind === "footage" && item.mainSource.sourceType === "FileSource" ? item.mainSource.file : undefined}
      >
        <span className={`icon icon-${item.kind}`}>{icon}</span>
        {item.kind === "footage" && item.mainSource.sourceType === "SolidSource" && (
          <span className="swatch" style={{ background: colorCss(item.mainSource.color) }} />
        )}
        <span className="name">{item.name || "(unnamed)"}</span>
        <span className="meta">{describe(item)}</span>
      </li>
      {isFolder &&
        open &&
        item.items.map((child) => (
          <ItemRow key={child.id} item={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
        ))}
    </>
  );
}

export function ProjectPanel({ project, selectedId, onSelect }: Props) {
  return (
    <ul className="tree" aria-label="Project items">
      {project.rootFolder.items.map((item) => (
        <ItemRow key={item.id} item={item} depth={0} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </ul>
  );
}
