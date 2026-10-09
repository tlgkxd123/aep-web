// Editable property values, in Effect Controls and in the Timeline: scrubbable
// numbers (angles, percentages, sliders clamped to their valid range), points,
// colours, checkboxes, popups and layer/mask pickers, written through the editor
// (one undo step per scrub; a keyframe at the current time when animated).
import { Fragment } from "react";
import { findChild } from "../aep/riff.ts";
import { EffectControlType, PropertyValueType, type CompItem, type Layer, type Property, type PropertyGroup, type PropertyValue } from "../aep/model.ts";
import { hasNumericValue, isEditableProperty, type Editor } from "../edit/editor.ts";
import { canStore, setPropertyValue } from "../edit/stored-property.ts";
import { attempt, useEditing } from "./editing.tsx";
import { colorCss, fixed, rotationLabel } from "./format.ts";
import { ScrubNumber } from "./TransformValue.tsx";
import { Checkbox, Dropdown } from "./values.tsx";

const numberText = (v: number) => fixed(v, Math.abs(v * 10 - Math.round(v * 10)) < 1e-6 ? 1 : 2);
const AXES = ["X", "Y", "Z"];

const toHex = (c: number[]) => `#${c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string, alpha: number): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).concat(alpha);

/** A layer or mask parameter the editor can repoint (its reference is stored in the file). */
function isReference(prop: Property): "layer" | "mask" | undefined {
  if (!prop.chunk || prop.synthesized) return undefined;
  if (prop.propertyValueType === PropertyValueType.LAYER_INDEX && findChild(prop.chunk, "tdpi")) return "layer";
  if (prop.propertyValueType === PropertyValueType.MASK_INDEX && findChild(prop.chunk, "tdli")) return "mask";
  return undefined;
}

/**
 * Whether this property's value can be edited in place (the rest keep their read-only display), including
 * parameters After Effects left out at their default, which are written on the first change.
 */
export function canEditEffectValue(editor: Editor | undefined, layer: Layer, prop: Property, value: PropertyValue): boolean {
  if (isReference(prop)) return true;
  if (typeof value !== "number" && !Array.isArray(value)) return false;
  return isEditableProperty(prop) || (!!prop.synthesized && hasNumericValue(prop) && canStore(editor, layer, prop));
}

const masksOf = (layer: Layer) =>
  (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Mask Parade")?.children ?? []).filter((n) => n.kind === "group");

export function EffectValue({ comp, layer, prop, value, time }: { comp: CompItem; layer: Layer; prop: Property; value: PropertyValue; time: number }) {
  const editing = useEditing();
  const editor = editing.editor;
  if (!editor) return null;
  const clamp = (v: number) => Math.min(prop.max ?? Infinity, Math.max(prop.min ?? -Infinity, v));
  const write = (next: PropertyValue, coalesce?: string) => attempt(editing, () => setPropertyValue(editor, comp, layer, prop, next, time, { coalesce }));
  const end = () => editor.commit();

  const reference = isReference(prop);
  if (reference === "layer") {
    const index = typeof value === "number" ? value : 0;
    const target = index ? comp.layers[index - 1] : undefined;
    return (
      <Dropdown
        text={target ? `${index}. ${target.name}` : "None"}
        label={prop.name}
        menu={() => [
          { label: "None", checked: !target, onSelect: () => attempt(editing, () => editor.setLayerReference(comp, layer, prop, null)) },
          "-",
          ...comp.layers.map((l, i) => ({
            label: `${i + 1}. ${l.name}`,
            checked: l === target,
            onSelect: () => attempt(editing, () => editor.setLayerReference(comp, layer, prop, l)),
          })),
        ]}
      />
    );
  }
  if (reference === "mask") {
    const index = typeof value === "number" ? value : 0;
    const masks = masksOf(layer);
    return (
      <Dropdown
        text={index ? (masks[index - 1]?.name ?? `Mask ${index}`) : "None"}
        label={prop.name}
        menu={() => [
          { label: "None", checked: !index, onSelect: () => attempt(editing, () => editor.setMaskReference(comp, layer, prop, 0)) },
          ...masks.map((m, i) => ({
            label: m.name || `Mask ${i + 1}`,
            checked: index === i + 1,
            onSelect: () => attempt(editing, () => editor.setMaskReference(comp, layer, prop, i + 1)),
          })),
        ]}
      />
    );
  }

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
