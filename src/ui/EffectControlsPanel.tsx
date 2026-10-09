import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { openContextMenu } from "./ContextMenu.tsx";
import { deleteEffect, effectMenu, toggleEffect } from "./effectCommands.ts";
import { canHaveExpression, propertyMenu, toggleExpression } from "./expressionCommands.ts";
import { applySoundKeys } from "../media/soundKeysApply.ts";
import { SOUND_KEYS, SOUND_KEYS_COMMANDS } from "../media/soundKeys.ts";
import { EffectControlType, type CompItem, type Layer, type Project, type Property, type PropertyGroup } from "../aep/model.ts";
import { shownValue } from "./animate.ts";
import { fixed } from "./format.ts";
import { Icon } from "./icons.tsx";
import {
  isAnimated,
  isPluginEffect,
  layerEffects,
  outlineChildren,
  paramDef,
  type DisplayNode,
  type OutlineContext,
} from "./properties.ts";
import { PropertyValueView, type ValueContext } from "./values.tsx";
import { hasNumericValue } from "../edit/editor.ts";
import { setPropertyValue, toggleStopwatch } from "../edit/stored-property.ts";
import { attempt, nextDragKey, useEditing } from "./editing.tsx";
import { canEditEffectValue, EffectValue } from "./EffectValue.tsx";

/** Drags of a slider or dial: `onChange` per move with one coalesce key, `onEnd` when released. */
type DragHandlers = { onChange?: (value: number, coalesce: string) => void; onEnd?: () => void };

