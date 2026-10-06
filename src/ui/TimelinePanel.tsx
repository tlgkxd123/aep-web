import {
  memo,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { CompItem, Layer, Project, Property } from "../aep/model.ts";
import type { Editor, LayerSwitch } from "../edit/editor.ts";
import { addLayer } from "../edit/layers.ts";
import { isTransformValue, resetTransform, toggleTransformStopwatch, transformProp } from "../edit/transform-ops.ts";
import { keyframeAt, valueAt } from "./animate.ts";
import { openContextMenu } from "./ContextMenu.tsx";
import { AppActionsContext, layerMenu } from "./contextMenus.ts";
import { attempt, ITEM_MIME, LAYER_MIME, nextDragKey, useEditing } from "./editing.tsx";
import { modeEntries, parentEntries, QUALITY, trackMatteEntries } from "./layerRowMenus.ts";
import {
  blendingModeName,
  colorCss,
  fpsLabel,
  frameLabel,
  interpolationName,
  labelColor,
  maskModeName,
  parseTimecode,
  timecode,
} from "./format.ts";
import { Icon, KeyframeGlyph, type IconName } from "./icons.tsx";
import { LayerIcon } from "./itemIcons.tsx";
import {
  findProperty,
  isAnimated,
  isCameraOrLight,
  layerEffects,
  layerHasAudio,
  layerHasVideo,
  layerOutline,
  outlineChildren,
  sourceItem,
  type DisplayNode,
} from "./properties.ts";
import { TransformValue } from "./TransformValue.tsx";
import { Checkbox, Dropdown, PropertyValueView } from "./values.tsx";

const NO_MATTE = 5012;
const FRAME_BLEND_NONE = 4012;
const QUALITY_ICON: Record<number, IconName> = { 4614: "qualityBest", 4613: "qualityDraft", 4612: "qualityWire" };
const SEARCH_NODE_BUDGET = 20000;

type Row =
  | { kind: "layer"; key: string; layer: Layer }
  | { kind: "node"; key: string; layer: Layer; node: DisplayNode; depth: number }
  | { kind: "expr"; key: string; layer: Layer; prop: Property; depth: number };

interface View {
  start: number;
  span: number;
}

const pct = (t: number, view: View) => `${((t - view.start) / view.span) * 100}%`;

function layerByIndexLabel(comp: CompItem, id: number): string | undefined {
  const layer = comp.layers.find((l) => l.id === id);
  return layer ? `${layer.index}. ${layer.name}` : undefined;
}

function displayName(layer: Layer, project: Project): { text: string; bracketed: boolean; source: string } {
  const source = sourceItem(layer, project)?.name ?? layer.name;
  const text = layer.name || source;
  return { text, bracketed: !layer.name || layer.name === source, source };
}

/* ---------- ruler ---------- */

function rulerLabel(frames: number, fps: number, wholeSeconds: boolean): string {
  const f = Math.round(fps) || 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  const total = Math.floor(frames / f);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  if (wholeSeconds) return h ? `${h}:${pad(m)}:${pad(s)}s` : m ? `${pad(m)}:${pad(s)}s` : `${pad(s)}s`;
  return `${m ? `${pad(m)}:` : ""}${pad(s)}:${pad(frames % f)}f`;
}

function Ruler({ comp, view, width }: { comp: CompItem; view: View; width: number }) {
  const fps = comp.frameRate || 24;
  const f = Math.round(fps) || 1;
  const pxPerFrame = width / Math.max(1e-6, view.span * fps);
  const steps = [1, 2, 5, 10, f / 2, f, 2 * f, 5 * f, 10 * f, 15 * f, 30 * f, 60 * f, 120 * f, 300 * f, 600 * f, 1800 * f, 3600 * f]
    .filter((s) => Number.isInteger(s) && s > 0)
    .sort((a, b) => a - b);
  const step = steps.find((s) => s * pxPerFrame >= 64) ?? steps[steps.length - 1] ?? f;
  const minor = [10, 5, 4, 2].map((n) => step / n).find((m) => Number.isInteger(m) && m * pxPerFrame >= 7) ?? step;
  const offset = comp.displayStartTime * fps;
  const first = Math.ceil((view.start * fps + offset) / minor) * minor;
  const last = (view.start + view.span) * fps + offset;
  const ticks: { frame: number; major: boolean }[] = [];
  for (let frame = first; frame <= last && ticks.length < 600; frame += minor) ticks.push({ frame, major: frame % step === 0 });
  return (
    <div className="tl-ruler-ticks" aria-hidden="true">
      {ticks.map(({ frame, major }) => {
        const left = pct((frame - offset) / fps, view);
        return (
          <span key={frame} className={`tl-tick ${major ? "major" : ""}`} style={{ left }}>
            {major && <span className="tl-tick-label">{rulerLabel(frame, fps, step % f === 0)}</span>}
          </span>
        );
      })}
    </div>
  );
}

export function TimeDisplay({
  comp,
  time,
  onTime,
  title = "Current Time (click to edit)",
}: {
  comp: CompItem;
  time: number;
  onTime: (t: number) => void;
  title?: string;
}) {
  const [editing, setEditing] = useState(false);
  const tc = timecode(time + comp.displayStartTime, comp.frameRate);
  if (editing) {
    return (
      <input
        className="tl-timecode-input"
        aria-label="Go to time"
        autoFocus
        defaultValue={tc}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const seconds = parseTimecode(e.currentTarget.value, comp.frameRate);
            if (seconds !== undefined) onTime(seconds - comp.displayStartTime);
            setEditing(false);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button type="button" className="tl-timecode" title={title} onClick={() => setEditing(true)}>
      {tc}
    </button>
  );
}

/* ---------- rows ---------- */

function Switch({ icon, on, label, blank, onToggle }: { icon: IconName; on: boolean; label: string; blank?: boolean; onToggle?: (e: ReactMouseEvent) => void }) {
  if (blank) return <span className="sw blank" />;
  if (!onToggle) {
    return (
      <span className={`sw ${on ? "on" : ""}`} role="img" aria-label={`${label}: ${on ? "on" : "off"}`} title={label}>
        {on && <Icon name={icon} size={13} />}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`sw ${on ? "on" : ""}`}
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e);
      }}
    >
      {on && <Icon name={icon} size={13} />}
    </button>
  );
}

