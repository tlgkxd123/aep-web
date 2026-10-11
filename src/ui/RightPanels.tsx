import { memo, useEffect, useState, type ReactNode } from "react";
import type { CompItem, Layer, Project } from "../aep/model.ts";
import { moveLayers } from "../edit/transform-ops.ts";
import { DEFAULT_PREVIEW, type PreviewSettings } from "../playback/usePlayback.ts";
import { ChunkPanel } from "./ChunkPanel.tsx";
import { attempt, useEditing } from "./editing.tsx";
import { bitsPerChannel, bytesLabel, fpsLabel } from "./format.ts";
import { bounds } from "./viewerOverlays.tsx";
import { EffectsPresetsPanel } from "./EffectsPresetsPanel.tsx";
import { useHover } from "./hover.ts";
import { Icon, type IconName } from "./icons.tsx";
import { StackedPanel } from "./Panel.tsx";
import { Dropdown } from "./values.tsx";

export interface FileInfo {
  name: string;
  size: number;
  parseMs: number;
}

function InfoPanel({ project, comp, file }: { project: Project; comp: CompItem | undefined; file: FileInfo }) {
  const hover = useHover();
  const [r, g, b, a] = hover?.rgba ?? [0, 0, 0, 0];
  return (
    <div className="info">
      <div className="info-readout">
        <dl className="info-rgba">
          <dt className="ch-r">R:</dt>
          <dd>{r}</dd>
          <dt className="ch-g">G:</dt>
          <dd>{g}</dd>
          <dt className="ch-b">B:</dt>
          <dd>{b}</dd>
          <dt>A:</dt>
          <dd>{a}</dd>
        </dl>
        <dl className="info-xy">
          <dt>X:</dt>
          <dd>{hover?.x ?? ""}</dd>
          <dt>Y:</dt>
          <dd>{hover?.y ?? ""}</dd>
        </dl>
      </div>
      <div className="info-text">
        {comp && (
          <p>
            {comp.name}: {comp.width} x {comp.height}, {fpsLabel(comp.frameRate)} fps
          </p>
        )}
        <p>
          {file.name} · {bytesLabel(file.size)}
        </p>
        <p className="dim">
          After Effects {project.version} · {bitsPerChannel(project.bitsPerChannel)} bpc · {project.expressionEngine || "expressions"} · read
          in {Math.round(file.parseMs)} ms
        </p>
      </div>
      {project.warnings.length > 0 && (
        <section className="info-warnings" aria-label="Parser warnings">
          <h3>
            <Icon name="warning" size={12} /> {project.warnings.length} parser {project.warnings.length === 1 ? "warning" : "warnings"}
          </h3>
          <ul>
            {project.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AudioPanel() {
  const scale = ["0.0", "-3.0", "-6.0", "-9.0", "-12.0", "-15.0", "-18.0", "-21.0", "-24.0"];
  return (
    <div className="audio" aria-label="Audio levels, idle">
      <div className="audio-meters">
        <span className="audio-meter" />
        <span className="audio-meter" />
      </div>
      <div className="audio-scale">
        {scale.map((s) => (
          <span key={s}>{s} dB</span>
        ))}
      </div>
    </div>
  );
}

function PreviewButton({ icon, label, onClick, on }: { icon: IconName; label: string; onClick: () => void; on?: boolean }) {
  return (
    <button type="button" className={`pv-btn ${on ? "on" : ""}`} aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} size={16} />
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pv-field">
      <span className="pv-label">{label}</span>
      {children}
    </div>
  );
}

const RANGES: [PreviewSettings["range"], string][] = [
  ["workArea", "Work Area"],
  ["extended", "Work Area Extended By Current Time"],
  ["comp", "Entire Duration"],
];
const RATES = [8, 10, 12, 12.5, 15, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

function PreviewPanel({
  comp,
  playing,
  onPlay,
  onStep,
  onEdge,
  settings,
  onSettings,
}: {
  comp: CompItem | undefined;
  playing: boolean;
  onPlay: () => void;
  onStep: (frames: number) => void;
  onEdge: (end: boolean) => void;
  settings: PreviewSettings;
  onSettings: (s: PreviewSettings) => void;
}) {
  const set = (patch: Partial<PreviewSettings>) => onSettings({ ...settings, ...patch });
  const rateText = settings.frameRate ? String(settings.frameRate) : comp ? `(${Number(comp.frameRate.toFixed(2))})` : "Auto";
  return (
    <div className="preview">
      <div className="pv-transport">
        <PreviewButton icon="first" label="First Frame" onClick={() => onEdge(false)} />
        <PreviewButton icon="prevFrame" label="Previous Frame" onClick={() => onStep(-1)} />
        <PreviewButton icon={playing ? "stop" : "play"} label={playing ? "Stop" : "Play/Stop"} onClick={onPlay} on={playing} />
        <PreviewButton icon="nextFrame" label="Next Frame" onClick={() => onStep(1)} />
        <PreviewButton icon="last" label="Last Frame" onClick={() => onEdge(true)} />
      </div>
      <div className="pv-row">
        <Field label="Shortcut">
          <Dropdown text="Spacebar" label="Shortcut" width={96} />
        </Field>
        <span className="pv-includes">
          <PreviewButton icon="speaker" label="Include Audio" on={settings.audio} onClick={() => set({ audio: !settings.audio })} />
          <PreviewButton icon="overflow" label="Loop" on={settings.loop} onClick={() => set({ loop: !settings.loop })} />
        </span>
      </div>
      <Field label="Range">
        <Dropdown
          text={RANGES.find(([id]) => id === settings.range)?.[1] ?? ""}
          label="Range"
          menu={() => RANGES.map(([id, label]) => ({ label, checked: settings.range === id, onSelect: () => set({ range: id }) }))}
        />
      </Field>
      <Field label="Play From">
        <Dropdown
          text={settings.playFrom === "start" ? "Range Start" : "Current Time"}
          label="Play From"
          menu={() => [
            { label: "Range Start", checked: settings.playFrom === "start", onSelect: () => set({ playFrom: "start" }) },
            { label: "Current Time", checked: settings.playFrom === "current", onSelect: () => set({ playFrom: "current" }) },
          ]}
        />
      </Field>
      <div className="pv-row">
        <Field label="Frame Rate">
          <Dropdown
            text={rateText}
            label="Frame Rate"
            width={64}
            menu={() => [
              { label: "Auto", checked: !settings.frameRate, onSelect: () => set({ frameRate: 0 }) },
              "-",
              ...RATES.map((r) => ({ label: String(r), checked: settings.frameRate === r, onSelect: () => set({ frameRate: r }) })),
            ]}
          />
        </Field>
        <Field label="Skip">
          <Dropdown
            text={String(settings.skip)}
            label="Skip"
            width={40}
            menu={() => [0, 1, 2, 3, 4, 5].map((n) => ({ label: String(n), checked: settings.skip === n, onSelect: () => set({ skip: n }) }))}
          />
        </Field>
        <Field label="Resolution">
          <Dropdown text="Auto" label="Resolution" width={60} />
        </Field>
      </div>
    </div>
  );
}

type AlignMode = "left" | "centerH" | "right" | "top" | "middle" | "bottom";
const ALIGN: [AlignMode, IconName, string][] = [
  ["left", "alignLeft", "Align Left"],
  ["centerH", "alignCenterH", "Align Horizontal Center"],
  ["right", "alignRight", "Align Right"],
  ["top", "alignTop", "Align Top"],
  ["middle", "alignMiddle", "Align Vertical Center"],
  ["bottom", "alignBottom", "Align Bottom"],
];

/** Align panel: aligns the selected layer's bounds to the composition. Distributing needs several selected layers. */
function AlignPanel({ comp, layer, time }: { comp: CompItem | undefined; layer: Layer | undefined; time: number }) {
  const editing = useEditing();
  const { editor } = editing;
  const box = comp && layer ? bounds(comp, layer, time) : undefined;
  const align = (mode: AlignMode) => {
    if (!editor || !comp || !layer || !box) return;
    const [x0, y0, x1, y1] = box;
    const dx = mode === "left" ? -x0 : mode === "right" ? comp.width - x1 : mode === "centerH" ? comp.width / 2 - (x0 + x1) / 2 : 0;
    const dy = mode === "top" ? -y0 : mode === "bottom" ? comp.height - y1 : mode === "middle" ? comp.height / 2 - (y0 + y1) / 2 : 0;
    attempt(editing, () => moveLayers(editor, comp, [layer], [dx, dy], time));
  };
  return (
    <div className="align">
      <Field label="Align Layers to:">
        <Dropdown text="Composition" label="Align Layers to" width={110} />
      </Field>
      <div className="align-row">
        {ALIGN.map(([mode, icon, label]) => (
          <button key={mode} type="button" className="pv-btn" title={label} aria-label={label} disabled={!editor || !box || layer?.locked} onClick={() => align(mode)}>
            <Icon name={icon} size={16} />
          </button>
        ))}
      </div>
      <span className="pv-label">Distribute Layers:</span>
      <div className="align-row" aria-hidden="true">
        {ALIGN.map(([mode, icon]) => (
          <Icon key={mode} name={icon} size={16} />
        ))}
      </div>
    </div>
  );
}

/**
 * The right-hand stack of the Default workspace. Compact screens show it as their More panel: Effects & Presets has
 * a tab of its own there, and RIFX Chunks (a viewer tab on desktop screens) joins the stack, opened by `showChunks`.
 */
export const RightPanels = memo(function RightPanels({
  project,
  comp,
  file,
  playing,
  onPlay,
  onStep,
  onEdge,
  preview = DEFAULT_PREVIEW,
  onPreview,
  selectedLayer,
  time = 0,
  compact = false,
  showChunks = false,
  reveal,
}: {
  project: Project;
  comp: CompItem | undefined;
  file: FileInfo;
  playing: boolean;
  onPlay: () => void;
  onStep: (frames: number) => void;
  onEdge: (end: boolean) => void;
  preview?: PreviewSettings;
  onPreview?: (s: PreviewSettings) => void;
  selectedLayer?: Layer;
  time?: number;
  compact?: boolean;
  showChunks?: boolean;
  /** A panel Window menu asked for, opened when `seq` changes. */
  reveal?: { name: string; seq: number };
}) {
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(["Info", "Preview", ...(compact ? [] : ["Effects & Presets"]), ...(showChunks ? ["RIFX Chunks"] : [])]),
  );
  useEffect(() => {
    if (showChunks) setOpen((prev) => (prev.has("RIFX Chunks") ? prev : new Set([...prev, "RIFX Chunks"])));
  }, [showChunks]);
  useEffect(() => {
    if (reveal) setOpen((prev) => (prev.has(reveal.name) ? prev : new Set([...prev, reveal.name])));
  }, [reveal]);
  const [localPreview, setLocalPreview] = useState(preview);
  const settings = onPreview ? preview : localPreview;
  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  const panel = (name: string, body: ReactNode, grow = false) => (
    <StackedPanel key={name} name={name} open={open.has(name)} onToggle={() => toggle(name)} grow={grow}>
      {body}
    </StackedPanel>
  );
  return (
    <div className="stack">
      {panel("Info", <InfoPanel project={project} comp={comp} file={file} />)}
      {panel("Audio", <AudioPanel />)}
      {panel(
        "Preview",
        <PreviewPanel
          comp={comp}
          playing={playing}
          onPlay={onPlay}
          onStep={onStep}
          onEdge={onEdge}
          settings={settings}
          onSettings={onPreview ?? setLocalPreview}
        />,
      )}
      {!compact && panel("Effects & Presets", <EffectsPresetsPanel project={project} target={selectedLayer} />, true)}
      {panel("Align", <AlignPanel comp={comp} layer={selectedLayer} time={time} />)}
      {compact && panel("RIFX Chunks", <ChunkPanel root={project.file.root} />, true)}
      {panel("Libraries", <p className="panel-empty">Creative Cloud Libraries are not available in this viewer.</p>)}
    </div>
  );
});
