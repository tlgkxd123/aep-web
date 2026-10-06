import { useState } from "react";
import { PropertyValueType, type CompItem, type Layer, type Property, type PropertyNode } from "../aep/model.ts";
import { colorCss, controlTypeName, formatValue, interpolationName, timecode } from "./format.ts";

interface Props {
  layer: Layer;
  comp: CompItem;
}

const OPAQUE_LABELS: Partial<Record<number, string>> = {
  [PropertyValueType.TEXT_DOCUMENT]: "text document (not decoded yet)",
  [PropertyValueType.MARKER]: "markers",
  [PropertyValueType.CUSTOM_VALUE]: "custom data",
};

function hasStoredContent(node: PropertyNode): boolean {
  if (node.kind === "property") return !node.synthesized;
  return !node.synthesized || node.children.some(hasStoredContent);
}

function ValueCell({ prop, comp }: { prop: Property; comp: CompItem }) {
  const { value } = prop;
  if (prop.propertyValueType === PropertyValueType.NO_VALUE) return null;
  const opaque = OPAQUE_LABELS[prop.propertyValueType];
  if (opaque && value === null) return <span className="muted">{opaque}</span>;
  if (prop.options && typeof value === "number") {
    return <span>{prop.options[value - 1] ?? value}</span>;
  }
  if (prop.propertyValueType === PropertyValueType.LAYER_INDEX && typeof value === "number") {
    const target = comp.layers[value - 1];
    return <span>{value === 0 ? "none" : `${value}. ${target?.name ?? "?"}`}</span>;
  }
  if (prop.propertyValueType === PropertyValueType.COLOR && Array.isArray(value)) {
    return (
      <span>
        <span className="swatch" style={{ background: colorCss(value) }} /> {formatValue(value)}
      </span>
    );
  }
  return <span>{formatValue(value)}</span>;
}

function Keyframes({ prop, comp }: { prop: Property; comp: CompItem }) {
  return (
    <table className="keys">
      <tbody>
        {prop.keyframes.map((kf, i) => (
          <tr key={i}>
            <td>{timecode(kf.time, comp.frameRate)}</td>
            <td>{formatValue(kf.value)}</td>
            <td className="muted">
              {interpolationName(kf.inInterpolationType)} → {interpolationName(kf.outInterpolationType)}
              {kf.roving ? " · roving" : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NodeRow({ node, depth, comp, showDefaults }: { node: PropertyNode; depth: number; comp: CompItem; showDefaults: boolean }) {
  const [open, setOpen] = useState(depth < 2 && node.kind === "group" && hasStoredContent(node));
  if (!showDefaults && !hasStoredContent(node)) return null;
  const indent = { paddingLeft: 8 + depth * 14 };
  if (node.kind === "group") {
    const tag = node.isEffect ? (node.matchName.startsWith("ADBE ") ? "effect" : "plugin") : node.mask ? "mask" : "";
    return (
      <>
        <li className={`row group ${node.synthesized ? "synth" : ""}`} style={indent} onClick={() => setOpen(!open)}>
          <span className="icon">{node.children.length ? (open ? "▾" : "▸") : "·"}</span>
          <span className="name">{node.name || node.matchName}</span>
          {tag && <span className={`tag tag-${tag}`}>{tag === "plugin" ? `plugin: ${node.effectName}` : tag}</span>}
          {!node.enabled && <span className="tag">off</span>}
          <span className="meta">{node.matchName}</span>
        </li>
        {open && node.children.map((child, i) => (
          <NodeRow key={`${child.matchName}-${i}`} node={child} depth={depth + 1} comp={comp} showDefaults={showDefaults} />
        ))}
      </>
    );
  }
  return (
    <>
      <li
        className={`row prop ${node.synthesized ? "synth" : ""} ${node.keyframes.length ? "animated" : ""}`}
        style={indent}
        title={`${node.matchName}${node.controlType !== undefined ? ` · ${controlTypeName(node.controlType)}` : ""}${node.synthesized ? " · default (not stored in file)" : ""}`}
        onClick={() => node.keyframes.length && setOpen(!open)}
      >
        <span className="icon">{node.keyframes.length ? "◆" : node.expressionEnabled ? "=" : ""}</span>
        <span className="name">{node.name || <em className="muted">{node.matchName}</em>}</span>
        <span className="value">
          <ValueCell prop={node} comp={comp} />
        </span>
      </li>
      {node.expression && (
        <li className="row expression" style={{ paddingLeft: 30 + depth * 14 }}>
          <code className={node.expressionEnabled ? "" : "muted"}>{node.expression}</code>
        </li>
      )}
      {open && node.keyframes.length > 0 && (
        <li className="row" style={{ paddingLeft: 30 + depth * 14 }}>
          <Keyframes prop={node} comp={comp} />
        </li>
      )}
    </>
  );
}

export function PropertyPanel({ layer, comp }: Props) {
  const [showDefaults, setShowDefaults] = useState(false);
  return (
    <div className="properties">
      <div className="panel-toolbar">
        <strong>
          {layer.index}. {layer.name}
        </strong>
        <label>
          <input type="checkbox" checked={showDefaults} onChange={(e) => setShowDefaults(e.target.checked)} /> show defaults
        </label>
      </div>
      <ul className="tree" aria-label="Layer properties">
        {layer.properties.map((node, i) => (
          <NodeRow key={`${node.matchName}-${i}`} node={node} depth={0} comp={comp} showDefaults={showDefaults} />
        ))}
      </ul>
    </div>
  );
}
