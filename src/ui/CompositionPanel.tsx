import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from "react";
import type { CompItem, Layer, Project } from "../aep/model.ts";
import { addLayer } from "../edit/layers.ts";
import { anchorInComp, moveLayers, panBehind, rotateByDrag, scaleByHandle, type Handle } from "../edit/transform-ops.ts";
import type { Target } from "../render/gl.ts";
import { Renderer } from "../render/renderer.ts";
import { apply, invert, layerAffine, type Matrix } from "./animate.ts";
import { attempt, ITEM_MIME, nextDragKey, useEditing } from "./editing.tsx";
import { colorCss, labelColor, timecode } from "./format.ts";
import { setHover } from "./hover.ts";
import { Icon, type IconName } from "./icons.tsx";
import { locateFootageFolder, missingFootage, useFootageVersion } from "./LocateFootage.tsx";
import { layerHasVideo } from "./properties.ts";
import { Dropdown } from "./values.tsx";

const ZOOMS = [0.015, 0.03, 0.06, 0.125, 0.25, 0.333, 0.5, 1, 2, 4, 8];

interface Pickable {
  layer: Layer;
  matrix: Matrix;
}

/** Visible 2D layers with video at time t, bottom first, for click selection. */
function pickableLayers(project: Project, comp: CompItem, t: number): Pickable[] {
  const soloing = comp.layers.some((l) => l.solo && layerHasVideo(l, project));
  const out: Pickable[] = [];
  for (let i = comp.layers.length - 1; i >= 0; i--) {
    const layer = comp.layers[i];
    if (!layer || !layer.enabled || layer.nullLayer || layer.threeDLayer || !layerHasVideo(layer, project)) continue;
    if (soloing && !layer.solo) continue;
    if (t < layer.inPoint || t >= layer.outPoint || layer.width <= 0) continue;
    const matrix = layerAffine(layer, comp, t);
    if (matrix) out.push({ layer, matrix });
  }
  return out;
}

function safeAnchor(comp: CompItem, layer: Layer, time: number): [number, number] | undefined {
  try {
    return anchorInComp(comp, layer, time);
  } catch {
    return undefined;
  }
}

const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];

/** The resize cursor for a handle pointing along (dx, dy) on screen, so rotated layers get turned arrows. */
function resizeCursor(dx: number, dy: number): string {
  const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360 + 22.5) % 180;
  return RESIZE_CURSORS[Math.floor(angle / 45) % 4] ?? "move";
}

interface RenderState {
  renderer: Renderer;
  target?: Target;
}

/**
 * Renders `comp` at `time` into the canvas with the WebGL compositor, one
 * render per animation frame however fast `time` changes. Returns the
 * renderer state (for pixel readback) and what the renderer skipped.
 */
