// The selected layer's mask and shape paths over the Composition viewer, with their vertices and the handles
// of the selected ones. With the Selection tool a vertex, a handle or a whole path (clicked on its outline)
// drags; Add Vertex (or the Pen on an outline) splits a segment, Delete Vertex removes a vertex and Convert
// Vertex turns a corner smooth or a smooth vertex into a corner (dragging from a vertex pulls new handles).
// Each drag writes the path at the current time (a keyframe when the path is animated) as one undo step.
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { CompItem, Layer, Shape } from "../aep/model.ts";
import { deleteMasks } from "../edit/masks.ts";
import { setPropertyValue } from "../edit/stored-property.ts";
import { apply, type Matrix } from "./animate.ts";
import { svgPath } from "./drawTools.ts";
import { attempt, nextDragKey, useEditing } from "./editing.tsx";
import {
  convertVertex,
  deleteVertex,
  deltaInPath,
  editablePaths,
  hitSegment,
  insertVertex,
  moveHandle,
  moveVertices,
  pointInPath,
  type EditablePath,
} from "./pathEditing.ts";
import { followPointer } from "./pointer.ts";
import { useMedia } from "./responsive.ts";
import "./drawing.css";

/** Screen pixels within which a click lands on an outline. */
const OUTLINE_PIXELS = 5;
/** What a finger hits instead: around an outline, and the side of a vertex's (and twice a handle's radius) target. */
const TOUCH_OUTLINE_PIXELS = 14;
const TOUCH_TARGET_PIXELS = 28;
const NUDGES: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

interface Selection {
  path: number;
  vertices: number[];
}

