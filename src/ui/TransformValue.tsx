import { Fragment, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CompItem, Layer, Property, PropertyValue } from "../aep/model.ts";
import { setTransformValue } from "../edit/transform-ops.ts";
import { attempt, nextDragKey, useEditing } from "./editing.tsx";
import { fixed } from "./format.ts";
import { Icon } from "./icons.tsx";
import { is3D } from "./properties.ts";

/** Pointer travel before a press on a value becomes a scrub rather than a click into the text field. */
const SCRUB_SLOP = 2;

/**
 * AE's blue "hot text" number: drag left/right to scrub (Shift ×10, Ctrl ×0.1),
 * click to type a value. One scrub is one undo step.
 */
function ScrubNumber({
  value,
  editValue = value,
  text,
  label,
  step = 1,
  onChange,
  onEnd,
}: {
  /** The value a scrub starts from. */
  value: number;
  /** The value the text field starts with, when it differs (rotation degrees within the turn). */
  editValue?: number;
  text: string;
  label: string;
  step?: number;
  /** `coalesce` is set while scrubbing and unset for a typed value. */
  onChange: (value: number, coalesce?: string) => void;
  onEnd: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const latest = useRef(onChange);
  latest.current = onChange;

  const onPointerDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x = e.clientX;
    const start = value;
    const key = nextDragKey("scrub");
    let scrubbing = false;
    const move = (ev: PointerEvent | MouseEvent) => {
      const distance = ev.clientX - x;
      if (!Number.isFinite(distance) || (!scrubbing && Math.abs(distance) <= SCRUB_SLOP)) return;
      scrubbing = true;
      const factor = ev.shiftKey ? 10 : ev.ctrlKey || ev.metaKey ? 0.1 : 1;
      latest.current(start + distance * step * factor, key);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (scrubbing) onEnd();
      else setEditing(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (editing) {
    const commit = (input: HTMLInputElement) => {
      const next = Number(input.value.replace(/[^\d.eE+-]/g, ""));
      setEditing(false);
      if (input.value.trim() !== "" && Number.isFinite(next) && next !== editValue) latest.current(next);
    };
    return (
      <input
        className="hot-input"
        aria-label={label}
        autoFocus
        defaultValue={fixed(editValue, Math.abs(editValue * 10 - Math.round(editValue * 10)) > 1e-6 ? 2 : 1)}
        size={Math.max(3, text.length)}
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" || e.key === "Tab") commit(e.currentTarget);
          else if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      setEditing(true);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      latest.current(value + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1), nextDragKey("step"));
      onEnd();
    }
  };
  return (
    <span
      className="hot scrub"
      role="spinbutton"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={value}
      aria-valuetext={text}
      title="Drag to change, click to type"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {text}
    </span>
  );
}

/** Scale link state per layer, as the Timeline keeps it while the project is open. AE starts it linked. */
const scaleLinks = new Map<string, boolean>();

const numberText = (v: number) => fixed(v, Math.abs(v * 10 - Math.round(v * 10)) < 1e-6 ? 1 : 2);
const AXES = ["X", "Y", "Z"];

/** A Transform property's value in the Timeline as editable hot text: Anchor Point, Position, Scale, Rotation, Opacity. */
export function TransformValue({ comp, layer, prop, value, time }: { comp: CompItem; layer: Layer; prop: Property; value: PropertyValue; time: number }) {
  const editing = useEditing();
  const linkKey = `${comp.id}:${layer.id}`;
  const [linked, setLinked] = useState(scaleLinks.get(linkKey) ?? true);
  const editor = editing.editor;
  if (!editor) return null;
  const m = prop.matchName;
  const write = (v: number | (number | undefined)[], coalesce?: string) =>
    attempt(editing, () => setTransformValue(editor, comp, layer, m, v, time, { coalesce }));
  const end = () => editor.commit();

  if (typeof value === "number") {
    if (m === "ADBE Opacity") {
      return (
        <span className="value-hot">
          <ScrubNumber
            value={value}
            text={`${Math.round(value)}%`}
            label={prop.name}
            onChange={(v, key) => write(Math.min(100, Math.max(0, Math.round(v))), key)}
            onEnd={end}
          />
        </span>
      );
    }
    if (/^ADBE Rotate [XYZ]$/.test(m)) {
      const turns = Math.trunc(value / 360);
      const rest = value - turns * 360;
      return (
        <span className="value-hot">
          <span className="hot-parts">
            <ScrubNumber value={turns} text={`${turns}x`} label={`${prop.name} revolutions`} onChange={(v, key) => write(Math.round(v) * 360 + rest, key)} onEnd={end} />
            <ScrubNumber
              value={value}
              editValue={rest}
              text={`${rest < 0 ? "-" : "+"}${fixed(Math.abs(rest))}°`}
              label={`${prop.name} degrees`}
              onChange={(v, key) => write(key ? v : turns * 360 + v, key)}
              onEnd={end}
            />
          </span>
        </span>
      );
    }
    return (
      <span className="value-hot">
        <ScrubNumber value={value} text={numberText(value)} label={prop.name} onChange={write} onEnd={end} />
      </span>
    );
  }
  if (!Array.isArray(value)) return null;
  const count = is3D(layer) ? Math.min(3, value.length) : Math.min(2, value.length);
  const shown = value.slice(0, count) as number[];
  const isScale = m === "ADBE Scale";
  const isOrientation = m === "ADBE Orientation";
  const component = (i: number, v: number, key?: string) => {
    const next: (number | undefined)[] = [];
    if (isScale && linked) {
      const old = shown[i] ?? 0;
      shown.forEach((o, j) => (next[j] = j === i ? v : old ? (o * v) / old : v));
    } else next[i] = v;
    write(next, key);
  };
  return (
    <span className="value-hot">
      {isScale && (
        <button
          type="button"
          className={`value-icon scale-link ${linked ? "on" : ""}`}
          aria-label="Constrain Proportions"
          aria-pressed={linked}
          title="Constrain Proportions"
          onClick={(e) => {
            e.stopPropagation();
            scaleLinks.set(linkKey, !linked);
            setLinked(!linked);
          }}
        >
          <Icon name={linked ? "link" : "unlink"} size={12} />
        </button>
      )}
      <span className="hot-parts">
        {shown.map((v, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="hot-sep">,</span>}
            <ScrubNumber
              value={v}
              text={isScale ? fixed(v) : isOrientation ? `${fixed(v)}°` : numberText(v)}
              label={`${prop.name} ${AXES[i]}`}
              onChange={(next, key) => component(i, next, key)}
              onEnd={end}
            />
          </Fragment>
        ))}
        {isScale && <span className="hot">%</span>}
      </span>
    </span>
  );
}