function drag(e: ReactPointerEvent, read: (ev: PointerEvent | ReactPointerEvent) => number, { onChange, onEnd }: DragHandlers) {
  if (!onChange || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const key = nextDragKey("slider");
  onChange(read(e), key);
  const move = (ev: PointerEvent) => onChange(read(ev), key);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    onEnd?.();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function SliderTrack({ value, min, max, label, integer, ...handlers }: { value: number; min: number; max: number; label: string; integer?: boolean } & DragHandlers) {
  const t = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  const track = useRef<HTMLSpanElement>(null);
  const read = (ev: PointerEvent | ReactPointerEvent) => {
    const box = track.current!.getBoundingClientRect();
    const v = min + Math.min(1, Math.max(0, (ev.clientX - box.left) / Math.max(1, box.width))) * (max - min);
    return integer ? Math.round(v) : v;
  };
  return (
    <span className="ec-slider">
      <span
        ref={track}
        className={`ec-slider-track ${handlers.onChange ? "live" : ""}`}
        role="slider"
        aria-label={`${label} slider`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={(e) => drag(e, read, handlers)}
      >
        <span className="ec-slider-thumb" style={{ left: `${t * 100}%` }} />
      </span>
      <span className="ec-slider-labels">
        <span>{fixed(min, Number.isInteger(min) ? 1 : 2)}</span>
        <span>{fixed(max, Number.isInteger(max) ? 1 : 2)}</span>
      </span>
    </span>
  );
}

function AngleDial({ degrees, label, ...handlers }: { degrees: number; label: string } & DragHandlers) {
  const r = (degrees * Math.PI) / 180;
  const dial = useRef<SVGSVGElement>(null);
  // The pointer's direction from the hub sets the angle within the current revolution (0° up, clockwise).
  const read = (ev: PointerEvent | ReactPointerEvent) => {
    const box = dial.current!.getBoundingClientRect();
    const a = (Math.atan2(ev.clientX - (box.left + box.width / 2), -(ev.clientY - (box.top + box.height / 2))) * 180) / Math.PI;
    const turns = Math.trunc(degrees / 360);
    return turns * 360 + Math.round(a < 0 ? a + 360 : a);
  };
  return (
    <svg
      ref={dial}
      className={`ec-dial ${handlers.onChange ? "live" : ""}`}
      width="44"
      height="44"
      viewBox="-22 -22 44 44"
      role="slider"
      aria-label={`${label} dial`}
      aria-valuenow={degrees}
      onPointerDown={(e) => drag(e, read, handlers)}
    >
      <circle r="18" />
      <line x1="0" y1="0" x2={Math.sin(r) * 18} y2={-Math.cos(r) * 18} />
      <circle r="2" className="ec-dial-hub" />
    </svg>
  );
}

interface RowProps {
  node: DisplayNode;
  depth: number;
  effect: PropertyGroup;
  ctx: OutlineContext & ValueContext;
  time: number;
  expanded: Set<string>;
  toggle: (key: string) => void;
  path: string;
}

function sliderRange(prop: Property, effect: PropertyGroup, ctx: RowProps["ctx"]): [number, number] | undefined {
  if (prop.controlType !== EffectControlType.SCALAR && prop.controlType !== EffectControlType.FLOAT_SLIDER) return undefined;
  const def = paramDef(ctx.project, effect.matchName, prop.matchName);
  const min = def?.sliderMin ?? prop.min;
  const max = def?.sliderMax ?? prop.max;
  return min !== undefined && max !== undefined && max > min ? [min, max] : undefined;
}

function ParamRow({ node, depth, effect, ctx, time, expanded, toggle, path }: RowProps) {
  const editing = useEditing();
  const { editor } = editing;
  const key = `${path}/${node.key}`;
  const open = expanded.has(key);
  const indent = { paddingLeft: 8 + depth * 14 };
  if (node.kind !== "property") {
    const children = outlineChildren(node, ctx, "effect-controls");
    return (
      <div role="treeitem" aria-level={depth + 2} aria-expanded={open} className="ec-item">
        <div className="ec-row" onClick={() => toggle(key)}>
          <span className="ec-name" style={indent}>
            <span className={`twirl ${open ? "open" : ""}`} aria-hidden="true">
              <Icon name="twirl" size={10} />
            </span>
            <span className="cell-text">{node.name}</span>
          </span>
          <span className="ec-value" />
        </div>
        {open && (
          <div role="group">
            {children.map((child) => (
              <ParamRow key={child.key} {...{ node: child, depth: depth + 1, effect, ctx, time, expanded, toggle, path: key }} />
            ))}
          </div>
        )}
      </div>
    );
  }
  const { prop } = node;
  if (effect.matchName === SOUND_KEYS && prop.matchName === SOUND_KEYS_COMMANDS) {
    return <SoundKeysCommands effect={effect} ctx={ctx} indent={indent} depth={depth} />;
  }
  const value = shownValue(ctx.project, prop, time, ctx.layer);
  const range = typeof value === "number" ? sliderRange(prop, effect, ctx) : undefined;
  const angle = prop.controlType === EffectControlType.ANGLE && typeof value === "number";
  const twirls = !!range || angle;
  const button = prop.controlType === EffectControlType.BUTTON;
  const editable = !!editor && canEditEffectValue(editor, ctx.layer, prop, value);
  const live: DragHandlers =
    editor && editable
      ? {
          onChange: (v, key) => attempt(editing, () => setPropertyValue(editor, ctx.comp, ctx.layer, prop, v, time, { coalesce: key })),
          onEnd: () => editor.commit(),
        }
      : {};
  const expression = !!prop.expression;
  return (
    <div role="treeitem" aria-level={depth + 2} aria-expanded={twirls ? open : undefined} className="ec-item">
      <div className="ec-row" onClick={twirls ? () => toggle(key) : undefined}>
        <span className="ec-name" style={indent}>
          {twirls ? (
            <span className={`twirl ${open ? "open" : ""}`} aria-hidden="true">
              <Icon name="twirl" size={10} />
            </span>
          ) : (
            <span className="twirl-space" />
          )}
          {prop.canVaryOverTime && editor && (editable || canHaveExpression(editing, ctx.layer, prop)) ? (
            <button
              type="button"
              className={`stopwatch ${isAnimated(prop) ? "on" : ""}`}
              aria-label={`${isAnimated(prop) ? "Remove" : "Enable"} keyframing for ${node.name}`}
              aria-pressed={isAnimated(prop)}
              title="Time-Vary Stopwatch (Alt+click: add or remove an expression)"
              onClick={(e) => {
                e.stopPropagation();
                if (e.altKey) toggleExpression(editing, ctx.comp, ctx.layer, prop);
                else if (editable && hasNumericValue(prop)) attempt(editing, () => toggleStopwatch(editor, ctx.comp, ctx.layer, prop, time));
              }}
              onContextMenu={(e) => openContextMenu(e, propertyMenu(editing, ctx.comp, ctx.layer, prop, time))}
            >
              <Icon name="stopwatch" size={13} />
            </button>
          ) : prop.canVaryOverTime ? (
            <span className={`stopwatch ${isAnimated(prop) ? "on" : ""}`} aria-hidden="true">
              <Icon name="stopwatch" size={13} />
            </span>
          ) : (
            <span className="stopwatch-space" />
          )}
          {!button && (
            <span
              className="cell-text"
              onContextMenu={editor && canHaveExpression(editing, ctx.layer, prop) ? (e) => openContextMenu(e, propertyMenu(editing, ctx.comp, ctx.layer, prop, time)) : undefined}
            >
              {node.name}
            </span>
          )}
        </span>
        <span className={`ec-value ${expression && prop.expressionEnabled ? "has-expression" : ""}`} onClick={(e) => e.stopPropagation()}>
          {editor && editable ? (
            <EffectValue comp={ctx.comp} layer={ctx.layer} prop={prop} value={value} time={time} />
          ) : (
            <PropertyValueView prop={prop} value={value} ctx={ctx} place="effect-controls" />
          )}
        </span>
      </div>
      {open && range && typeof value === "number" && (
        <div className="ec-row ec-extra">
          <span />
          <SliderTrack value={value} min={range[0]} max={range[1]} label={node.name} integer={prop.controlType === EffectControlType.INTEGER} {...live} />
        </div>
      )}
      {open && angle && (
        <div className="ec-row ec-extra">
          <span />
          <AngleDial degrees={value} label={node.name} {...live} />
        </div>
      )}
    </div>
  );
}

/** Sound Keys' Commands row: Apply analyses the Audio Layer over the work area into Output keyframes. */
function SoundKeysCommands({ effect, ctx, indent, depth }: { effect: PropertyGroup; ctx: RowProps["ctx"]; indent: CSSProperties; depth: number }) {
  const editing = useEditing();
  const { editor } = editing;
  const [status, setStatus] = useState<{ busy?: boolean; text?: string; error?: boolean }>({});
  const apply = async () => {
    if (!editor || status.busy) return;
    setStatus({ busy: true, text: "Analysing audio..." });
    try {
      const summary = await applySoundKeys(editor, ctx.project, ctx.comp, ctx.layer, effect, (done) =>
        setStatus({ busy: true, text: `Analysing audio... ${Math.round(done * 100)}%` }),
      );
      setStatus({ text: summary });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : String(error), error: true });
    }
  };
  return (
    <div role="treeitem" aria-level={depth + 2} className="ec-item">
      <div className="ec-row">
        <span className="ec-name" style={indent}>
          <span className="twirl-space" />
          <span className="stopwatch-space" />
          <span className="cell-text">Commands</span>
        </span>
        <span className="ec-value" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="ae-button"
            disabled={!editor || status.busy}
            title={editor ? "Generate the Output keyframes from the whole Audio Layer" : "Open the project for editing to apply"}
            onClick={apply}
          >
            Apply
          </button>
          {status.text && <span className={`ec-status ${status.error ? "error" : ""}`} role="status">{status.text}</span>}
        </span>
      </div>
    </div>
  );
}

function EffectBlock({
  effect,
  index,
  ctx,
  time,
  selected,
  onSelect,
}: {
  effect: PropertyGroup;
  index: number;
  ctx: RowProps["ctx"];
  time: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const editing = useEditing();
  const editable = !!editing.editor && !ctx.layer.locked;
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const plugin = isPluginEffect(effect.matchName);
  const node: DisplayNode = { kind: "group", key: `fx${index}`, name: effect.name, group: effect, role: "effect" };
  const params = open ? outlineChildren(node, ctx, "effect-controls") : [];
  return (
    <div role="treeitem" aria-level={1} aria-expanded={open} aria-selected={selected} className={`ec-effect ${effect.enabled ? "" : "disabled"}`}>
      <div
        className={`ec-row ec-effect-head ${selected ? "selected" : ""}`}
        onClick={onSelect}
        onDoubleClick={() => setOpen(!open)}
        onContextMenu={(e) => {
          onSelect();
          openContextMenu(e, effectMenu(editing, ctx.comp, ctx.layer, effect));
        }}
      >
        <span className="ec-name">
          <button
            type="button"
            className={`twirl ${open ? "open" : ""}`}
            aria-label={`${open ? "Collapse" : "Expand"} ${effect.name}`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open);
            }}
          >
            <Icon name="twirl" size={10} />
          </button>
          <button
            type="button"
            className={`fx-switch ${effect.enabled ? "on" : ""}`}
            title={editable ? "Effect on/off" : effect.enabled ? "Effect on" : "Effect off"}
            aria-label={`${effect.name} on`}
            aria-pressed={effect.enabled}
            disabled={!editable}
            onClick={(e) => {
              e.stopPropagation();
              toggleEffect(editing, ctx.comp, ctx.layer, effect);
            }}
          >
            <Icon name="fx" size={13} />
          </button>
          <span className="ec-effect-name" title={`${effect.effectName ?? effect.name} (${effect.matchName})`}>
            {effect.name}
          </span>
          {plugin && <span className="tag-plugin">Plug-in</span>}
          {!effect.enabled && <span className="ec-off">Off</span>}
        </span>
        <span className="ec-value ec-effect-links">
          <span className="hot-link">Reset</span>
          {plugin && <span className="hot-link">About...</span>}
          {editable && (
            <button
              type="button"
              className="ec-remove"
              title="Delete effect (Delete)"
              aria-label={`Delete ${effect.name}`}
              onClick={(e) => {
                e.stopPropagation();
                deleteEffect(editing, ctx.comp, ctx.layer, effect);
              }}
            >
              <Icon name="trash" size={13} />
            </button>
          )}
        </span>
      </div>
      {open && (
        <div role="group">
          {params.map((child) => (
            <ParamRow key={child.key} {...{ node: child, depth: 1, effect, ctx, time, expanded, toggle, path: node.key }} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Effect Controls: the selected layer's effects, twirled open with their parameters at the current time. */
export function EffectControlsPanel({
  project,
  comp,
  layer,
  time,
}: {
  project: Project;
  comp: CompItem | undefined;
  layer: Layer | undefined;
  time: number;
}) {
  const editing = useEditing();
  // The selected effect by position: edits rebuild the layer's effect objects.
  const [selection, setSelection] = useState<{ layerId: number; index: number }>();
  if (!comp || !layer) return <p className="panel-empty">Select a layer in the Timeline to see its effects.</p>;
  const effects = layerEffects(layer);
  const ctx = { project, layer, comp };
  const selected = selection?.layerId === layer.id ? effects[selection.index] : undefined;
  return (
    <div className="ec">
      <div className="ec-path">
        {comp.name} <span className="dim">•</span> {layer.name}
      </div>
      <div
        className="ec-list"
        role="tree"
        aria-label="Effect Controls"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key !== "Delete" && e.key !== "Backspace") || !selected) return;
          if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
          // The layer's own Delete shortcut must not run as well.
          e.preventDefault();
          e.stopPropagation();
          deleteEffect(editing, comp, layer, selected);
          if (effects.length <= 1) setSelection(undefined);
          else setSelection({ layerId: layer.id, index: Math.min(selection!.index, effects.length - 2) });
        }}
      >
        {effects.length === 0 && <p className="panel-empty">This layer has no effects.</p>}
        {effects.map((effect, i) => (
          <EffectBlock
            key={`${layer.id}-${i}`}
            effect={effect}
            index={i}
            ctx={ctx}
            time={time}
            selected={effect === selected}
            onSelect={() => setSelection({ layerId: layer.id, index: i })}
          />
        ))}
      </div>
    </div>
  );
}