/** A comp switch in the Timeline header: a toggle when the project is editable, else its state. */
function CompSwitchButton({ comp, name, icon, title }: { comp: CompItem; name: "draft3d" | "frameBlending" | "motionBlur"; icon: IconName; title: string }) {
  const editing = useEditing();
  const { editor } = editing;
  const on = !!comp[name];
  if (!editor) {
    return (
      <span className={`tl-tool ${on ? "on" : ""}`} title={title} aria-hidden="true">
        <Icon name={icon} size={15} />
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`tl-tool ${on ? "on" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={() => attempt(editing, () => editor.setCompSwitch(comp, name, !on))}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

/** Pixels at either end of a layer bar that trim its in or out point instead of moving it. */
const TRIM_GRIP = 5;

/**
 * Dragging a layer bar: the middle moves the layer in time, either end trims
 * its in or out point. Times snap to frames; the whole drag is one undo step.
 */
function dragLayerBar(
  e: ReactPointerEvent<HTMLSpanElement>,
  editing: ReturnType<typeof useEditing>,
  editor: Editor,
  comp: CompItem,
  layer: Layer,
  view: View,
  onSelect: (id: number) => void,
) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  onSelect(layer.id);
  const track = e.currentTarget.parentElement!.getBoundingClientRect();
  const bar = e.currentTarget.getBoundingClientRect();
  const perPixel = view.span / (track.width || 1);
  const edge = e.clientX - bar.left < TRIM_GRIP ? "in" : bar.right - e.clientX < TRIM_GRIP ? "out" : "move";
  const frame = comp.frameDuration || 1 / (comp.frameRate || 24);
  const inT = Math.min(layer.inPoint, layer.outPoint);
  const outT = Math.max(layer.inPoint, layer.outPoint);
  const key = nextDragKey(`layer-${edge}`);
  const id = layer.id;
  const x0 = e.clientX;
  const move = (ev: PointerEvent) => {
    const delta = Math.round(((ev.clientX - x0) * perPixel) / frame) * frame;
    const target = comp.layers.find((l) => l.id === id);
    if (!target) return;
    attempt(editing, () => {
      if (edge === "move") editor.shiftLayers(comp, [target], delta, { coalesce: key });
      else if (edge === "in") editor.setLayerTiming(comp, target, { inPoint: Math.min(outT - frame, inT + delta) }, { coalesce: key });
      else editor.setLayerTiming(comp, target, { outPoint: Math.max(inT + frame, outT + delta) }, { coalesce: key });
    });
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    editor.commit();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

interface LayerRowProps {
  layer: Layer;
  project: Project;
  comp: CompItem;
  open: boolean;
  selected: boolean;
  sourceMode: boolean;
  view: View;
  onToggle: (key: string) => void;
  onSelect: (id: number) => void;
  /** The layer name is an input (Enter in the Timeline); `onRename` gets the new name, or undefined to cancel. */
  renaming?: boolean;
  onRename?: (id: number, name: string | undefined) => void;
  /** Rows can be dragged to reorder the stack. */
  reorderable?: boolean;
  /** Where a dragged layer or item would land: above or below this row. */
  dropMark?: "before" | "after";
}

function RenameField({ initial, onDone }: { initial: string; onDone: (name: string | undefined) => void }) {
  const done = useRef(false);
  const finish = (name: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="tl-rename"
      aria-label="Layer name"
      autoFocus
      defaultValue={initial}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(undefined);
      }}
    />
  );
}

const LayerRow = memo(function LayerRow({
  layer,
  project,
  comp,
  open,
  selected,
  sourceMode,
  view,
  onToggle,
  onSelect,
  renaming,
  onRename,
  reorderable,
  dropMark,
}: LayerRowProps) {
  const actions = useContext(AppActionsContext);
  const editing = useEditing();
  const { editor } = editing;
  const toggle = (name: LayerSwitch, on: boolean) =>
    editor ? () => attempt(editing, () => editor.setLayerSwitch(comp, layer, name, on)) : undefined;
  const name = displayName(layer, project);
  const hasVideo = layerHasVideo(layer, project);
  const hasAudio = layerHasAudio(layer, project);
  const source = sourceItem(layer, project);
  const camLight = isCameraOrLight(layer);
  const vectorish = layer.layerType === "TextLayer" || layer.layerType === "ShapeLayer";
  const collapsible = source?.kind === "comp" || vectorish || (source?.kind === "footage" && /\.(ai|eps|pdf|svg)$/i.test(source.name));
  const footageLike = source?.kind === "comp" || (source?.kind === "footage" && source.mainSource.sourceType === "FileSource" && !source.mainSource.isStill);
  const effects = layerEffects(layer);
  const matte = layer.trackMatteType !== NO_MATTE && layer.trackMatteLayerId ? layerByIndexLabel(comp, layer.trackMatteLayerId) : undefined;
  const parent = layer.parentId ? layerByIndexLabel(comp, layer.parentId) : undefined;
  const markers = findProperty(layer.properties, "ADBE Marker")?.keyframes ?? [];
  const inT = Math.min(layer.inPoint, layer.outPoint);
  const outT = Math.max(layer.inPoint, layer.outPoint);
  const color = labelColor(layer.label);
  const shown = name.text;
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-label={shown}
      aria-expanded={open}
      aria-selected={selected}
      className={`tl-row tl-layer ${selected ? "selected" : ""} ${layer.enabled ? "" : "video-off"} ${dropMark ? `drop-${dropMark}` : ""}`}
      data-layer-id={layer.id}
      draggable={reorderable && !renaming ? true : undefined}
      onDragStart={
        reorderable
          ? (e) => {
              e.dataTransfer.setData(LAYER_MIME, String(layer.id));
              e.dataTransfer.effectAllowed = "move";
              onSelect(layer.id);
            }
          : undefined
      }
      onClick={() => onSelect(layer.id)}
      onContextMenu={(e) => {
        if (!actions) return;
        onSelect(layer.id);
        openContextMenu(e, layerMenu(project, comp, layer, actions));
      }}
    >
      <div className="tl-outline">
        <span className="c-av">
          <Switch icon="eye" on={layer.enabled} label="Video" blank={!hasVideo} onToggle={toggle("enabled", !layer.enabled)} />
          <Switch icon="speaker" on={layer.audioEnabled} label="Audio" blank={!hasAudio} onToggle={toggle("audioEnabled", !layer.audioEnabled)} />
          <Switch icon="solo" on={layer.solo} label="Solo" blank={!hasVideo && !hasAudio} onToggle={toggle("solo", !layer.solo)} />
          <Switch icon="lock" on={layer.locked} label="Lock" onToggle={toggle("locked", !layer.locked)} />
        </span>
        <span className="c-twirl">
          <button
            type="button"
            className={`twirl ${open ? "open" : ""}`}
            aria-label={`${open ? "Collapse" : "Expand"} ${shown}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(`L${layer.id}`);
            }}
          >
            <Icon name="twirl" size={10} />
          </button>
        </span>
        <span className="c-label">
          <span className="label-chip" style={{ background: color }} />
        </span>
        <span className="c-num">{layer.index}</span>
        <span className="c-name" title={layer.comment || (sourceMode ? name.text : name.source)}>
          <LayerIcon layer={layer} project={project} />
          {renaming && onRename ? (
            <RenameField initial={name.text} onDone={(next) => onRename(layer.id, next)} />
          ) : sourceMode ? (
            <span className="cell-text">{name.source}</span>
          ) : (
            <span className={`cell-text ${name.bracketed ? "bracketed" : ""}`}>{name.text}</span>
          )}
        </span>
        <span className="c-switches">
          <Switch icon={layer.shy ? "shyOn" : "shy"} on label="Shy" onToggle={toggle("shy", !layer.shy)} />
          <Switch
            icon="collapse"
            on={layer.collapseTransformation}
            label="Collapse Transformations"
            blank={!collapsible}
            onToggle={toggle("collapseTransformation", !layer.collapseTransformation)}
          />
          <Switch
            icon={QUALITY_ICON[layer.quality] ?? "qualityBest"}
            on
            label="Quality"
            blank={camLight || layer.nullLayer}
            onToggle={
              editor
                ? (e) => {
                    // Click alternates Best and Draft; Alt-click picks Wireframe, as in AE.
                    const next = e.altKey ? QUALITY.WIREFRAME : layer.quality === QUALITY.BEST ? QUALITY.DRAFT : QUALITY.BEST;
                    attempt(editing, () => editor.setLayerQuality(comp, layer, next));
                  }
                : undefined
            }
          />
          <Switch icon="fx" on={layer.effectsActive} label="Effect" blank={effects.length === 0} onToggle={toggle("effectsActive", !layer.effectsActive)} />
          <Switch icon="frameBlend" on={layer.frameBlendingType !== FRAME_BLEND_NONE} label="Frame Blending" blank={!footageLike} />
          <Switch icon="motionBlur" on={layer.motionBlur} label="Motion Blur" blank={camLight} onToggle={toggle("motionBlur", !layer.motionBlur)} />
          <Switch icon="adjustment" on={layer.adjustmentLayer} label="Adjustment Layer" blank={camLight} onToggle={toggle("adjustmentLayer", !layer.adjustmentLayer)} />
          <Switch icon="cube" on={layer.threeDLayer} label="3D Layer" blank={camLight} onToggle={toggle("threeDLayer", !layer.threeDLayer)} />
        </span>
        <span className="c-mode">
          {!camLight && (
            <Dropdown text={blendingModeName(layer.blendingMode)} label="Mode" menu={editor ? () => modeEntries(editing, editor, comp, layer) : undefined} />
          )}
        </span>
        <span className="c-t">
          {!camLight && (
            <Checkbox
              on={layer.preserveTransparency}
              label="Preserve Underlying Transparency"
              onToggle={toggle("preserveTransparency", !layer.preserveTransparency)}
            />
          )}
        </span>
        <span className="c-trkmat">
          {!camLight && (
            <>
              <Icon name="pickwhip" size={12} className="dim" />
              <Dropdown text={matte ?? "No Matte"} label="Track Matte" menu={editor ? () => trackMatteEntries(editing, editor, comp, layer) : undefined} />
            </>
          )}
        </span>
        <span className="c-parent">
          <Icon name="pickwhip" size={12} className="dim" />
          <Dropdown text={parent ?? "None"} label="Parent & Link" menu={editor ? () => parentEntries(editing, editor, comp, layer) : undefined} />
        </span>
      </div>
      <div className="tl-track">
        <span
          className={`tl-bar ${editor && !layer.locked ? "draggable" : ""}`}
          style={{ left: pct(inT, view), width: `${((outT - inT) / view.span) * 100}%`, "--c": color } as CSSProperties}
          title={`${shown}: ${timecode(inT + comp.displayStartTime, comp.frameRate)} – ${timecode(outT + comp.displayStartTime, comp.frameRate)}`}
          onPointerDown={editor && !layer.locked ? (e) => dragLayerBar(e, editing, editor, comp, layer, view, onSelect) : undefined}
        />
        {markers.map((m, i) => (
          <span key={i} className="tl-marker" style={{ left: pct(m.time, view) }} title={`Layer marker at ${timecode(m.time + comp.displayStartTime, comp.frameRate)}`} />
        ))}
      </div>
    </div>
  );
});

