import { useEffect, useId, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { CompItem, Layer, Project, Shape } from "../aep/model.ts";
import { apply, invert, layerAffine, valueAt, type Matrix } from "./animate.ts";
import { colorCss, labelColor, timecode } from "./format.ts";
import { setHover } from "./hover.ts";
import { Icon, type IconName } from "./icons.tsx";
import { findGroup, findProperty, layerHasVideo, sourceItem } from "./properties.ts";
import { Dropdown } from "./values.tsx";

const MASK_ADD = 6813;
const MASK_SUBTRACT = 6814;
const ZOOMS = [0.015, 0.03, 0.06, 0.125, 0.25, 0.333, 0.5, 1, 2, 4, 8];

function opacityAt(layer: Layer, t: number): number {
  const prop = findProperty(findGroup(layer.properties, "ADBE Transform Group")?.children ?? [], "ADBE Opacity");
  const value = prop ? valueAt(prop, t, layer) : 100;
  return (typeof value === "number" ? value : 100) / 100;
}

function shapePath(shape: Shape): string {
  const v = shape.vertices;
  if (v.length === 0) return "";
  const p = (pt: number[] | undefined) => `${pt?.[0] ?? 0} ${pt?.[1] ?? 0}`;
  const add = (a: number[] | undefined, b: number[] | undefined) => [(a?.[0] ?? 0) + (b?.[0] ?? 0), (a?.[1] ?? 0) + (b?.[1] ?? 0)];
  let d = `M${p(v[0])}`;
  const segments = shape.closed ? v.length : v.length - 1;
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % v.length;
    d += `C${p(add(v[i], shape.outTangents[i]))} ${p(add(v[j], shape.inTangents[j]))} ${p(v[j])}`;
  }
  return shape.closed ? `${d}Z` : d;
}

interface MaskShape {
  d: string;
  mode: number;
  inverted: boolean;
}

interface Drawn {
  layer: Layer;
  matrix: Matrix;
  rgb: [number, number, number];
  opacity: number;
  masks: MaskShape[];
}

function layerMasks(layer: Layer, t: number): MaskShape[] {
  const parade = findGroup(layer.properties, "ADBE Mask Parade");
  const out: MaskShape[] = [];
  for (const atom of parade?.children ?? []) {
    if (atom.kind !== "group" || !atom.mask || !atom.enabled) continue;
    if (atom.mask.maskMode !== MASK_ADD && atom.mask.maskMode !== MASK_SUBTRACT) continue;
    const shapeProp = findProperty(atom.children, "ADBE Mask Shape");
    const value = shapeProp ? valueAt(shapeProp, t, layer) : null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push({ d: shapePath(value), mode: atom.mask.maskMode, inverted: atom.mask.inverted });
    }
  }
  return out;
}

/** Visible 2D solid layers at time t, bottom first. 3D layers, footage and precomps are not drawn. */
function drawnLayers(project: Project, comp: CompItem, t: number): Drawn[] {
  const soloing = comp.layers.some((l) => l.solo && layerHasVideo(l, project));
  const out: Drawn[] = [];
  for (let i = comp.layers.length - 1; i >= 0; i--) {
    const layer = comp.layers[i];
    if (!layer || !layer.enabled || layer.adjustmentLayer || layer.nullLayer || layer.threeDLayer) continue;
    if (soloing && !layer.solo) continue;
    if (t < layer.inPoint || t >= layer.outPoint) continue;
    const source = sourceItem(layer, project);
    if (source?.kind !== "footage" || source.mainSource.sourceType !== "SolidSource") continue;
    const matrix = layerAffine(layer, comp, t);
    if (!matrix) continue;
    out.push({ layer, matrix, rgb: source.mainSource.color, opacity: opacityAt(layer, t), masks: layerMasks(layer, t) });
  }
  return out;
}

const svgMatrix = (m: Matrix) => `matrix(${m.join(" ")})`;

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
  const uid = useId().replace(/:/g, "");

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
  const drawn = useMemo(() => drawnLayers(project, comp, time), [project, comp, time]);
  const selected = comp.layers.find((l) => l.id === selectedLayerId);
  const selectedMatrix = selected && !selected.threeDLayer && selected.width > 0 ? layerAffine(selected, comp, time) : undefined;

  const hit = (x: number, y: number): Drawn | undefined => {
    for (let i = drawn.length - 1; i >= 0; i--) {
      const d = drawn[i];
      const inv = d ? invert(d.matrix) : undefined;
      if (!d || !inv) continue;
      const [lx, ly] = apply(inv, x, y);
      if (lx >= 0 && ly >= 0 && lx <= d.layer.width && ly <= d.layer.height && d.opacity > 0) return d;
    }
    return undefined;
  };
  const toComp = (e: MouseEvent<SVGSVGElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - rect.left) / (rect.width || 1)) * comp.width, ((e.clientY - rect.top) / (rect.height || 1)) * comp.height];
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const [x, y] = toComp(e);
    const d = hit(x, y);
    const rgba: [number, number, number, number] = d
      ? [Math.round(d.rgb[0] * 255), Math.round(d.rgb[1] * 255), Math.round(d.rgb[2] * 255), Math.round(d.opacity * 255)]
      : [0, 0, 0, 0];
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
            <svg
              className="comp-svg"
              viewBox={`0 0 ${comp.width} ${comp.height}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${comp.name}, ${comp.width} x ${comp.height}, at ${timecode(time + comp.displayStartTime, comp.frameRate)}`}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(undefined)}
              onClick={(e) => onSelectLayer(hit(...toComp(e))?.layer.id)}
            >
              <defs>
                {drawn
                  .filter((d) => d.masks.length > 0)
                  .map((d) => {
                    const first = d.masks[0];
                    const startsVisible = first ? first.mode !== MASK_ADD : true;
                    const rect = `M0 0H${d.layer.width}V${d.layer.height}H0Z`;
                    return (
                      <mask key={d.layer.id} id={`${uid}m${d.layer.id}`} maskUnits="userSpaceOnUse" x={-1e5} y={-1e5} width={2e5} height={2e5}>
                        <rect x={-1e5} y={-1e5} width={2e5} height={2e5} fill={startsVisible ? "#fff" : "#000"} />
                        {d.masks.map((m, i) => (
                          <path
                            key={i}
                            d={m.inverted ? `${rect}${m.d}` : m.d}
                            fillRule="evenodd"
                            fill={m.mode === MASK_ADD ? "#fff" : "#000"}
                          />
                        ))}
                      </mask>
                    );
                  })}
              </defs>
              {drawn.map((d) => (
                <rect
                  key={d.layer.id}
                  width={d.layer.width}
                  height={d.layer.height}
                  transform={svgMatrix(d.matrix)}
                  fill={colorCss(d.rgb)}
                  opacity={d.opacity}
                  mask={d.masks.length > 0 ? `url(#${uid}m${d.layer.id})` : undefined}
                />
              ))}
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
