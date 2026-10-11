// Particular's Size over Life and Opacity over Life in Effect Controls: the curve from
// birth (left) to death (right), 0 to 100 % of the particle's Size or Opacity, shown in
// the value column and edited, twirled open, through its control points (at most 25,
// joined by straight lines). A press on the graph adds a point and drags it, a press on
// a point drags it (birth and death only up and down); a focused point moves with the
// arrow keys and goes with Delete, and the selected point's life and value scrub or take
// a typed number. Each gesture is one undo step.
import { useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CompItem, Layer, PropertyGroup } from "../aep/model.ts";
import { hasEffectData, setEffectData } from "../edit/effects.ts";
import {
  addPoint,
  CURVE_SAMPLES,
  drawnCurve,
  flatCurve,
  MAX_CURVE_POINTS,
  movePoint,
  overLifeCurve,
  overLifePoints,
  removePoint,
  type CurvePoint,
} from "../render/effects/particularCurves.ts";
import { openContextMenu } from "./ContextMenu.tsx";
import { attempt, nextDragKey, useEditing } from "./editing.tsx";
import { fixed } from "./format.ts";
import { Icon } from "./icons.tsx";
import { followPointer } from "./pointer.ts";
import { ScrubNumber } from "./TransformValue.tsx";

const GRAPH_W = CURVE_SAMPLES - 1;
const GRAPH_H = 100;
/** How near a press must land to a point to pick it up, in CSS pixels. */
const REACH = { mouse: 7, touch: 16 };

const unit = (v: number) => Math.min(1, Math.max(0, v));
const polyline = (curve: Float32Array) => Array.from(curve, (v, i) => `${i},${(GRAPH_H * (1 - unit(v))).toFixed(2)}`).join(" ");
const percent = (v: number) => fixed(v * 100, 1);
const samePoints = (a: readonly CurvePoint[], b: readonly CurvePoint[]) => a.length === b.length && a.every(([u, v], i) => u === b[i][0] && v === b[i][1]);

/** The point drawn nearest (x, y) within `reach` pixels of it, -1 when none is. */
function nearest(points: readonly CurvePoint[], box: DOMRect, x: number, y: number, reach: number): number {
  let found = -1;
  let best = reach;
  points.forEach(([u, v], k) => {
    const d = Math.hypot(box.left + u * box.width - x, box.top + (1 - v) * box.height - y);
    if (d <= best) [found, best] = [k, d];
  });
  return found;
}

const pointOf = (target: EventTarget): number | undefined => {
  const handle = target instanceof Element ? target.closest("[data-point]") : null;
  return handle ? Number(handle.getAttribute("data-point")) : undefined;
};

export function OverLifeRow({
  comp,
  layer,
  effect,
  n,
  name,
  depth,
  indent,
  open,
  onToggle,
}: {
  comp: CompItem;
  layer: Layer;
  effect: PropertyGroup;
  n: number;
  name: string;
  depth: number;
  indent: CSSProperties;
  open: boolean;
  onToggle: () => void;
}) {
  const { editor } = useEditing();
  const curve = overLifeCurve(effect.chunk, n);
  const points = overLifePoints(effect.chunk, n);
  if (!curve || !points) return null;
  const editable = !!editor && !layer.locked && hasEffectData(effect, n);
  const line = polyline(curve);
  return (
    <div role="treeitem" aria-level={depth + 2} aria-expanded={open} className="ec-item">
      <div className="ec-row" onClick={onToggle}>
        <span className="ec-name" style={indent}>
          <span className={`twirl ${open ? "open" : ""}`} aria-hidden="true">
            <Icon name="twirl" size={10} />
          </span>
          <span className="stopwatch-space" />
          <span className="cell-text">{name}</span>
        </span>
        <span className="ec-value">
          <svg className="ec-curve-thumb" viewBox={`0 -12 ${GRAPH_W} ${GRAPH_H + 24}`} preserveAspectRatio="none" role="img" aria-label={`${name} curve`}>
            <polyline className="ec-curve-line" points={line} />
          </svg>
        </span>
      </div>
      {open && (
        <div className="ec-row ec-extra">
          <span />
          <CurveEditor {...{ comp, effect, n, name, line, points, editable }} />
        </div>
      )}
    </div>
  );
}

