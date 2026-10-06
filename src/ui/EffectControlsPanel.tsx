import { useState } from "react";
import { EffectControlType, type CompItem, type Layer, type Project, type Property, type PropertyGroup } from "../aep/model.ts";
import { valueAt } from "./animate.ts";
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
import { isEditableProperty } from "../edit/editor.ts";
import { attempt, useEditing } from "./editing.tsx";
import { canEditEffectValue, EffectValue } from "./EffectValue.tsx";

function SliderTrack({ value, min, max }: { value: number; min: number; max: number }) {
  const t = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  return (
    <span className="ec-slider">
      <span className="ec-slider-track">
        <span className="ec-slider-thumb" style={{ left: `${t * 100}%` }} />
      </span>
      <span className="ec-slider-labels">
        <span>{fixed(min, Number.isInteger(min) ? 1 : 2)}</span>
        <span>{fixed(max, Number.isInteger(max) ? 1 : 2)}</span>
      </span>
    </span>
  );
}

function AngleDial({ degrees }: { degrees: number }) {
  const r = (degrees * Math.PI) / 180;
  return (
    <svg className="ec-dial" width="44" height="44" viewBox="-22 -22 44 44" aria-hidden="true">
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
  const value = valueAt(prop, time, ctx.layer);
  const range = typeof value === "number" ? sliderRange(prop, effect, ctx) : undefined;
  const angle = prop.controlType === EffectControlType.ANGLE && typeof value === "number";
  const twirls = !!range || angle;
  const button = prop.controlType === EffectControlType.BUTTON;
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
          {prop.canVaryOverTime && editor && isEditableProperty(prop) ? (
            <button
              type="button"
              className={`stopwatch ${isAnimated(prop) ? "on" : ""}`}
              aria-label={`${isAnimated(prop) ? "Remove" : "Enable"} keyframing for ${node.name}`}
              aria-pressed={isAnimated(prop)}
              title="Time-Vary Stopwatch"
              onClick={(e) => {
                e.stopPropagation();
                attempt(editing, () => editor.toggleStopwatch(ctx.comp, ctx.layer, prop, time));
              }}
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
          {!button && <span className="cell-text">{node.name}</span>}
        </span>
        <span className="ec-value" onClick={(e) => e.stopPropagation()}>
          {editor && canEditEffectValue(prop, value) ? (
            <EffectValue comp={ctx.comp} layer={ctx.layer} prop={prop} value={value} time={time} />
          ) : (
            <PropertyValueView prop={prop} value={value} ctx={ctx} place="effect-controls" />
          )}
        </span>
      </div>
      {open && range && typeof value === "number" && (
        <div className="ec-row ec-extra">
          <span />
          <SliderTrack value={value} min={range[0]} max={range[1]} />
        </div>
      )}
      {open && angle && (
        <div className="ec-row ec-extra">
          <span />
          <AngleDial degrees={value} />
        </div>
      )}
    </div>
  );
}

function EffectBlock({ effect, index, ctx, time }: { effect: PropertyGroup; index: number; ctx: RowProps["ctx"]; time: number }) {
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
    <div role="treeitem" aria-level={1} aria-expanded={open} className={`ec-effect ${effect.enabled ? "" : "disabled"}`}>
      <div className="ec-row ec-effect-head" onClick={() => setOpen(!open)}>
        <span className="ec-name">
          <span className={`twirl ${open ? "open" : ""}`} aria-hidden="true">
            <Icon name="twirl" size={10} />
          </span>
          <span className={`fx-switch ${effect.enabled ? "on" : ""}`} role="img" aria-label={effect.enabled ? "Effect on" : "Effect off"}>
            <Icon name="fx" size={13} />
          </span>
          <span className="ec-effect-name" title={`${effect.effectName ?? effect.name} (${effect.matchName})`}>
            {effect.name}
          </span>
          {plugin && <span className="tag-plugin">Plug-in</span>}
        </span>
        <span className="ec-value ec-effect-links">
          <span className="hot-link">Reset</span>
          {plugin && <span className="hot-link">About...</span>}
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
  if (!comp || !layer) return <p className="panel-empty">Select a layer in the Timeline to see its effects.</p>;
  const effects = layerEffects(layer);
  const ctx = { project, layer, comp };
  return (
    <div className="ec">
      <div className="ec-path">
        {comp.name} <span className="dim">•</span> {layer.name}
      </div>
      <div className="ec-list" role="tree" aria-label="Effect Controls">
        {effects.length === 0 && <p className="panel-empty">This layer has no effects.</p>}
        {effects.map((effect, i) => (
          <EffectBlock key={`${layer.id}-${i}`} effect={effect} index={i} ctx={ctx} time={time} />
        ))}
      </div>
    </div>
  );
}