export function PathOverlay({
  comp,
  layer,
  matrix,
  time,
  scale,
  toComp,
  onDrag,
}: {
  comp: CompItem;
  layer: Layer;
  matrix: Matrix;
  time: number;
  scale: number;
  /** A pointer position in comp pixels. */
  toComp: (clientX: number, clientY: number) => [number, number];
  /** Told how to stop each drag (keeping what it did), for the viewer to stop it when a second finger pinches. */
  onDrag?: (stop: () => void) => void;
}) {
  const editing = useEditing();
  const { editor, revision, tool } = editing;
  const paths = useMemo(() => editablePaths(layer, matrix, time), [layer, matrix, time, revision]);
  const [selection, setSelection] = useState<Selection>();
  useEffect(() => setSelection(undefined), [layer.id]);
  const coarse = useMedia("(pointer: coarse)");
  const editable = !!editor && !layer.locked;
  const active = editable && ["selection", "pen", "addVertex", "deleteVertex", "convertVertex"].includes(tool);
  const px = 1 / scale;
  const outline = (coarse ? TOUCH_OUTLINE_PIXELS : OUTLINE_PIXELS) * px;
  /** Follows a drag, handing the viewer its stop. */
  const follow = (...args: Parameters<typeof followPointer>) => {
    const stop = followPointer(...args);
    onDrag?.(() => {
      stop();
      editor?.commit();
    });
  };
  const aspect = comp.pixelAspect || 1;

  const write = (path: EditablePath, shape: Shape, coalesce?: string) =>
    attempt(editing, () => setPropertyValue(editor!, comp, layer, path.prop, shape, time, { coalesce }));

  // With vertices selected, Delete removes them (a whole mask when all of its vertices are), the arrow keys
  // nudge them (Shift: 10 px) and Escape lets them go, before the layer shortcuts see the keys.
  const latest = useRef({ paths, selection, write });
  latest.current = { paths, selection, write };
  useEffect(() => {
    if (!editable || !selection) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
      const { paths: current, selection: chosen, write: put } = latest.current;
      const path = chosen && current[chosen.path];
      if (!path || !chosen || path.locked) return;
      const nudge = NUDGES[e.key];
      if (e.key === "Escape") setSelection(undefined);
      else if (e.key === "Delete" || e.key === "Backspace") {
        if (chosen.vertices.length >= path.shape.vertices.length && path.owner.mask) {
          attempt(editing, () => deleteMasks(editor!, comp, layer, [path.owner]));
        } else {
          let shape = path.shape;
          for (const v of [...chosen.vertices].sort((a, b) => b - a)) shape = deleteVertex(shape, v);
          put(path, shape);
        }
        setSelection(undefined);
      } else if (nudge && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const n = e.shiftKey ? 10 : 1;
        put(path, moveVertices(path.shape, chosen.vertices, deltaInPath(path.toComp, [nudge[0] * n, nudge[1] * n])));
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // A press anywhere but on a path lets the vertices go, as a click elsewhere does in AE.
    const press = (e: globalThis.PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".path-overlay")) setSelection(undefined);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", press, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", press, true);
    };
  }, [editable, selection, editor, editing, comp, layer]);

  /** Drags vertices (and with them their handles) of one path from comp point `start`. */
  const dragVertices = (e: PointerEvent, index: number, vertices: number[]) => {
    const path = paths[index];
    const start = toComp(e.clientX, e.clientY);
    const key = nextDragKey("path");
    follow(
      e,
      (ev) => {
        const at = toComp(ev.clientX, ev.clientY);
        let delta: [number, number] = [at[0] - start[0], at[1] - start[1]];
        if (ev.shiftKey) delta = Math.abs(delta[0]) > Math.abs(delta[1]) ? [delta[0], 0] : [0, delta[1]];
        write(path, moveVertices(path.shape, vertices, deltaInPath(path.toComp, delta)), key);
      },
      () => editor?.commit(),
    );
  };

  const onVertex = (e: PointerEvent, index: number, vertex: number) => {
    const path = paths[index];
    if (!active || path.locked || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (tool === "deleteVertex") return write(path, deleteVertex(path.shape, vertex));
    if (tool === "convertVertex") {
      // Clicking converts; dragging pulls out new handles, the out handle following the pointer.
      const start = toComp(e.clientX, e.clientY);
      const key = nextDragKey("convert");
      let moved = false;
      follow(
        e,
        (ev) => {
          const at = toComp(ev.clientX, ev.clientY);
          if (!moved && Math.hypot(at[0] - start[0], at[1] - start[1]) < 2 * px) return;
          moved = true;
          const out = deltaInPath(path.toComp, [at[0] - start[0], at[1] - start[1]]);
          const pulled = moveHandle(moveHandle(path.shape, vertex, "in", [-out[0], -out[1]], true), vertex, "out", out, true);
          write(path, pulled, key);
        },
        () => {
          if (!moved) write(path, convertVertex(path.shape, vertex));
          editor?.commit();
        },
      );
      setSelection({ path: index, vertices: [vertex] });
      return;
    }
    const current = selection?.path === index ? selection.vertices : [];
    const vertices = e.shiftKey ? (current.includes(vertex) ? current.filter((v) => v !== vertex) : [...current, vertex]) : current.includes(vertex) ? current : [vertex];
    setSelection({ path: index, vertices });
    if (vertices.includes(vertex)) dragVertices(e, index, vertices);
  };

  const onHandle = (e: PointerEvent, index: number, vertex: number, side: "in" | "out") => {
    const path = paths[index];
    if (!active || path.locked || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const key = nextDragKey("handle");
    const origin = path.shape.vertices[vertex];
    follow(
      e,
      (ev) => {
        const [x, y] = pointInPath(path.toComp, toComp(ev.clientX, ev.clientY));
        // Alt (or the Convert Vertex tool) moves one handle on its own, as in AE.
        write(path, moveHandle(path.shape, vertex, side, [x - origin[0], y - origin[1]], ev.altKey || tool === "convertVertex"), key);
      },
      () => editor?.commit(),
    );
  };

  const onOutline = (e: PointerEvent, index: number) => {
    const path = paths[index];
    if (!active || path.locked || e.button !== 0) return;
    const at = toComp(e.clientX, e.clientY);
    if (tool === "addVertex" || tool === "pen") {
      const hit = hitSegment(path, at, outline + 2 * px);
      if (!hit) return;
      e.stopPropagation();
      e.preventDefault();
      write(path, insertVertex(path.shape, hit[0], hit[1]));
      setSelection({ path: index, vertices: [hit[0] + 1] });
      return;
    }
    if (tool !== "selection") return;
    e.stopPropagation();
    e.preventDefault();
    const all = path.shape.vertices.map((_, i) => i);
    setSelection({ path: index, vertices: all });
    dragVertices(e, index, all);
  };

  return (
    <g className={`path-overlay ${active ? "active" : ""}`} strokeWidth={px}>
      {paths.map((path, index) => {
        const map = (x: number, y: number) => apply(path.toComp, x, y);
        const d = svgPath(path.shape, map);
        const color = `rgb(${path.color.map((c) => Math.round(c * 255)).join(" ")})`;
        const chosen = selection?.path === index ? selection.vertices : [];
        const size = 5 * px;
        return (
          <g key={`${path.prop.matchName}:${index}`} style={{ color }}>
            <path d={d} stroke="currentColor" fill="none" className="path-line" />
            {active && !path.locked && (
              <>
                <path d={d} className="path-hit" strokeWidth={outline * 2} onPointerDown={(e) => onOutline(e, index)} />
                {chosen.map((vertex) => {
                  const v = path.shape.vertices[vertex];
                  if (!v) return null;
                  const [vx, vy] = map(v[0], v[1]);
                  return (["in", "out"] as const).map((side) => {
                    const t = (side === "in" ? path.shape.inTangents : path.shape.outTangents)[vertex];
                    if (!t || Math.hypot(t[0], t[1]) < 1e-6) return null;
                    const [hx, hy] = map(v[0] + t[0], v[1] + t[1]);
                    return (
                      <g key={`${vertex}${side}`} className="path-handle">
                        <line x1={vx} y1={vy} x2={hx} y2={hy} stroke="currentColor" />
                        <circle
                          cx={hx}
                          cy={hy}
                          r={3 * px}
                          data-path-handle={side}
                          onPointerDown={(e) => onHandle(e, index, vertex, side)}
                        />
                        {coarse && (
                          <circle className="path-touch" cx={hx} cy={hy} r={(TOUCH_TARGET_PIXELS / 2) * px} onPointerDown={(e) => onHandle(e, index, vertex, side)} />
                        )}
                      </g>
                    );
                  });
                })}
                {path.shape.vertices.map((v, vertex) => {
                  const [x, y] = map(v[0], v[1]);
                  const touch = TOUCH_TARGET_PIXELS * px;
                  return (
                    <g key={vertex}>
                      <rect
                        className={`path-vertex ${chosen.includes(vertex) ? "selected" : ""}`}
                        x={x - size / 2 / aspect}
                        y={y - size / 2}
                        width={size / aspect}
                        height={size}
                        data-path-vertex={vertex}
                        onPointerDown={(e) => onVertex(e, index, vertex)}
                      />
                      {coarse && (
                        <rect
                          className="path-touch"
                          x={x - touch / 2 / aspect}
                          y={y - touch / 2}
                          width={touch / aspect}
                          height={touch}
                          data-path-touch-vertex={vertex}
                          onPointerDown={(e) => onVertex(e, index, vertex)}
                        />
                      )}
                    </g>
                  );
                })}
              </>
            )}
          </g>
        );
      })}
    </g>
  );
}
