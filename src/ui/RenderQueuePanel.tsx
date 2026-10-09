// The Render Queue panel: compositions added with Composition > Add to Render
// Queue (Ctrl+M), their render settings and output module, and the Render button.
// Renders run in the browser (WebGL frames, WebCodecs H.264/VP9, AAC/Opus audio).
import { useSyncExternalStore } from "react";
import type { CompItem, Project } from "../aep/model.ts";
import { canPickFiles, pickOutputFile } from "../export/output.ts";
import { renderQueue, type QueueItem } from "../export/queue.ts";
import {
  FORMATS,
  QUALITY_LABELS,
  RESOLUTION_LABELS,
  type AudioOutput,
  type Format,
  type Quality,
  type Resolution,
  type TimeSpan,
} from "../export/settings.ts";

const clock = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) return "--";
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const megabytes = (bytes: number | undefined) => (bytes === undefined ? "" : `${(bytes / 1048576).toFixed(1)} MB`);

function Select<T extends string | number>({ label, value, options, onChange, disabled }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <label className="rq-field">
      <span className="dim">{label}</span>
      <select
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const picked = options.find(([v]) => String(v) === e.target.value);
          if (picked) onChange(picked[0]);
        }}
      >
        {options.map(([v, text]) => (
          <option key={String(v)} value={String(v)}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function ItemRow({ item, index, busy }: { item: QueueItem; index: number; busy: boolean }) {
  const locked = busy || item.status === "Rendering";
  const s = item.settings;
  const o = item.output;
  const progress = item.frames ? item.frame / item.frames : 0;
  const pickFile = async () => {
    const handle = await pickOutputFile(item.fileName, o.format);
    if (handle) renderQueue.setOutputFile(item.id, handle.name, handle);
  };
  return (
    <div className={`rq-item ${item.status === "Rendering" ? "rendering" : ""}`} role="listitem" aria-label={`${item.compName}: ${item.status}`}>
      <div className="rq-row">
        <input
          type="checkbox"
          aria-label="Render"
          checked={item.status === "Queued" || item.status === "Rendering"}
          disabled={locked}
          onChange={(e) => renderQueue.setQueued(item.id, e.target.checked)}
        />
        <span>{index + 1}</span>
        <span className="rq-name" title={item.compName}>
          {item.compName}
        </span>
        <span className={`rq-status ${item.status.replace(/\s/g, "-").toLowerCase()}`}>
          {item.status}
          {item.status === "Rendering" && ` ${item.frame}/${item.frames}`}
        </span>
        <span>{item.started ? new Date(item.started).toLocaleTimeString() : "-"}</span>
        <span>
          {clock(item.renderMs)} {item.status === "Done" && megabytes(item.bytes)}
        </span>
        <button type="button" className="rq-remove" aria-label={`Remove ${item.compName}`} disabled={locked} onClick={() => renderQueue.remove(item.id)}>
          ✕
        </button>
      </div>
      {item.status === "Rendering" && (
        <div className="rq-bar" aria-hidden="true">
          <span style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      <div className="rq-settings">
        <Select<Quality>
          label="Quality"
          value={o.quality ?? "good"}
          disabled={locked}
          options={(["fast", "good", "high"] as const).map((q) => [q, QUALITY_LABELS[q]])}
          onChange={(quality) => renderQueue.setOutput(item.id, { ...o, quality })}
        />
        <Select<Resolution>
          label="Resolution"
          value={s.resolution}
          disabled={locked}
          options={([1, 2, 3, 4] as const).map((r) => [r, RESOLUTION_LABELS[r]])}
          onChange={(resolution) => renderQueue.setSettings(item.id, { ...s, resolution })}
        />
        <Select<TimeSpan>
          label="Time Span"
          value={s.timeSpan === "custom" ? "workArea" : s.timeSpan}
          disabled={locked}
          options={[
            ["workArea", "Work Area Only"],
            ["comp", "Length of Comp"],
          ]}
          onChange={(timeSpan) => renderQueue.setSettings(item.id, { ...s, timeSpan })}
        />
        <Select<Format>
          label="Format"
          value={o.format}
          disabled={locked}
          options={(["h264", "vp9", "png"] as const).map((f) => [f, f === "h264" ? "H.264 (MP4)" : FORMATS[f].label])}
          onChange={(format) => renderQueue.setOutput(item.id, { ...o, format })}
        />
        <Select<AudioOutput>
          label="Audio"
          value={o.audio}
          disabled={locked || o.format === "png"}
          options={[
            ["auto", "Auto"],
            ["on", "On"],
            ["off", "Off"],
          ]}
          onChange={(audio) => renderQueue.setOutput(item.id, { ...o, audio })}
        />
        <label className="rq-field rq-output">
          <span className="dim">Output To</span>
          {canPickFiles() ? (
            <button type="button" className="hot-link" disabled={locked} onClick={() => void pickFile()} title={item.handle ? "Saved to the picked file" : "Click to choose where to save; otherwise it downloads"}>
              {item.fileName}
            </button>
          ) : (
            <span>{item.fileName} (downloads)</span>
          )}
        </label>
      </div>
      {item.error && <p className="rq-error">{item.error}</p>}
      {item.status === "Done" && item.perf && <p className="rq-perf">{item.perf}</p>}
    </div>
  );
}

export function RenderQueuePanel({ project, activeComp }: { project: Project | undefined; activeComp: CompItem | undefined }) {
  const snapshot = useSyncExternalStore(renderQueue.subscribe, renderQueue.getSnapshot);
  const current = snapshot.current;
  const busy = !!current;
  const queued = snapshot.items.some((i) => i.status === "Queued");
  return (
    <div className="render-queue">
      <div className="rq-head">
        <span className="dim">Current Render</span>
        {current ? (
          <span className="rq-progress">
            Frame {current.frame} of {current.frames} · Elapsed {clock(current.elapsedMs)} · Remaining {clock(current.remainingMs)}
            {current.elapsedMs > 0 && current.frame > 0 && ` · ${((current.frame * 1000) / current.elapsedMs).toFixed(1)} fps`}
          </span>
        ) : null}
        <span className="rq-spacer" />
        <button type="button" className="ae-button" disabled={!project || !activeComp || busy} onClick={() => project && activeComp && renderQueue.add(project, activeComp)} title="Composition > Add to Render Queue (Ctrl+M)">
          Add Active Comp
        </button>
        {busy && (
          <button type="button" className="ae-button" onClick={() => renderQueue.setPaused(!current.paused)}>
            {current.paused ? "Continue" : "Pause"}
          </button>
        )}
        {busy ? (
          <button type="button" className="ae-button ae-primary" onClick={() => renderQueue.stop()}>
            Stop
          </button>
        ) : (
          <button type="button" className="ae-button ae-primary" disabled={!queued} onClick={() => void renderQueue.render()}>
            Render
          </button>
        )}
      </div>
      <div className="rq-cols" aria-hidden="true">
        <span>Render</span>
        <span>#</span>
        <span>Comp Name</span>
        <span>Status</span>
        <span>Started</span>
        <span>Render Time</span>
        <span />
      </div>
      <div className="rq-list" role="list" aria-label="Render Queue">
        {snapshot.items.length === 0 && <p className="panel-empty">Open a composition and press Ctrl+M (Composition &gt; Add to Render Queue) to render it to MP4.</p>}
        {snapshot.items.map((item, i) => (
          <ItemRow key={item.id} item={item} index={i} busy={busy} />
        ))}
      </div>
    </div>
  );
}