interface NodeRowProps {
  row: Extract<Row, { kind: "node" }>;
  project: Project;
  comp: CompItem;
  open: boolean;
  time: number;
  view: View;
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onSelect: (id: number) => void;
  onTime: (t: number) => void;
  onSelectKey: (key: string, add: boolean) => void;
}

function KeyframeNav({ prop, layer, time, comp, onTime }: { prop: Property; layer: Layer; time: number; comp: CompItem; onTime: (t: number) => void }) {
  const editing = useEditing();
  const { editor } = editing;
  const eps = (comp.frameDuration || 1 / 24) / 2;
  const prev = [...prop.keyframes].reverse().find((k) => k.time < time - eps);
  const next = prop.keyframes.find((k) => k.time > time + eps);
  const index = keyframeAt(prop, time, eps);
  const at = index >= 0;
  const label = at ? "Remove keyframe at current time" : "Add keyframe at current time";
  return (
    <span className="kf-nav">
      <button type="button" className="kf-nav-btn" aria-label="Go to previous keyframe" disabled={!prev} onClick={(e) => (e.stopPropagation(), prev && onTime(prev.time))}>
        <Icon name="kfPrev" size={10} />
      </button>
      {editor ? (
        <button
          type="button"
          className={`kf-nav-here ${at ? "on" : ""}`}
          aria-label={label}
          title={label}
          onClick={(e) => {
            e.stopPropagation();
            attempt(editing, () => (at ? editor.removeKeyframes(comp, layer, prop, [index]) : editor.addKeyframe(comp, layer, prop, time)));
          }}
        >
          <Icon name="kfDiamond" size={10} />
        </button>
      ) : (
        <span className={`kf-nav-here ${at ? "on" : ""}`} role="img" aria-label={at ? "Keyframe at current time" : "No keyframe at current time"}>
          <Icon name="kfDiamond" size={10} />
        </span>
      )}
      <button type="button" className="kf-nav-btn" aria-label="Go to next keyframe" disabled={!next} onClick={(e) => (e.stopPropagation(), next && onTime(next.time))}>
        <Icon name="kfNext" size={10} />
      </button>
    </span>
  );
}

