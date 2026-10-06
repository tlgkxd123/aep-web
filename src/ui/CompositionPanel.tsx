import { useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { CompItem, Layer, Project } from "../aep/model.ts";
import type { Target } from "../render/gl.ts";
import { Renderer } from "../render/renderer.ts";
import { apply, invert, layerAffine, type Matrix } from "./animate.ts";
import { openContextMenu } from "./ContextMenu.tsx";
import { AppActionsContext, layerMenu, viewerMenu } from "./contextMenus.ts";
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

interface RenderState {
  renderer: Renderer;
  target?: Target;
}

/**
 * Renders `comp` at `time` into the canvas with the WebGL compositor, one
 * render per animation frame however fast `time` changes. Returns the
 * renderer state (for pixel readback) and what the renderer skipped.
 */
function useCompRender(canvas: HTMLCanvasElement | null, project: Project, comp: CompItem, time: number) {
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
  }, [canvas, project, comp, time, footageVersion]);
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
  const actions = useContext(AppActionsContext);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [grid, setGrid] = useState(false);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const render = useCompRender(canvas, project, comp, time);
  const missing = missingFootage(project, comp).length;

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
  const pickable = useMemo(() => pickableLayers(project, comp, time), [project, comp, time]);
  const selected = comp.layers.find((l) => l.id === selectedLayerId);
  const selectedMatrix = selected && !selected.threeDLayer && selected.width > 0 ? layerAffine(selected, comp, time) : undefined;

  const hit = (x: number, y: number): Pickable | undefined => {
    for (let i = pickable.length - 1; i >= 0; i--) {
      const d = pickable[i];
      const inv = d ? invert(d.matrix) : undefined;
      if (!d || !inv) continue;
      const [lx, ly] = apply(inv, x, y);
      if (lx >= 0 && ly >= 0 && lx <= d.layer.width && ly <= d.layer.height) return d;
    }
    return undefined;
  };
  const toComp = (e: MouseEvent<SVGSVGElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - rect.left) / (rect.width || 1)) * comp.width, ((e.clientY - rect.top) / (rect.height || 1)) * comp.height];
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const [x, y] = toComp(e);
    const { renderer, target } = render.state.current ?? {};
    const inside = x >= 0 && y >= 0 && x < comp.width && y < comp.height;
    const rgba: [number, number, number, number] =
      renderer && target && inside ? renderer.readPixel(target, x, y) : [0, 0, 0, 0];
    setHover({ x: Math.round(x), y: Math.round(y), rgba });
  };

  const handle = (x: number, y: number, key: string) => {
    const w = 5 / (scale * comp.pixelAspect);
    const h = 5 / scale;
    return <rect key={key} x={x - w / 2} y={y - h / 2} width={w} height={h} className="sel-handle" />;
  };

  const resolution = RESOLUTIONS[comp.resolutionFactor[0]] ?? "Custom";
  const pct = `${Number((scale * 100).toFixed(1))}%`;

  return (
    <div className="comp-panel">
      <div className="comp-crumbs">
        <Icon name="lock" size={12} className="dim" />
        <span className="crumb">{comp.name}</span>
      </div>
      <div className="viewer" ref={viewerRef}>
        <div className="pasteboard">
          <div
            className={`comp-frame ${grid ? "transparency" : ""}`}
            style={{ width: frameW * scale, height: comp.height * scale, background: grid ? undefined : colorCss(comp.bgColor) }}
          >
            <canvas ref={setCanvas} className={`comp-canvas ${scale > 1 ? "pixelated" : ""}`} aria-hidden="true" />
            <svg
              className="comp-svg"
              viewBox={`0 0 ${comp.width} ${comp.height}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${comp.name}, ${comp.width} x ${comp.height}, at ${timecode(time + comp.displayStartTime, comp.frameRate)}`}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(undefined)}
              onClick={(e) => onSelectLayer(hit(...toComp(e))?.layer.id)}
              onContextMenu={(e) => {
                if (!actions) return;
                // Like AE: right-clicking a layer selects it and shows the layer menu; elsewhere the comp menu.
                const layer = hit(...toComp(e))?.layer;
                if (layer) onSelectLayer(layer.id);
                openContextMenu(e, layer ? layerMenu(project, comp, layer, actions) : viewerMenu(comp, actions));
              }}
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
                        return handle(x, y, `${fx}-${fy}`);
                      }),
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
