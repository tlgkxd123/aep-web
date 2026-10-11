// Particular's Size over Life and Opacity over Life in Effect Controls: the curve from
// birth (left) to death (right), 0 to 100 % of the particle's Size or Opacity, drawn
// freehand on the graph or picked from the presets, each change one undo step.
import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { CompItem, Layer, PropertyGroup } from "../aep/model.ts";
import { hasEffectData, setEffectData } from "../edit/effects.ts";
import { CURVE_PRESETS, CURVE_SAMPLES, drawnCurve, overLifeCurve, pointSamples, sampledCurve } from "../render/effects/particularCurves.ts";
import { attempt, nextDragKey, useEditing } from "./editing.tsx";
import { Icon } from "./icons.tsx";
import { followPointer } from "./pointer.ts";
import { Dropdown } from "./values.tsx";

const presetSamples = CURVE_PRESETS.map((p) => pointSamples(p.points));

/** The preset the curve is, if any. */
function presetOf(curve: Float32Array): string | undefined {
  const at = presetSamples.findIndex((s) => s.every((v, i) => Math.abs(v - curve[i]) < 1e-4));
  return at >= 0 ? CURVE_PRESETS[at].name : undefined;
}

const GRAPH_W = CURVE_SAMPLES - 1;
const GRAPH_H = 100;

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
  const editing = useEditing();
  const { editor } = editing;
  const graph = useRef<SVGSVGElement>(null);
  const curve = overLifeCurve(effect.chunk, n);
  if (!curve) return null;
  const editable = !!editor && !layer.locked && hasEffectData(effect, n);
  const preset = presetOf(curve);

  const draw = (e: ReactPointerEvent) => {
    if (!editor || !editable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const samples = Float32Array.from(curve);
    const key = nextDragKey("curve");
    let last: [number, number] | undefined;
    const paint = (ev: { clientX: number; clientY: number }) => {
      const box = graph.current!.getBoundingClientRect();
      const x = Math.round(Math.min(1, Math.max(0, (ev.clientX - box.left) / Math.max(1, box.width))) * GRAPH_W);
      const y = Math.min(1, Math.max(0, 1 - (ev.clientY - box.top) / Math.max(1, box.height)));
      const [x0, y0] = last ?? [x, y];
      const steps = Math.abs(x - x0);
      for (let s = 0; s <= steps; s++) {
        const f = steps ? s / steps : 1;
        samples[Math.round(x0 + (x - x0) * f)] = y0 + (y - y0) * f;
      }
      last = [x, y];
      attempt(editing, () => setEffectData(editor, comp, effect, n, (data) => sampledCurve(data, samples), { label: `Change ${name}`, coalesce: key }));
    };
    paint(e);
    followPointer(e, paint, () => editor.commit(), 0);
  };

  const line = Array.from(curve, (v, i) => `${i},${(GRAPH_H * (1 - Math.min(1, Math.max(0, v)))).toFixed(2)}`).join(" ");
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
        <span className="ec-value" onClick={(e) => e.stopPropagation()}>
          <Dropdown
            text={preset ?? "Custom"}
            label={`${name} preset`}
            menu={
              editable
                ? () =>
                    CURVE_PRESETS.map((p) => ({
                      label: p.name,
                      checked: p.name === preset,
                      onSelect: () =>
                        attempt(editing, () => setEffectData(editor!, comp, effect, n, (data) => drawnCurve(data, p.points), { label: `${name}: ${p.name}` })),
                    }))
                : undefined
            }
          />
        </span>
      </div>
      {open && (
        <div className="ec-row ec-extra">
          <span />
          <span className="ec-curve">
            <svg
              ref={graph}
              className={`ec-curve-graph ${editable ? "live" : ""}`}
              viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${name} graph`}
              onPointerDown={draw}
            >
              {[0.25, 0.5, 0.75].map((g) => (
                <line key={`h${g}`} className="ec-curve-grid" x1={0} x2={GRAPH_W} y1={GRAPH_H * g} y2={GRAPH_H * g} />
              ))}
              {[0.25, 0.5, 0.75].map((g) => (
                <line key={`v${g}`} className="ec-curve-grid" y1={0} y2={GRAPH_H} x1={GRAPH_W * g} x2={GRAPH_W * g} />
              ))}
              <polyline className="ec-curve-line" points={line} />
            </svg>
            <span className="ec-slider-labels">
              <span>Birth</span>
              <span>Death</span>
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