function GroupExtras({ node, onReset }: { node: DisplayNode; onReset?: () => void }) {
  if (node.kind !== "group") return null;
  switch (node.role) {
    case "transform":
      return onReset ? (
        <button
          type="button"
          className="hot-link"
          onClick={(e) => {
            e.stopPropagation();
            onReset();
          }}
        >
          Reset
        </button>
      ) : (
        <span className="hot-link">Reset</span>
      );
    case "effect":
      return <span className="hot-link">Reset</span>;
    case "contents":
      return (
        <span className="tl-add">
          Add: <Icon name="plus" size={12} />
        </span>
      );
    case "text":
      return (
        <span className="tl-add">
          Animate: <Icon name="plus" size={12} />
        </span>
      );
    case "mask": {
      const mask = node.group.mask;
      if (!mask) return null;
      return (
        <span className="tl-mask-extras">
          <Dropdown text={maskModeName(mask.maskMode)} label="Mask Mode" width={78} />
          <Checkbox on={mask.inverted} label="Inverted" />
          <span className="dim">Inverted</span>
        </span>
      );
    }
    default:
      return null;
  }
}

function NodeRow({ row, project, comp, open, time, view, selectedKeys, onToggle, onSelect, onTime, onSelectKey }: NodeRowProps) {
  const { node, layer, depth, key } = row;
  const ctx = { project, layer, comp };
  const isProp = node.kind === "property";
  const prop = isProp ? node.prop : undefined;
  const animated = !!prop && isAnimated(prop);
  const value = prop ? valueAt(prop, time, layer) : null;
  const indent = { paddingLeft: depth * 14 - 8 };
  const editing = useEditing();
  const editor = editing.editor;
  const transformValue = !!editor && !!prop && isTransformValue(prop.matchName) && transformProp(layer, prop.matchName) === prop;
  const onReset =
    editor && node.kind === "group" && node.role === "transform" ? () => attempt(editing, () => resetTransform(editor, comp, [layer], time)) : undefined;
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-label={node.name}
      aria-expanded={isProp ? undefined : open}
      className={`tl-row tl-prop ${node.kind === "group" ? `role-${node.role}` : ""} ${node.kind === "group" && !node.group.enabled ? "disabled" : ""}`}
      data-owner-id={layer.id}
      onClick={() => onSelect(layer.id)}
    >
      <div className="tl-outline">
        <span className="c-av">{prop && animated && <KeyframeNav prop={prop} layer={layer} time={time} comp={comp} onTime={onTime} />}</span>
        <span className="c-prop-name" style={indent}>
          {isProp ? (
            <span className="twirl-space" />
          ) : (
            <button
              type="button"
              className={`twirl ${open ? "open" : ""}`}
              aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(key);
              }}
            >
              <Icon name="twirl" size={10} />
            </button>
          )}
          {node.kind === "group" && node.role === "effect" && (
            <span className={`fx-switch ${node.group.enabled ? "on" : ""}`} role="img" aria-label={node.group.enabled ? "Effect on" : "Effect off"}>
              <Icon name="fx" size={12} />
            </span>
          )}
          {node.kind === "group" && node.role === "mask" && node.group.mask && (
            <span className="mask-chip" style={{ background: colorCss(node.group.mask.color) }} />
          )}
          {prop &&
            (prop.canVaryOverTime && transformValue && editor ? (
              <button
                type="button"
                className={`stopwatch ${animated ? "on" : ""}`}
                title="Time-Vary Stopwatch"
                aria-label={animated ? "Stopwatch on (animated)" : "Stopwatch off"}
                aria-pressed={animated}
                onClick={(e) => {
                  e.stopPropagation();
                  attempt(editing, () => toggleTransformStopwatch(editor, comp, layer, prop.matchName, time));
                }}
              >
                <Icon name="stopwatch" size={13} />
              </button>
            ) : prop.canVaryOverTime ? (
              <span
                className={`stopwatch ${animated ? "on" : ""}`}
                role="img"
                title="Time-Vary Stopwatch"
                aria-label={animated ? "Stopwatch on (animated)" : "Stopwatch off"}
              >
                <Icon name="stopwatch" size={13} />
              </span>
            ) : (
              <span className="stopwatch-space" />
            ))}
          <span className="cell-text">{node.name}</span>
        </span>
        <span className="c-prop-value">
          {prop && transformValue ? (
            <TransformValue comp={comp} layer={layer} prop={prop} value={value} time={time} />
          ) : prop ? (
            <PropertyValueView prop={prop} value={value} ctx={ctx} place="timeline" />
          ) : (
            <GroupExtras node={node} onReset={onReset} />
          )}
        </span>
      </div>
      <div className="tl-track">
        {prop &&
          animated &&
          prop.keyframes.map((k, i) => {
            const kfKey = `${key}@${i}`;
            const tc = timecode(k.time + comp.displayStartTime, comp.frameRate);
            return (
              <button
                key={i}
                type="button"
                className={`tl-kf ${selectedKeys.has(kfKey) ? "selected" : ""}`}
                style={{ left: pct(k.time, view) }}
                aria-label={`${node.name} keyframe at ${tc}: ${interpolationName(k.inInterpolationType)} in, ${interpolationName(k.outInterpolationType)} out`}
                title={`${tc} · ${interpolationName(k.inInterpolationType)} in, ${interpolationName(k.outInterpolationType)} out`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectKey(kfKey, e.shiftKey);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onTime(k.time);
                }}
              >
                <KeyframeGlyph inType={k.inInterpolationType} outType={k.outInterpolationType} autoBezier={k.temporalAutoBezier} />
              </button>
            );
          })}
      </div>
    </div>
  );
}

