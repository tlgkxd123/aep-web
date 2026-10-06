import { useCallback, useState, type DragEvent } from "react";
import type { CompItem, Item, Layer, Project } from "../aep/model.ts";
import { parseProject } from "../aep/parse.ts";
import { ChunkPanel } from "./ChunkPanel.tsx";
import { EffectsPanel } from "./EffectsPanel.tsx";
import { ProjectPanel } from "./ProjectPanel.tsx";
import { PropertyPanel } from "./PropertyPanel.tsx";
import { TimelinePanel } from "./TimelinePanel.tsx";
import { bytesLabel } from "./format.ts";

type Tab = "composition" | "effects" | "chunks";

interface Loaded {
  project: Project;
  fileName: string;
  size: number;
  parseMs: number;
}

async function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function firstComp(project: Project): CompItem | undefined {
  const comps = [...project.items.values()].filter((i): i is CompItem => i.kind === "comp");
  return comps.find((c) => c.layers.length) ?? comps[0];
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [comp, setComp] = useState<CompItem>();
  const [layer, setLayer] = useState<Layer>();
  const [tab, setTab] = useState<Tab>("composition");

  const open = useCallback(async (file: File) => {
    setBusy(true);
    setError(undefined);
    try {
      const bytes = await readBytes(file);
      const started = performance.now();
      const project = parseProject(bytes);
      const parseMs = performance.now() - started;
      const initial = firstComp(project);
      setLoaded({ project, fileName: file.name, size: bytes.length, parseMs });
      setComp(initial);
      setLayer(initial?.layers[0]);
      setTab("composition");
    } catch (e) {
      setError(`Could not read ${file.name}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void open(file);
  };

  const selectItem = (item: Item) => {
    if (item.kind !== "comp") return;
    setComp(item);
    setLayer(item.layers[0]);
    setTab("composition");
  };

  const picker = (
    <label className="button">
      {loaded ? "Open another…" : "Choose .aep file"}
      <input
        type="file"
        accept=".aep"
        aria-label="Open After Effects project"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void open(file);
          e.target.value = "";
        }}
      />
    </label>
  );

  return (
    <div
      className={`app ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header>
        <h1>AEP Web</h1>
        {loaded && (
          <span className="file-info">
            {loaded.fileName} · {bytesLabel(loaded.size)} · saved with AE {loaded.project.version} · {loaded.project.bitsPerChannel} bpc ·
            parsed in {Math.round(loaded.parseMs)} ms
          </span>
        )}
        {loaded && picker}
      </header>

      {error && <p className="error banner">{error}</p>}
      {busy && <p className="banner">Reading project…</p>}

      {!loaded && !busy && (
        <div className="welcome">
          <p>Drop an After Effects project (.aep) anywhere in this window.</p>
          <p className="muted">The file is read locally in your browser and never uploaded.</p>
          {picker}
        </div>
      )}

      {loaded && (
        <main>
          <section className="panel project-panel">
            <h2>Project</h2>
            <ProjectPanel project={loaded.project} selectedId={comp?.id} onSelect={selectItem} />
            {loaded.project.warnings.length > 0 && (
              <details className="warnings">
                <summary>{loaded.project.warnings.length} parser warnings</summary>
                <ul>
                  {loaded.project.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
          <section className="panel center-panel">
            <nav className="tabs" role="tablist">
              {(["composition", "effects", "chunks"] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                  {t === "composition" ? "Composition" : t === "effects" ? `Effects (${loaded.project.effectTypes.size})` : "Raw chunks"}
                </button>
              ))}
            </nav>
            {tab === "composition" &&
              (comp ? <TimelinePanel comp={comp} selectedLayer={layer} onSelect={setLayer} /> : <p className="empty">No compositions in this project.</p>)}
            {tab === "effects" && <EffectsPanel project={loaded.project} />}
            {tab === "chunks" && <ChunkPanel root={loaded.project.file.root} />}
          </section>
          <section className="panel property-panel">
            <h2>Properties</h2>
            {comp && layer ? <PropertyPanel key={`${comp.id}-${layer.id}`} layer={layer} comp={comp} /> : <p className="empty">Select a layer.</p>}
          </section>
        </main>
      )}
    </div>
  );
}
