// Editable effect parameter values in the Effect Controls panel: scrubbable
// numbers (angles, percentages, sliders clamped to their valid range), points,
// colours, checkboxes and popups, written through the editor (one undo step per
// scrub; a keyframe at the current time when the parameter is animated).
import { Fragment } from "react";
import { EffectControlType, PropertyValueType, type CompItem, type Layer, type Property, type PropertyValue } from "../aep/model.ts";
import { isEditableProperty } from "../edit/editor.ts";
import { attempt, useEditing } from "./editing.tsx";
import { colorCss, fixed, rotationLabel } from "./format.ts";
import { ScrubNumber } from "./TransformValue.tsx";
import { Checkbox, Dropdown } from "./values.tsx";

const numberText = (v: number) => fixed(v, Math.abs(v * 10 - Math.round(v * 10)) < 1e-6 ? 1 : 2);
const AXES = ["X", "Y", "Z"];

const toHex = (c: number[]) => `#${c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string, alpha: number): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).concat(alpha);

/** Whether this parameter can be edited in place (the rest keep their read-only display). */
export function canEditEffectValue(prop: Property, value: PropertyValue): boolean {
  return isEditableProperty(prop) && (typeof value === "number" || Array.isArray(value));
}

export function EffectValue({ comp, layer, prop, value, time }: { comp: CompItem; layer: Layer; prop: Property; value: PropertyValue; time: number }) {
  const editing = useEditing();
  const editor = editing.editor;
  if (!editor) return null;
  const clamp = (v: number) => Math.min(prop.max ?? Infinity, Math.max(prop.min ?? -Infinity, v));
  const write = (next: PropertyValue, coalesce?: string) => attempt(editing, () => editor.setValue(comp, layer, prop, next, time, { coalesce }));
  const end = () => editor.commit();

  if (prop.propertyValueType === PropertyValueType.COLOR && Array.isArray(value)) {
    return (
      <label className="value-swatch-edit" title="Click to pick a colour">
        <span className="value-swatch" style={{ background: colorCss(value) }} />
        <input type="color" aria-label={prop.name} value={toHex(value)} onChange={(e) => write(fromHex(e.target.value, value[3] ?? 1))} />
      </label>
    );
  }
  if (typeof value === "number") {
    if (prop.controlType === EffectControlType.CHECKBOX) {
      return <Checkbox on={!!value} label={prop.name} onToggle={() => write(value ? 0 : 1)} />;
    }
    if (prop.options?.length) {
      return (
        <Dropdown
          text={prop.options[value - 1] ?? String(value)}
          label={prop.name}
          menu={() => prop.options!.map((label, i) => ({ label, checked: value === i + 1, onSelect: () => write(i + 1) }))}
        />
      );
    }
    if (prop.controlType === EffectControlType.ANGLE) {
      return (
        <span className="value-hot">
          <ScrubNumber value={value} text={rotationLabel(value)} label={prop.name} onChange={(v, key) => write(v, key)} onEnd={end} />
        </span>
      );
    }
    const integer = prop.controlType === EffectControlType.INTEGER;
    return (
      <span className="value-hot">
        <ScrubNumber
          value={value}
          text={integer ? String(Math.round(value)) : numberText(value)}
          label={prop.name}
          step={integer ? 1 : Math.max(0.01, ((prop.max ?? 100) - (prop.min ?? 0)) / 1000)}
          onChange={(v, key) => write(clamp(integer ? Math.round(v) : v), key)}
          onEnd={end}
        />
      </span>
    );
  }
  if (!Array.isArray(value)) return null;
  const count = prop.propertyValueType === PropertyValueType.ThreeD || prop.propertyValueType === PropertyValueType.ThreeD_SPATIAL ? 3 : 2;
  const shown = value.slice(0, count);
  return (
    <span className="value-hot">
      <span className="hot-parts">
        {shown.map((v, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="hot-sep">,</span>}
            <ScrubNumber
              value={v}
              text={numberText(v)}
              label={`${prop.name} ${AXES[i]}`}
              onChange={(next, key) => write(value.map((o, j) => (j === i ? next : o)), key)}
              onEnd={end}
            />
          </Fragment>
        ))}
      </span>
    </span>
  );
}