function ExpressionRow({ row }: { row: Extract<Row, { kind: "expr" }> }) {
  const { prop, depth } = row;
  return (
    <div role="treeitem" aria-level={depth + 1} aria-label={`Expression: ${prop.name}`} className="tl-row tl-expr-row">
      <div className="tl-outline">
        <span className="c-av" />
        <span className="c-prop-name" style={{ paddingLeft: depth * 14 - 8 }}>
          <span className="twirl-space" />
          <span className={`expr-label ${prop.expressionEnabled ? "" : "off"}`}>Expression: {prop.name}</span>
        </span>
        <span className="c-prop-value expr-tools" aria-hidden="true">
          <span className={`expr-eq ${prop.expressionEnabled ? "on" : ""}`}>{prop.expressionEnabled ? "=" : "≠"}</span>
          <Icon name="graphEditor" size={12} />
          <Icon name="pickwhip" size={12} />
          <Icon name="overflow" size={12} />
        </span>
      </div>
      <div className="tl-track tl-expr-track">
        <pre className="tl-expr" title={prop.expression}>
          {prop.expression}
        </pre>
      </div>
    </div>
  );
}

/* ---------- panel ---------- */

function collectReveal(project: Project, layer: Layer, q: string, budget: { left: number }): Set<string> | undefined {
  const reveal = new Set<string>();
  const ctx = { project, layer };
  let found = false;
  const walk = (nodes: DisplayNode[], parentKey: string, chain: string[]) => {
    for (const node of nodes) {
      if (--budget.left < 0) return;
      const key = `${parentKey}/${node.key}`;
      if (node.name.toLowerCase().includes(q)) {
        found = true;
        for (const k of chain) reveal.add(k);
      }
      if (node.kind !== "property") walk(outlineChildren(node, ctx), key, [...chain, key]);
    }
  };
  walk(layerOutline(ctx), `L${layer.id}`, [`L${layer.id}`]);
  return found ? reveal : undefined;
}

