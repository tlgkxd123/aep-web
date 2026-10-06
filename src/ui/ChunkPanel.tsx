import { useState } from "react";
import { chunkLabel, type Chunk } from "../aep/riff.ts";
import { bytesLabel } from "./format.ts";

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
      <div className="panel-toolbar">
        <strong>{chunkLabel(chunk)}</strong>
        <span className="meta">
          offset {chunk.offset} · {bytesLabel(chunk.data.length)}
          {chunk.data.length > HEX_LIMIT ? ` · first ${bytesLabel(HEX_LIMIT)} shown` : ""}
        </span>
      </div>
      {chunk.error && <p className="error">{chunk.error}</p>}
      <pre>{lines.join("\n")}</pre>
    </div>
  );
}

function ChunkRow({ chunk, depth, selected, onSelect }: { chunk: Chunk; depth: number; selected: Chunk | undefined; onSelect: (c: Chunk) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const kids = chunk.children ?? [];
  return (
    <>
      <li
        className={`row ${selected === chunk ? "selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          onSelect(chunk);
          if (kids.length) setOpen(!open);
        }}
      >
        <span className="icon">{kids.length ? (open ? "▾" : "▸") : "·"}</span>
        <span className="name mono">{chunkLabel(chunk)}</span>
        <span className="meta">{kids.length ? `${kids.length} children` : bytesLabel(chunk.data.length)}</span>
      </li>
      {open && kids.map((child, i) => <ChunkRow key={i} chunk={child} depth={depth + 1} selected={selected} onSelect={onSelect} />)}
    </>
  );
}

/** Raw RIFX chunk tree with a hex dump, for reverse-engineering data the parser does not decode yet. */
export function ChunkPanel({ root }: { root: Chunk }) {
  const [selected, setSelected] = useState<Chunk | undefined>();
  return (
    <div className="chunks">
      <ul className="tree">
        <ChunkRow chunk={root} depth={0} selected={selected} onSelect={setSelected} />
      </ul>
      {selected ? <HexView chunk={selected} /> : <p className="empty">Select a chunk to see its bytes.</p>}
    </div>
  );
}