function CurveEditor({
  comp,
  effect,
  n,
  name,
  line,
  points,
  editable,
}: {
  comp: CompItem;
  effect: PropertyGroup;
  n: number;
  name: string;
  line: string;
  points: readonly CurvePoint[];
  editable: boolean;
}) {
  const editing = useEditing();
  const { editor } = editing;
  const graph = useRef<SVGSVGElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<number>();
  const [full, setFull] = useState(false);
  // A long touch press opens the context menu instead of adding a point where it rests.
  const menuOpened = useRef(false);
  const selected = chosen !== undefined && chosen < points.length ? chosen : undefined;
  const last = points.length - 1;
  const quantity = / over Life$/i.test(name) ? name.replace(/ over Life$/i, "") : "Value";
  const moveLabel = `Move ${name} Point`;

  const write = (next: readonly CurvePoint[], label: string, coalesce?: string) => {
    if (editor) attempt(editing, () => setEffectData(editor, comp, effect, n, (data) => drawnCurve(data, next), { label, coalesce }));
  };
  const select = (k: number | undefined, focus = false) => {
    setChosen(k);
    setFull(false);
    if (focus && k !== undefined) area.current?.querySelector<HTMLElement>(`[data-point="${k}"]`)?.focus({ preventScroll: true });
  };
  const remove = (k: number, focus = false) => {
    if (k <= 0 || k >= last) return;
    write(removePoint(points, k), `Delete ${name} Point`);
    select(k - 1, focus);
  };
  const reset = () => {
    if (editor) attempt(editing, () => setEffectData(editor, comp, effect, n, flatCurve, { label: `Reset ${name}` }));
    select(undefined);
  };

  const press = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!editor || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const box = graph.current!.getBoundingClientRect();
    const width = Math.max(1, box.width);
    const height = Math.max(1, box.height);
    const at: CurvePoint = [unit((e.clientX - box.left) / width), unit(1 - (e.clientY - box.top) / height)];
    let k = pointOf(e.target) ?? nearest(points, box, e.clientX, e.clientY, e.pointerType === "touch" ? REACH.touch : REACH.mouse);
    let origin = k >= 0 ? points[k] : at;
    let current: readonly CurvePoint[] = points;
    let label = moveLabel;
    let refused = false;
    const key = nextDragKey("curve");
    const insert = () => {
      if (refused) return false;
      const added = addPoint(current, at[0], at[1]);
      if (added.index < 0) {
        refused = true;
        setChosen(undefined);
        setFull(true);
        return false;
      }
      [k, current, origin, label] = [added.index, added.points, at, `Add ${name} Point`];
      write(current, label, key);
      select(k, true);
      return true;
    };
    menuOpened.current = false;
    if (k >= 0) select(k, true);
    // A finger adds its point once it moves or lifts, so that a long press can open the menu.
    else if (e.pointerType !== "touch") insert();
    followPointer(
      e,
      (ev) => {
        if (k < 0 && !insert()) return;
        const next = movePoint(current, k, origin[0] + (ev.clientX - e.clientX) / width, origin[1] - (ev.clientY - e.clientY) / height);
        if (samePoints(next, current)) return;
        current = next;
        write(current, label, key);
      },
      (_ev, cancelled) => {
        if (k < 0 && !cancelled && !menuOpened.current) insert();
        editor.commit();
      },
    );
  };

  const menu = (e: ReactMouseEvent<HTMLDivElement>) => {
    menuOpened.current = true;
    const k = pointOf(e.target) ?? nearest(points, graph.current!.getBoundingClientRect(), e.clientX, e.clientY, REACH.touch);
    if (k >= 0) select(k);
    openContextMenu(e, [
      { label: "Delete Point", disabled: k <= 0 || k >= last, onSelect: () => remove(k) },
      "-",
      { label: `Reset ${name}`, onSelect: reset },
    ]);
  };

  const keyDown = (k: number) => (e: KeyboardEvent<HTMLSpanElement>) => {
    const [u, v] = points[k];
    const step = e.shiftKey ? 10 : 1;
    let next: CurvePoint[] | undefined;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") next = movePoint(points, k, u, v + ((e.key === "ArrowUp" ? 1 : -1) * step) / 100);
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") next = movePoint(points, k, u + ((e.key === "ArrowRight" ? 1 : -1) * step) / GRAPH_W, v);
    else if (e.key !== "Delete" && e.key !== "Backspace") return;
    // The Effect Controls tree deletes the selected effect on Delete.
    e.preventDefault();
    e.stopPropagation();
    if (!next) remove(k, true);
    else if (!samePoints(next, points)) write(next, moveLabel);
  };

  const field = (k: number, axis: 0 | 1) => {
    const value = points[k][axis];
    const label = `${name} point ${k + 1} ${axis ? quantity.toLowerCase() : "life"}`;
    if (axis === 0 && (k === 0 || k === last)) return <span>{percent(value)}</span>;
    return (
      <ScrubNumber
        value={value * 100}
        text={percent(value)}
        label={label}
        step={0.5}
        onChange={(v, coalesce) => write(movePoint(points, k, axis ? points[k][0] : v / 100, axis ? v / 100 : points[k][1]), moveLabel, coalesce)}
        onEnd={() => editor?.commit()}
      />
    );
  };

  return (
    <div className="ec-curve">
      <div
        ref={area}
        className={`ec-curve-area ${editable ? "live" : ""}`}
        title={editable ? "Click to add a point, drag a point to move it" : undefined}
        onPointerDown={editable ? press : undefined}
        onContextMenu={editable ? menu : undefined}
      >
        <div className="ec-curve-plot">
          <svg ref={graph} className="ec-curve-graph" viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`} preserveAspectRatio="none" role="img" aria-label={`${name} graph`}>
            {[0, 0.25, 0.5, 0.75, 1].map((g) => (
              <line key={`h${g}`} className="ec-curve-grid" x1={0} x2={GRAPH_W} y1={GRAPH_H * g} y2={GRAPH_H * g} />
            ))}
            {[0.25, 0.5, 0.75].map((g) => (
              <line key={`v${g}`} className="ec-curve-grid" y1={0} y2={GRAPH_H} x1={GRAPH_W * g} x2={GRAPH_W * g} />
            ))}
            <polyline className="ec-curve-line" points={line} />
          </svg>
          {editable &&
            points.map(([u, v], k) => (
              <span
                key={k}
                data-point={k}
                className={`ec-curve-point ${k === selected ? "selected" : ""}`}
                style={{ left: `${u * 100}%`, top: `${(1 - v) * 100}%` }}
                role="slider"
                tabIndex={0}
                aria-label={`${name} point ${k + 1}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Number(percent(v))}
                aria-valuetext={`${percent(u)} % of life: ${percent(v)} %`}
                onFocus={() => select(k)}
                onKeyDown={keyDown(k)}
              />
            ))}
        </div>
      </div>
      <span className="ec-slider-labels">
        <span>Birth</span>
        <span>Death</span>
      </span>
      {editable && (
        <span className="ec-curve-readout">
          {selected === undefined ? (
            <span className="dim">{full ? `A curve holds ${MAX_CURVE_POINTS} points at most` : "Click the graph to add a point"}</span>
          ) : (
            <>
              <span className="dim">Life</span>
              {field(selected, 0)}
              <span className="dim">%</span>
              <span className="dim">{quantity}</span>
              {field(selected, 1)}
              <span className="dim">%</span>
              <button
                type="button"
                className="ec-curve-delete"
                title="Delete point (Delete)"
                aria-label={`Delete ${name} point ${selected + 1}`}
                disabled={selected === 0 || selected === last}
                onClick={() => remove(selected)}
              >
                <Icon name="trash" size={12} />
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
}