/** The Timeline for one composition: layer outline with switches and twirl-downs, ruler, layer bars, keyframes and CTI. */
export const TimelinePanel = memo(function TimelinePanel({
  project,
  comp,
  time,
  selectedLayerId,
  onTime,
  onSelectLayer,
}: {
  project: Project;
  comp: CompItem;
  time: number;
  selectedLayerId: number | undefined;
  onTime: (compId: number, t: number) => void;
  onSelectLayer: (compId: number, layerId: number | undefined) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [hideShy, setHideShy] = useState(comp.hideShyLayers);
  const [sourceMode, setSourceMode] = useState(false);
  const [showModes, setShowModes] = useState(true);
  const [switchesPane, setSwitchesPane] = useState(true);
  const [transferPane, setTransferPane] = useState(true);
  const transferShown = showModes && transferPane;
  // The outline is one grid; hidden panes drop their columns so the rest stay aligned.
  const columns = [
    "72px 16px 18px 26px minmax(110px, 1fr)",
    switchesPane ? "144px" : "",
    transferShown ? "78px 20px 108px" : "",
    "128px",
  ]
    .filter(Boolean)
    .join(" ");
  const [zoom, setZoom] = useState(0);
  const [viewStart, setViewStart] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [outlineWidth, setOutlineWidth] = useState(720);
  const [rulerWidth, setRulerWidth] = useState(600);
  const rulerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const editing = useEditing();
  const { editor, revision } = editing;
  const [renaming, setRenaming] = useState<number>();
  const [dropSlot, setDropSlot] = useState<number>();

  const duration = Math.max(comp.duration, comp.frameDuration || 1 / 24);
  const minSpan = Math.min(duration, (comp.frameDuration || 1 / 24) * 10);
  const span = duration * Math.pow(minSpan / duration, zoom / 100);
  const view: View = useMemo(() => ({ start: Math.min(Math.max(0, viewStart), duration - span), span }), [viewStart, duration, span]);

  useEffect(() => {
    const el = rulerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => entry && setRulerWidth(entry.contentRect.width || 600));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const setTime = useCallback((t: number) => onTime(comp.id, t), [onTime, comp.id]);
  const select = useCallback((id: number) => onSelectLayer(comp.id, id), [onSelectLayer, comp.id]);
  const toggle = useCallback(
    (key: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const selectKey = useCallback(
    (key: string, add: boolean) =>
      setSelectedKeys((prev) => {
        const next = new Set(add ? prev : []);
        next.add(key);
        return next;
      }),
    [],
  );

  const search = useMemo(() => {
    if (!deferredQuery) return undefined;
    const budget = { left: SEARCH_NODE_BUDGET };
    const layers = new Map<number, Set<string>>();
    for (const layer of comp.layers) {
      const reveal = collectReveal(project, layer, deferredQuery, budget);
      const nameHit = displayName(layer, project).text.toLowerCase().includes(deferredQuery);
      if (reveal || nameHit) layers.set(layer.id, reveal ?? new Set());
    }
    return layers;
  }, [deferredQuery, comp, project, revision]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const layer of comp.layers) {
      if (hideShy && layer.shy) continue;
      const reveal = search?.get(layer.id);
      if (search && !reveal) continue;
      const isOpen = (key: string) => expanded.has(key) || !!reveal?.has(key);
      const layerKey = `L${layer.id}`;
      out.push({ kind: "layer", key: layerKey, layer });
      if (!isOpen(layerKey)) continue;
      const ctx = { project, layer };
      const walk = (nodes: DisplayNode[], depth: number, parentKey: string) => {
        for (const node of nodes) {
          const key = `${parentKey}/${node.key}`;
          out.push({ kind: "node", key, layer, node, depth });
          if (node.kind === "property") {
            if (node.prop.expression) out.push({ kind: "expr", key: `${key}#expr`, layer, prop: node.prop, depth: depth + 1 });
          } else if (isOpen(key)) {
            walk(outlineChildren(node, ctx), depth + 1, key);
          }
        }
      };
      walk(layerOutline(ctx), 1, layerKey);
    }
    return out;
    // `revision`: edits rebuild the layers inside the same comp object.
  }, [comp, project, expanded, hideShy, search, revision]);

  const openKeys = useMemo(() => {
    const keys = new Set(expanded);
    for (const reveal of search?.values() ?? []) for (const k of reveal) keys.add(k);
    return keys;
  }, [expanded, search]);

  const timeFromX = (clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return time;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return view.start + ratio * view.span;
  };

  const onRulerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    rulerRef.current?.focus();
    setTime(timeFromX(e.clientX));
    const move = (ev: PointerEvent | MouseEvent) => setTime(timeFromX(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const frame = comp.frameDuration || 1 / 24;
  const onRulerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, PageDown: 1, PageUp: -1 };
    if (e.key in steps) {
      e.preventDefault();
      setTime(time + (steps[e.key] ?? 0) * frame * (e.shiftKey ? 10 : 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setTime(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setTime(duration - frame);
    }
  };

  const rename = useCallback(
    (id: number, name: string | undefined) => {
      setRenaming(undefined);
      rootRef.current?.querySelector<HTMLElement>(".tl-body")?.focus();
      const layer = comp.layers.find((l) => l.id === id);
      if (!editor || !layer || name === undefined || name === layer.name) return;
      attempt(editing, () => editor.renameLayer(comp, layer, name.trim()));
    },
    [comp, editor, editing],
  );

  /** The 1-based stack position a drop at this row lands on: above the row's layer or, in its lower half or its properties, below. */
  const slotAt = (e: DragEvent<HTMLDivElement>): number | undefined => {
    const target = e.target instanceof Element ? e.target : null;
    const row = target?.closest<HTMLElement>("[data-layer-id], [data-owner-id]");
    if (!row) return comp.layers.length + 1;
    const owner = Number(row.dataset.layerId ?? row.dataset.ownerId);
    const index = comp.layers.findIndex((l) => l.id === owner) + 1;
    if (!index) return undefined;
    if (row.dataset.ownerId) return index + 1;
    const rect = row.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? index : index + 1;
  };
  const dragKind = (e: DragEvent) => {
    const types = Array.from(e.dataTransfer?.types ?? []);
    return !editor ? undefined : types.includes(LAYER_MIME) ? "layer" : types.includes(ITEM_MIME) ? "item" : undefined;
  };
  const onBodyDragOver = (e: DragEvent<HTMLDivElement>) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = kind === "layer" ? "move" : "copy";
    setDropSlot(slotAt(e));
  };
  const onBodyDrop = (e: DragEvent<HTMLDivElement>) => {
    const kind = dragKind(e);
    const slot = slotAt(e);
    setDropSlot(undefined);
    if (!kind || !editor || slot === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (kind === "layer") {
      const layer = comp.layers.find((l) => l.id === Number(e.dataTransfer.getData(LAYER_MIME)));
      if (!layer) return;
      const to = slot > layer.index ? slot - 1 : slot;
      if (to !== layer.index) attempt(editing, () => editor.moveLayer(comp, layer, to));
      return;
    }
    const itemId = Number(e.dataTransfer.getData(ITEM_MIME));
    const track = e.target instanceof Element ? e.target.closest(".tl-track")?.getBoundingClientRect() : undefined;
    const startTime =
      track && track.width > 0
        ? Math.max(0, Math.round((view.start + ((e.clientX - track.left) / track.width) * view.span) / frame) * frame)
        : undefined;
    attempt(editing, () => {
      let id = 0;
      editor.perform("Add Layer", [comp], () => {
        id = addLayer(editor, comp, { kind: "item", itemId }, { above: comp.layers[slot - 1], startTime });
        const added = comp.layers.find((l) => l.id === id);
        if (added && slot > comp.layers.length - 1) editor.moveLayer(comp, added, comp.layers.length);
      });
      select(id);
    });
  };

  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && editor && selectedLayerId !== undefined && comp.layers.some((l) => l.id === selectedLayerId)) {
      e.preventDefault();
      setRenaming(selectedLayerId);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const visible = comp.layers.filter((l) => !(hideShy && l.shy) && (!search || search.has(l.id)));
    const index = visible.findIndex((l) => l.id === selectedLayerId);
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) select(next.id);
  };

  const onZoom = (value: number) => {
    const nextSpan = duration * Math.pow(minSpan / duration, value / 100);
    setZoom(value);
    setViewStart(Math.min(Math.max(0, time - nextSpan / 2), duration - nextSpan));
  };

  const onSplitDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = outlineWidth;
    const max = (rootRef.current?.clientWidth ?? 1600) - 160;
    const move = (ev: PointerEvent | MouseEvent) => setOutlineWidth(Math.min(max, Math.max(360, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const tc = timecode(time + comp.displayStartTime, comp.frameRate);
  const ctiLeft = pct(time, view);
  const workStart = comp.workAreaStart;
  const workEnd = Math.min(duration, comp.workAreaStart + comp.workAreaDuration);

  return (
    <div
      ref={rootRef}
      className={`tl ${transferShown ? "" : "modes-off"} ${switchesPane ? "" : "no-switches"}`}
      style={{ "--outline-w": `${outlineWidth}px`, "--cols": columns } as CSSProperties}
    >
      <div className="tl-head">
        <div className="tl-head-left">
          <div className="tl-controls">
            <div className="tl-time">
              <TimeDisplay comp={comp} time={time} onTime={setTime} />
              <span className="tl-frames">
                {frameLabel(time + comp.displayStartTime, comp.frameRate)} ({fpsLabel(comp.frameRate)} fps)
              </span>
            </div>
            <label className="search-field tl-search">
              <Icon name="search" size={12} />
              <input type="search" aria-label="Search timeline" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <span className="tl-tools">
              <span className="tl-tool" title="Composition Mini-Flowchart" aria-hidden="true">
                <Icon name="miniFlow" size={15} />
              </span>
              <CompSwitchButton comp={comp} name="draft3d" icon="draft3d" title="Draft 3D" />
              <button
                type="button"
                className={`tl-tool ${hideShy ? "on" : ""}`}
                title="Hide all layers for which the Shy switch is set"
                aria-label="Hide shy layers"
                aria-pressed={hideShy}
                onClick={() => {
                  setHideShy(!hideShy);
                  // AE keeps this switch in the composition.
                  if (editor) attempt(editing, () => editor.setCompSwitch(comp, "hideShyLayers", !hideShy));
                }}
              >
                <Icon name="shyOn" size={15} />
              </button>
              <CompSwitchButton comp={comp} name="frameBlending" icon="frameBlend" title="Enables Frame Blending for all layers with the Frame Blend switch set" />
              <CompSwitchButton comp={comp} name="motionBlur" icon="motionBlur" title="Enables Motion Blur for all layers with the Motion Blur switch set" />
              <span className="tl-tool" title="Graph Editor" aria-hidden="true">
                <Icon name="graphEditor" size={15} />
              </span>
            </span>
          </div>
          <div className="tl-colhead tl-outline" role="presentation">
            <span className="c-av">
              <Icon name="eye" size={12} label="Video" />
              <Icon name="speaker" size={12} label="Audio" />
              <Icon name="solo" size={12} label="Solo" />
              <Icon name="lock" size={12} label="Lock" />
            </span>
            <span className="c-twirl" />
            <span className="c-label">
              <Icon name="tag" size={12} label="Label" />
            </span>
            <span className="c-num">#</span>
            <button type="button" className="c-name col-toggle" onClick={() => setSourceMode(!sourceMode)} title="Click to toggle Layer Name / Source Name">
              {sourceMode ? "Source Name" : "Layer Name"}
            </button>
            <span className="c-switches">
              {(["shyOn", "collapse", "qualityBest", "fx", "frameBlend", "motionBlur", "adjustment", "cube"] as const).map((icon) => (
                <span key={icon} className="sw">
                  <Icon name={icon} size={12} />
                </span>
              ))}
            </span>
            <span className="c-mode">Mode</span>
            <span className="c-t">T</span>
            <span className="c-trkmat">TrkMat</span>
            <span className="c-parent">Parent &amp; Link</span>
          </div>
        </div>
        <div className="tl-head-right">
          <div className="tl-nav" aria-hidden="true">
            <span className="tl-nav-range" style={{ left: `${(view.start / duration) * 100}%`, width: `${(view.span / duration) * 100}%` }} />
          </div>
          <div
            ref={rulerRef}
            className="tl-ruler"
            role="slider"
            tabIndex={0}
            aria-label="Current time"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={time}
            aria-valuetext={tc}
            onPointerDown={onRulerDown}
            onKeyDown={onRulerKey}
          >
            <div className="tl-workarea-lane">
              <span className="tl-workarea" style={{ left: pct(workStart, view), width: `${((workEnd - workStart) / view.span) * 100}%` }} title="Work Area" />
            </div>
            <Ruler comp={comp} view={view} width={rulerWidth} />
            <span className="tl-cti-head" style={{ left: ctiLeft }} aria-hidden="true">
              <svg width="11" height="12" viewBox="0 0 11 12">
                <path d="M.5.5h10v6.5L5.5 11.5.5 7z" />
              </svg>
            </span>
          </div>
        </div>
      </div>
      <div className="tl-body-wrap">
        <div
          className="tl-body"
          role="tree"
          aria-label="Timeline layers"
          tabIndex={0}
          onKeyDown={onTreeKey}
          onDragOver={onBodyDragOver}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropSlot(undefined);
          }}
          onDrop={onBodyDrop}
          onDragEnd={() => setDropSlot(undefined)}
        >
          {comp.layers.length === 0 && <p className="panel-empty">This composition has no layers.</p>}
          {rows.map((row) =>
            row.kind === "layer" ? (
              <LayerRow
                key={row.key}
                layer={row.layer}
                project={project}
                comp={comp}
                open={openKeys.has(row.key)}
                selected={row.layer.id === selectedLayerId}
                sourceMode={sourceMode}
                view={view}
                onToggle={toggle}
                onSelect={select}
                renaming={renaming === row.layer.id}
                onRename={rename}
                reorderable={!!editor}
                dropMark={
                  dropSlot === row.layer.index
                    ? "before"
                    : dropSlot === row.layer.index + 1 && row.layer.index === comp.layers.length
                      ? "after"
                      : undefined
                }
              />
            ) : row.kind === "node" ? (
              <NodeRow
                key={row.key}
                row={row}
                project={project}
                comp={comp}
                open={openKeys.has(row.key)}
                time={time}
                view={view}
                selectedKeys={selectedKeys}
                onToggle={toggle}
                onSelect={select}
                onTime={setTime}
                onSelectKey={selectKey}
              />
            ) : (
              <ExpressionRow key={row.key} row={row} />
            ),
          )}
        </div>
        <div className="tl-cti-layer" aria-hidden="true">
          <span className="tl-cti-line" style={{ left: ctiLeft }} />
        </div>
      </div>
      <div className="tl-split" onPointerDown={onSplitDown} role="separator" aria-orientation="vertical" aria-label="Resize layer outline" />
      <div className="tl-foot">
        <div className="tl-foot-left">
          <button
            type="button"
            className={`tl-tool ${switchesPane ? "on" : ""}`}
            title="Layer switches pane"
            aria-label="Layer switches pane"
            aria-pressed={switchesPane}
            onClick={() => setSwitchesPane(!switchesPane)}
          >
            <Icon name="overflow" size={13} />
          </button>
          <button
            type="button"
            className={`tl-tool ${transferPane ? "on" : ""}`}
            title="Transfer Controls pane"
            aria-label="Transfer Controls pane"
            aria-pressed={transferPane}
            onClick={() => setTransferPane(!transferPane)}
          >
            <Icon name="channels" size={13} />
          </button>
          <span className="tl-tool" title="In/Out/Duration/Stretch panes" aria-hidden="true">
            <Icon name="first" size={13} />
          </span>
          <span className="tl-foot-text">Frame Render Time 0ms</span>
          <button type="button" className="tl-foot-toggle" onClick={() => setShowModes(!showModes)}>
            Toggle Switches / Modes
          </button>
        </div>
        <div className="tl-foot-right">
          <Icon name="mountainSmall" size={13} className="dim" />
          <input
            type="range"
            className="tl-zoom"
            min={0}
            max={100}
            value={zoom}
            aria-label="Zoom timeline"
            onChange={(e) => onZoom(Number(e.target.value))}
          />
          <Icon name="mountainLarge" size={13} className="dim" />
        </div>
      </div>
    </div>
  );
});