function useCompRender(canvas: HTMLCanvasElement | null, project: Project, comp: CompItem, time: number, revision = 0) {
  const state = useRef<RenderState | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  // Footage decodes asynchronously; render again when its frames arrive.
  const footageVersion = useFootageVersion();
  useEffect(() => {
    // jsdom and browsers without WebGL2 keep the plain comp frame.
    if (!canvas || typeof WebGL2RenderingContext === "undefined") return;
    const frame = requestAnimationFrame(() => {
      try {
        state.current ??= { renderer: new Renderer(canvas) };
        const { renderer } = state.current;
        if (canvas.width !== comp.width || canvas.height !== comp.height) {
          canvas.width = comp.width;
          canvas.height = comp.height;
        }
        if (state.current.target) renderer.release(state.current.target);
        const target = renderer.render(project, comp, time);
        renderer.present(target, comp);
        state.current.target = target;
        setNotes(renderer.lastWarnings);
        setError(undefined);
      } catch (e) {
        setError((e as Error).message);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [canvas, project, comp, time, footageVersion, revision]);
  return { state, notes, error };
}

function ViewerButton({ icon, title, on, onClick }: { icon: IconName; title: string; on?: boolean; onClick?: () => void }) {
  if (!onClick) {
    return (
      <span className="vb-btn" title={title} aria-hidden="true">
        <Icon name={icon} size={14} />
      </span>
    );
  }
  return (
    <button type="button" className={`vb-btn ${on ? "on" : ""}`} title={title} aria-label={title} aria-pressed={on} onClick={onClick}>
      <Icon name={icon} size={14} />
    </button>
  );
}

const RESOLUTIONS: Record<number, string> = { 1: "Full", 2: "Half", 3: "Third", 4: "Quarter" };

/** The Composition viewer: the comp frame over the pasteboard, flat solids, the selected layer's box and the viewer bar. */
export function CompositionPanel({
  project,
  comp,
  time,
  selectedLayerId,
  onSelectLayer,
}: {
  project: Project;
  comp: CompItem;
  time: number;
  selectedLayerId: number | undefined;
  onSelectLayer: (id: number | undefined) => void;
}) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [grid, setGrid] = useState(false);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const editing = useEditing();
  const { editor, revision, tool } = editing;
  const render = useCompRender(canvas, project, comp, time, revision);
  const missing = missingFootage(project, comp).length;
  const svgRef = useRef<SVGSVGElement>(null);
  const [itemOver, setItemOver] = useState(false);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewer({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const frameW = comp.width * comp.pixelAspect;
  const fit =
    viewer.width && viewer.height ? Math.min(1, (viewer.width - 40) / frameW, (viewer.height - 40) / comp.height) : 0.33;
  const scale = zoom === "fit" ? Math.max(0.01, fit) : zoom;
  // `revision` changes after every edit; the layer objects behind `comp` are rebuilt then.
  const pickable = useMemo(() => pickableLayers(project, comp, time), [project, comp, time, revision]);
  const selected = comp.layers.find((l) => l.id === selectedLayerId);
  const selectedMatrix = selected && !selected.threeDLayer && selected.width > 0 ? layerAffine(selected, comp, time) : undefined;
  const selectedAnchor = selected && selectedMatrix ? safeAnchor(comp, selected, time) : undefined;

  const hit = (x: number, y: number): Pickable | undefined => {
    for (let i = pickable.length - 1; i >= 0; i--) {
      const d = pickable[i];
      const inv = d ? invert(d.matrix) : undefined;
      if (!d || !inv || d.layer.locked) continue;
      const [lx, ly] = apply(inv, x, y);
      if (lx >= 0 && ly >= 0 && lx <= d.layer.width && ly <= d.layer.height) return d;
    }
    return undefined;
  };
  const clientToComp = (clientX: number, clientY: number, rect: DOMRect): [number, number] => [
    ((clientX - rect.left) / (rect.width || 1)) * comp.width,
    ((clientY - rect.top) / (rect.height || 1)) * comp.height,
  ];
  const toComp = (e: MouseEvent<SVGSVGElement>): [number, number] => clientToComp(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());

  /**
   * Selection tool: a handle scales the selected layer, a layer is selected
   * and moved. Rotation and Pan Behind tools: the layer under the pointer, or
   * else the selected one, is rotated or has its anchor point moved. Every
   * pointer move re-applies the whole drag from its start under one coalesce
   * key, so the drag previews live and undoes in one step.
   */
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== undefined && e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const start = clientToComp(e.clientX, e.clientY, rect);
    const grip = (e.target as Element).closest?.("[data-handle]")?.getAttribute("data-handle");
    const picked = hit(...start)?.layer;
    let kind: "move" | "scale" | "rotation" | "anchor" | undefined;
    let layer: Layer | undefined;
    if (tool === "selection" && grip && selected && !selected.locked) {
      kind = "scale";
      layer = selected;
    } else if (tool === "rotation" || tool === "anchor") {
      layer = picked ?? (selected && !selected.locked ? selected : undefined);
      if (picked && picked.id !== selectedLayerId) onSelectLayer(picked.id);
      kind = layer ? (tool === "rotation" ? "rotation" : "anchor") : undefined;
    } else {
      onSelectLayer(picked?.id);
      if (tool === "selection" && picked) {
        kind = "move";
        layer = picked;
      }
    }
    if (!editor || !kind || !layer) return;
    e.preventDefault();
    const handle = grip ? (grip.split(",").map(Number) as Handle) : ([0, 0] as Handle);
    const key = nextDragKey(kind);
    const id = layer.id;
    const drag = kind;
    const move = (ev: globalThis.PointerEvent | globalThis.MouseEvent) => {
      const at = clientToComp(ev.clientX, ev.clientY, rect);
      const target = comp.layers.find((l) => l.id === id);
      if (!target || !at.every(Number.isFinite)) return;
      const delta: [number, number] = [at[0] - start[0], at[1] - start[1]];
      attempt(editing, () => {
        if (drag === "move") moveLayers(editor, comp, [target], delta, time, { coalesce: key, constrain: ev.shiftKey });
        else if (drag === "scale") scaleByHandle(editor, comp, target, handle, start, at, time, { coalesce: key, proportional: ev.shiftKey });
        else if (drag === "rotation") rotateByDrag(editor, comp, target, start, at, time, { coalesce: key, snap: ev.shiftKey });
        else panBehind(editor, comp, target, delta, time, { coalesce: key, anchorOnly: ev.altKey });
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      editor.commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dragsItem = (e: DragEvent) => !!editor && Array.from(e.dataTransfer?.types ?? []).includes(ITEM_MIME);
  const itemDrop = {
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!dragsItem(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setItemOver(true);
    },
    onDragLeave: () => setItemOver(false),
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      setItemOver(false);
      if (!dragsItem(e) || !editor) return;
      e.preventDefault();
      e.stopPropagation();
      const itemId = Number(e.dataTransfer.getData(ITEM_MIME));
      const rect = svgRef.current?.getBoundingClientRect();
      const at = rect ? clientToComp(e.clientX, e.clientY, rect) : undefined;
      const position = at?.every(Number.isFinite) ? at : undefined;
      attempt(editing, () => onSelectLayer(addLayer(editor, comp, { kind: "item", itemId }, { position })));
    },
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const [x, y] = toComp(e);
    const { renderer, target } = render.state.current ?? {};
    const inside = x >= 0 && y >= 0 && x < comp.width && y < comp.height;
    const rgba: [number, number, number, number] =
      renderer && target && inside ? renderer.readPixel(target, x, y) : [0, 0, 0, 0];
    setHover({ x: Math.round(x), y: Math.round(y), rgba });
  };

  const handle = (x: number, y: number, key: string, grip?: { handle: string; cursor: string }) => {
    const w = 5 / (scale * comp.pixelAspect);
    const h = 5 / scale;
    const box = <rect key={key} x={x - w / 2} y={y - h / 2} width={w} height={h} className="sel-handle" />;
    if (!grip || !editor || tool !== "selection") return box;
    return (
      <g key={key} data-handle={grip.handle} style={{ cursor: grip.cursor }}>
        {box}
        <rect x={x - w * 1.3} y={y - h * 1.3} width={w * 2.6} height={h * 2.6} className="sel-grip" />
      </g>
    );
  };

  const resolution = RESOLUTIONS[comp.resolutionFactor[0]] ?? "Custom";
  const pct = `${Number((scale * 100).toFixed(1))}%`;

  return (
    <div className="comp-panel">
      <div className="comp-crumbs">
        <Icon name="lock" size={12} className="dim" />
        <span className="crumb">{comp.name}</span>
      </div>
      <div className={`viewer ${itemOver ? "item-over" : ""}`} ref={viewerRef} {...itemDrop}>
        <div className="pasteboard">
          <div
            className={`comp-frame ${grid ? "transparency" : ""}`}
            style={{ width: frameW * scale, height: comp.height * scale, background: grid ? undefined : colorCss(comp.bgColor) }}
          >
            <canvas ref={setCanvas} className={`comp-canvas ${scale > 1 ? "pixelated" : ""}`} aria-hidden="true" />
            <svg
              ref={svgRef}
              className={`comp-svg ${editor ? `tool-${tool}` : ""}`}
              viewBox={`0 0 ${comp.width} ${comp.height}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${comp.name}, ${comp.width} x ${comp.height}, at ${timecode(time + comp.displayStartTime, comp.frameRate)}`}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(undefined)}
              onPointerDown={onPointerDown}
            >
              {selected && selectedMatrix && (
                <g className="sel-box" style={{ color: labelColor(selected.label) }}>
                  <polygon
                    points={[
                      apply(selectedMatrix, 0, 0),
                      apply(selectedMatrix, selected.width, 0),
                      apply(selectedMatrix, selected.width, selected.height),
                      apply(selectedMatrix, 0, selected.height),
                    ]
                      .map((p) => p.join(","))
                      .join(" ")}
                  />
                  {[0, 0.5, 1].flatMap((fx) =>
                    [0, 0.5, 1]
                      .filter((fy) => fx !== 0.5 || fy !== 0.5)
                      .map((fy) => {
                        const [x, y] = apply(selectedMatrix, selected.width * fx, selected.height * fy);
                        const [cx, cy] = apply(selectedMatrix, selected.width / 2, selected.height / 2);
                        const cursor = resizeCursor((x - cx) * comp.pixelAspect, y - cy);
                        return handle(x, y, `${fx}-${fy}`, { handle: `${fx * 2 - 1},${fy * 2 - 1}`, cursor });
                      }),
                  )}
                  {editor && selectedAnchor && (
                    <g
                      className="sel-anchor"
                      transform={`translate(${selectedAnchor[0]} ${selectedAnchor[1]}) scale(${1 / (scale * comp.pixelAspect)} ${1 / scale})`}
                      aria-hidden="true"
                    >
                      <circle r={4.5} />
                      <path d="M-9 0h4.5M4.5 0H9M0-9v4.5M0 4.5V9" />
                    </g>
                  )}
                </g>
              )}
            </svg>
          </div>
        </div>
        {(render.error || render.notes.length > 0 || missing > 0) && (
          <div className="render-notes" role="status">
            {missing > 0 && (
              <div>
                {`${missing} footage ${missing === 1 ? "item is" : "items are"} missing.`}
                <button type="button" className="locate-link" onClick={() => void locateFootageFolder()}>
                  Locate Footage…
                </button>
              </div>
            )}
            {render.error ? `Render failed: ${render.error}` : render.notes.length > 0 && `Renderer: ${render.notes.join("; ")}`}
          </div>
        )}
      </div>
      <div className="viewer-bar">
        <ViewerButton icon="alwaysPreview" title="Always Preview This View" />
        <label className="vb-select" title="Magnification ratio popup">
          <select
            aria-label="Magnification"
            value={zoom === "fit" ? "fit" : String(zoom)}
            onChange={(e) => setZoom(e.target.value === "fit" ? "fit" : Number(e.target.value))}
          >
            <option value="fit">{zoom === "fit" ? `(${pct})` : "Fit up to 100%"}</option>
            {ZOOMS.map((z) => (
              <option key={z} value={String(z)}>
                {`${Number((z * 100).toFixed(1))}%`}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" size={10} />
        </label>
        <Dropdown text={resolution} label="Resolution/Down Sample Factor" width={64} />
        <ViewerButton icon="fastPreview" title="Fast Previews" />
        <ViewerButton icon="transparency" title="Toggle Transparency Grid" on={grid} onClick={() => setGrid(!grid)} />
        <ViewerButton icon="maskPath" title="Toggle Mask and Shape Path Visibility" />
        <ViewerButton icon="roi" title="Region of Interest" />
        <ViewerButton icon="grid" title="Choose grid and guide options" />
        <ViewerButton icon="channels" title="Show Channel and Color Management Settings" />
        <span className="vb-time" title="Current time">
          {timecode(time + comp.displayStartTime, comp.frameRate)}
        </span>
        <ViewerButton icon="snapshot" title="Take Snapshot" />
        <ViewerButton icon="showSnapshot" title="Show Snapshot" />
        <ViewerButton icon="exposure" title="Reset Exposure" />
        <span className="vb-exposure" title="Adjust Exposure">+0.0</span>
        <span className="vb-spacer" />
        <span className="vb-label">Classic 3D</span>
        <Dropdown text="Active Camera" label="3D View Popup" width={96} />
        <Dropdown text="1 View" label="Select view layout" width={60} />
      </div>
    </div>
  );
}
