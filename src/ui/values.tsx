import { EffectControlType, isGradientValue, PropertyValueType, type CompItem, type Layer, type Property, type PropertyValue } from "../aep/model.ts";
import { openMenuBelow, type MenuEntries } from "./ContextMenu.tsx";
import { colorCss, fixed, isShape, rotationLabel, timecode } from "./format.ts";
import { Icon } from "./icons.tsx";
import { findGroup, is3D } from "./properties.ts";

export interface ValueContext {
  comp: CompItem;
  layer: Layer;
}

const SCALE = new Set(["ADBE Scale", "ADBE Vector Scale", "ADBE Vector Repeater Scale"]);
const ROTATION = new Set([
  "ADBE Rotate X",
  "ADBE Rotate Y",
  "ADBE Rotate Z",
  "ADBE Vector Rotation",
  "ADBE Vector Star Rotation",
  "ADBE Vector Repeater Rotation",
  "ADBE Vector Skew Axis",
]);
const TRANSFORM_VECTORS = new Set(["ADBE Anchor Point", "ADBE Position", "ADBE Scale"]);
const PERCENT = /opacity\d?( \d)?$/i;

const decimals = (v: number) => (Math.abs(v * 10 - Math.round(v * 10)) < 1e-6 ? 1 : 2);
const numberText = (v: number) => fixed(v, decimals(v));

function dims(prop: Property, value: number[], layer: Layer): number[] {
  return TRANSFORM_VECTORS.has(prop.matchName) && !is3D(layer) ? value.slice(0, 2) : value;
}

function layerOption(comp: CompItem, index: number): string {
  if (!index) return "None";
  const target = comp.layers[index - 1];
  return target ? `${index}. ${target.name}` : `${index}`;
}

function maskOption(layer: Layer, index: number): string {
  if (!index) return "None";
  const mask = findGroup(layer.properties, "ADBE Mask Parade")?.children[index - 1];
  return mask?.name || `Mask ${index}`;
}

/** The value as AE prints it, for titles, labels and plain-text cells. */
export function valueText(prop: Property, value: PropertyValue, ctx: ValueContext): string {
  const type = prop.controlType;
  if (value === null || prop.propertyValueType === PropertyValueType.NO_VALUE) return "";
  if (isShape(value)) return "Shape...";
  if (isGradientValue(value)) return "Edit Gradient...";
  if (prop.propertyValueType === PropertyValueType.LAYER_INDEX && typeof value === "number") return layerOption(ctx.comp, value);
  if (prop.propertyValueType === PropertyValueType.MASK_INDEX && typeof value === "number") return maskOption(ctx.layer, value);
  if (prop.options && typeof value === "number") return prop.options[value - 1] ?? String(value);
  if (type === EffectControlType.CHECKBOX && typeof value === "number") return value ? "On" : "Off";
  if (Array.isArray(value)) {
    if (prop.propertyValueType === PropertyValueType.COLOR) return colorCss(value);
    const shown = dims(prop, value, ctx.layer);
    if (SCALE.has(prop.matchName)) return `${shown.map((v) => fixed(v)).join(",")}%`;
    if (prop.matchName === "ADBE Orientation") return shown.map((v) => `${fixed(v)}°`).join(",");
    if (prop.matchName === "ADBE Mask Feather") return `${shown.map((v) => fixed(v)).join(",")} pixels`;
    return shown.map(numberText).join(",");
  }
  if (typeof value !== "number") return "";
  if (prop.matchName === "ADBE Time Remapping") return timecode(value + ctx.comp.displayStartTime, ctx.comp.frameRate);
  if (ROTATION.has(prop.matchName) || type === EffectControlType.ANGLE) return rotationLabel(value);
  if (PERCENT.test(prop.matchName)) return `${Math.round(value)}%`;
  if (prop.matchName === "ADBE Mask Offset") return `${fixed(value)} pixels`;
  if (type === EffectControlType.INTEGER) return String(Math.round(value));
  return numberText(value);
}

/** An AE popup. With `menu`, clicking opens its entries under the control; without, it only shows the value. */
export function Dropdown({ text, label, width, menu }: { text: string; label: string; width?: number; menu?: () => MenuEntries }) {
  if (!menu) {
    return (
      <span className="ae-select" aria-label={`${label}: ${text}`} title={text} style={width ? { width } : undefined}>
        <span className="ae-select-text">{text}</span>
        <Icon name="chevronDown" size={10} />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="ae-select"
      aria-label={`${label}: ${text}`}
      aria-haspopup="menu"
      title={text}
      style={width ? { width } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        openMenuBelow(e.currentTarget, menu());
      }}
    >
      <span className="ae-select-text">{text}</span>
      <Icon name="chevronDown" size={10} />
    </button>
  );
}

export function Checkbox({ on, label, onToggle }: { on: boolean; label: string; onToggle?: () => void }) {
  if (!onToggle) {
    return (
      <span className={`ae-check ${on ? "on" : ""}`} role="img" aria-label={`${label}: ${on ? "on" : "off"}`}>
        {on && <Icon name="check" size={10} />}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`ae-check ${on ? "on" : ""}`}
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {on && <Icon name="check" size={10} />}
    </button>
  );
}

/** A property's value drawn the AE way: blue hot text, dropdowns, swatches and checkboxes. */
export function PropertyValueView({
  prop,
  value,
  ctx,
  place,
}: {
  prop: Property;
  value: PropertyValue;
  ctx: ValueContext;
  place: "timeline" | "effect-controls";
}) {
  const type = prop.controlType;
  const text = valueText(prop, value, ctx);
  if (type === EffectControlType.BUTTON) {
    return place === "effect-controls" ? (
      <span className="ae-button" aria-disabled="true">
        {prop.name}
      </span>
    ) : null;
  }
  if (type === EffectControlType.ARBITRARY) return <span className="value-dim">custom control</span>;
  if (prop.propertyValueType === PropertyValueType.TEXT_DOCUMENT || prop.propertyValueType === PropertyValueType.MARKER) return null;
  if (prop.propertyValueType === PropertyValueType.CUSTOM_VALUE && value === null) return null;
  if (value === null) return null;
  if (prop.propertyValueType === PropertyValueType.COLOR && Array.isArray(value)) {
    return (
      <span className="value-color">
        <span className="swatch" style={{ background: colorCss(value) }} role="img" aria-label={`${prop.name} colour ${text}`} />
        <Icon name="eyedropper" size={13} />
      </span>
    );
  }
  if (type === EffectControlType.CHECKBOX && typeof value === "number") {
    return place === "effect-controls" ? (
      <span className="value-check">
        <Checkbox on={!!value} label={prop.name} />
        <span>{prop.name}</span>
      </span>
    ) : (
      <span className="hot">{text}</span>
    );
  }
  const isDropdown =
    (prop.options && typeof value === "number") ||
    type === EffectControlType.POPUP ||
    prop.propertyValueType === PropertyValueType.LAYER_INDEX ||
    prop.propertyValueType === PropertyValueType.MASK_INDEX;
  if (isDropdown) return <Dropdown text={text} label={prop.name} />;
  const point = type === EffectControlType.POINT || type === EffectControlType.POINT_3D;
  return (
    <span className="value-hot">
      {point && place === "effect-controls" && <Icon name="crosshair" size={13} className="value-icon" />}
      {SCALE.has(prop.matchName) && <Icon name="link" size={12} className="value-icon" />}
      <span className="hot">{text}</span>
    </span>
  );
}
