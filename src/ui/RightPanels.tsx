import { memo, useState, type ReactNode } from "react";
import type { CompItem, Project } from "../aep/model.ts";
import { bitsPerChannel, bytesLabel, fpsLabel } from "./format.ts";
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

function PreviewPanel({
  comp,
  playing,
  onPlay,
  onStep,
  onEdge,
}: {
  comp: CompItem | undefined;
  playing: boolean;
  onPlay: () => void;
  onStep: (frames: number) => void;
  onEdge: (end: boolean) => void;
}) {
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
        <span className="pv-includes" aria-hidden="true">
          <Icon name="footage" size={14} />
          <Icon name="speaker" size={14} />
          <Icon name="overflow" size={14} />
        </span>
      </div>
      <Field label="Range">
        <Dropdown text="Work Area Extended By Current Time" label="Range" />
      </Field>
      <Field label="Play From">
        <Dropdown text="Range Start" label="Play From" />
      </Field>
      <div className="pv-row">
        <Field label="Frame Rate">
          <Dropdown text={comp ? `(${Number(comp.frameRate.toFixed(2))})` : "Auto"} label="Frame Rate" width={64} />
        </Field>
        <Field label="Skip">
          <span className="hot">0</span>
        </Field>
        <Field label="Resolution">
          <Dropdown text="Auto" label="Resolution" width={60} />
        </Field>
      </div>
    </div>
  );
}

function AlignPanel() {
  const align: IconName[] = ["alignLeft", "alignCenterH", "alignRight", "alignTop", "alignMiddle", "alignBottom"];
  return (
    <div className="align">
      <Field label="Align Layers to:">
        <Dropdown text="Composition" label="Align Layers to" width={110} />
      </Field>
      <div className="align-row" aria-hidden="true">
        {align.map((icon) => (
          <Icon key={icon} name={icon} size={16} />
        ))}
      </div>
      <span className="pv-label">Distribute Layers:</span>
      <div className="align-row" aria-hidden="true">
        {align.map((icon) => (
          <Icon key={icon} name={icon} size={16} />
        ))}
      </div>
    </div>
  );
}

/** The right-hand stack of the Default workspace. */
export const RightPanels = memo(function RightPanels({
  project,
  comp,
  file,
  playing,
  onPlay,
  onStep,
  onEdge,
}: {
  project: Project;
  comp: CompItem | undefined;
  file: FileInfo;
  playing: boolean;
  onPlay: () => void;
  onStep: (frames: number) => void;
  onEdge: (end: boolean) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(["Info", "Preview", "Effects & Presets"]));
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
      {panel("Preview", <PreviewPanel comp={comp} playing={playing} onPlay={onPlay} onStep={onStep} onEdge={onEdge} />)}
      {panel("Effects & Presets", <EffectsPresetsPanel project={project} />, true)}
      {panel("Align", <AlignPanel />)}
      {panel("Libraries", <p className="panel-empty">Creative Cloud Libraries are not available in this viewer.</p>)}
    </div>
  );
});
