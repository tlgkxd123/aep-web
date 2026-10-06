import { useState } from "react";
import { chunkLabel, type Chunk } from "../aep/riff.ts";
import { bytesLabel } from "./format.ts";
import { Icon } from "./icons.tsx";

const HEX_LIMIT = 4096;

function HexView({ chunk }: { chunk: Chunk }) {
  const bytes = chunk.data.subarray(0, HEX_LIMIT);
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const text = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${i.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${text}`);
  }
  return (
    <div className="hex">
      <div className="hex-head">
        <strong className="mono">{chunkLabel(chunk)}</strong>
        <span className="dim">
          offset {chunk.offset} · {bytesLabel(chunk.data.length)}
          {chunk.data.length > HEX_LIMIT ? ` · first ${bytesLabel(HEX_LIMIT)} shown` : ""}
        </span>
      </div>
      {chunk.error && <p className="chunk-error">{chunk.error}</p>}
      <pre>{lines.join("\n")}</pre>
    </div>
  );
}

function ChunkRow({ chunk, depth, selected, onSelect }: { chunk: Chunk; depth: number; selected: Chunk | undefined; onSelect: (c: Chunk) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const kids = chunk.children ?? [];
  return (
    <div role="treeitem" aria-level={depth + 1} aria-expanded={kids.length ? open : undefined} aria-selected={selected === chunk}>
      <div
        className={`chunk-row ${selected === chunk ? "selected" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => {
          onSelect(chunk);
          if (kids.length) setOpen(!open);
        }}
      >
        {kids.length ? (
          <span className={`twirl ${open ? "open" : ""}`} aria-hidden="true">
            <Icon name="twirl" size={10} />
          </span>
        ) : (
          <span className="twirl-space" />
        )}
        <span className="cell-text mono">{chunkLabel(chunk)}</span>
        <span className="dim chunk-meta">{kids.length ? `${kids.length} children` : bytesLabel(chunk.data.length)}</span>
      </div>
      {open && kids.length > 0 && (
        <div role="group">
          {kids.map((child, i) => (
            <ChunkRow key={i} chunk={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Raw RIFX chunk tree with a hex dump, for reverse-engineering data the parser does not decode yet. */
export function ChunkPanel({ root }: { root: Chunk }) {
  const [selected, setSelected] = useState<Chunk | undefined>();
  return (
    <div className="chunks">
      <div className="chunk-tree" role="tree" aria-label="RIFX chunks">
        <ChunkRow chunk={root} depth={0} selected={selected} onSelect={setSelected} />
      </div>
      {selected ? <HexView chunk={selected} /> : <p className="panel-empty">Select a chunk to see its bytes.</p>}
    </div>
  );
}
