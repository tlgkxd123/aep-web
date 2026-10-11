import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type MouseEvent, type PointerEvent } from "react";
import type { CompItem, Layer, Project } from "../aep/model.ts";
import { addLayer } from "../edit/layers.ts";
import { anchorInComp, moveLayers, panBehind, rotateByDrag, scaleByHandle, type Handle } from "../edit/transform-ops.ts";
import { frameIndex } from "../playback/clock.ts";
import { usePlaying } from "../playback/playhead.ts";
import { useViewer } from "../playback/useViewer.ts";
import { autoResolution, fastPreviews as fastPreviewSetting, isIntegratedGpu, viewerFactor, viewerZooms } from "../playback/viewer.ts";
import { apply, invert, layerAffine, type Matrix } from "./animate.ts";
import { openContextMenu, openMenuBelow, type MenuEntries } from "./ContextMenu.tsx";
import { AppActionsContext, layerMenu, viewerMenu } from "./contextMenus.ts";
import { TimeDisplay } from "./TimelinePanel.tsx";
import { ChannelFilters, channelFilter, Guides, MaskPaths, snapDelta, snapTargets, type Channel, type GuideOptions } from "./viewerOverlays.tsx";
import { attempt, EFFECT_MIME, ITEM_MIME, nextDragKey, useEditing } from "./editing.tsx";
import { colorCss, labelColor, timecode } from "./format.ts";
import { setHover } from "./hover.ts";
import { Icon, type IconName } from "./icons.tsx";
import { locateFootageFolder, missingFootage } from "./LocateFootage.tsx";
import { followPointer } from "./pointer.ts";
import { layerHasVideo } from "./properties.ts";
import { Dropdown } from "./values.tsx";
import { viewerControls } from "./viewerControls.ts";

const ZOOMS = [0.015, 0.03, 0.06, 0.125, 0.25, 0.333, 0.5, 1, 2, 4, 8];
/** Screen pixels within which a dragged layer snaps. */
const SNAP_PIXELS = 8;
/** Kept when the note about rendering on a built-in GPU is dismissed. */
const GPU_HINT_KEY = "aep-web.integratedGpuHint";

function storedFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "dismissed";
  } catch {
    return false;
  }
}

function storeFlag(key: string): void {
  try {
    globalThis.localStorage?.setItem(key, "dismissed");
  } catch {
    // Shown again next session where storage is unavailable.
  }
}

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

function ViewerButton({
  icon,
  title,
  on,
  onClick,
  onMenu,
}: {
  icon: IconName;
  title: string;
  on?: boolean;
  onClick?: () => void;
  /** Opens these entries under the button instead of acting directly. */
  onMenu?: () => MenuEntries;
}) {
  if (onMenu) {
    return (
      <button
        type="button"
        className={`vb-btn ${on ? "on" : ""}`}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        onClick={(e) => openMenuBelow(e.currentTarget, onMenu())}
      >
        <Icon name={icon} size={14} />
      </button>
    );
  }
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
  onTime,
}: {
  project: Project;
  comp: CompItem;
  time: number;
  selectedLayerId: number | undefined;
  onSelectLayer: (id: number | undefined) => void;
  onTime?: (t: number) => void;
}) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState({ width: 0, height: 0 });
  const actions = useContext(AppActionsContext);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const [grid, setGrid] = useState(false);
  const [showMasks, setShowMasks] = useState(true);
  const [guides, setGuides] = useState<GuideOptions>({ safe: false, proportional: false, grid: false });
  const [layerControls, setLayerControls] = useState(true);
  const [channel, setChannel] = useState<Channel>("rgb");
  const [exposure, setExposure] = useState(0);
  const [snapshot, setSnapshot] = useState<string>();
  const [showingSnapshot, setShowingSnapshot] = useState(false);
  const [roiMode, setRoiMode] = useState(false);
  const [roi, setRoi] = useState<[number, number, number, number]>();
  const fastPreviews = useSyncExternalStore(fastPreviewSetting.subscribe, () => fastPreviewSetting.adaptive);
  const [gpuHintHidden, setGpuHintHidden] = useState(() => storedFlag(GPU_HINT_KEY));
  const [alwaysPreview, setAlwaysPreview] = useState(false);
  const spaceDown = useRef(false);
  /** Stops the drag one pointer started, when a second finger turns the gesture into a pinch. */
  const drag = useRef<(() => void) | null>(null);
  /** Fingers on the viewer, and the pinch the first two make. */
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ ids: number[]; distance: number; mid: [number, number]; scale: number; offset: [number, number] } | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const editing = useEditing();
  const { editor, revision, tool } = editing;
  const compFactor = Math.max(1, comp.resolutionFactor[0] || 1);
  const autoRes = useSyncExternalStore(autoResolution.subscribe, () => autoResolution.on);
  // Layer boxes would trail the picture during playback; they come back where it stops.
  const playing = usePlaying(comp.id);

  // Holding Space pans with the Hand tool, as in AE.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== "Space" || (e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
      spaceDown.current = e.type === "keydown";
    };
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
    };
  }, []);
  const missing = missingFootage(project, comp).length;
  const svgRef = useRef<SVGSVGElement>(null);
  const [itemOver, setItemOver] = useState(false);
  /** The layer an effect being dragged over the viewer would apply to. */
  const [effectDrop, setEffectDrop] = useState<number>();

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
  useEffect(() => viewerZooms.set(comp.id, scale), [comp.id, scale]);
  const downsample = viewerFactor(compFactor, scale, autoRes);
  const render = useViewer(canvas, project, comp, time, downsample);
  const gpu = render.engine.current?.gpu;
  const integratedGpu = gpu && !gpuHintHidden && isIntegratedGpu(gpu) ? gpu : null;
  // A fitted view stays centred; panning applies to explicit zoom levels.
  const offset: [number, number] = zoom === "fit" ? [0, 0] : pan;
  const live = useRef({ scale, offset });
  live.current = { scale, offset };

  // Two fingers pinch to zoom about their midpoint and pan as it moves; the comp point under it stays under it.
  useEffect(() => {
    const centre = (): [number, number] => {
      const r = viewerRef.current?.getBoundingClientRect();
      return r ? [r.left + r.width / 2, r.top + r.height / 2] : [0, 0];
    };
    const move = (e: globalThis.PointerEvent) => {
      if (!touches.current.has(e.pointerId)) return;
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = pinch.current;
      const a = p && touches.current.get(p.ids[0]);
      const b = p && touches.current.get(p.ids[1]);
      if (!p || !a || !b) return;
      const [cx, cy] = centre();
      const next = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], (p.scale * Math.hypot(b.x - a.x, b.y - a.y)) / p.distance));
      const k = next / p.scale;
      const mid = [(a.x + b.x) / 2 - cx, (a.y + b.y) / 2 - cy];
      setZoom(next);
      setPan([mid[0] - (p.mid[0] - p.offset[0]) * k, mid[1] - (p.mid[1] - p.offset[1]) * k]);
    };
    const end = (e: globalThis.PointerEvent) => {
      if (!touches.current.delete(e.pointerId)) return;
      // The fingers left after a pinch do nothing until they lift.
      if (pinch.current?.ids.includes(e.pointerId)) pinch.current = { ...pinch.current, ids: [] };
      if (!touches.current.size) pinch.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);
  /** Counts a finger landing on the viewer: the second starts a pinch instead of a drag of its own. */
  const onViewerPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current) {
      e.stopPropagation();
      return;
    }
    if (touches.current.size < 2) return;
    e.stopPropagation();
    drag.current?.();
    drag.current = null;
    const [[ida, a], [idb, b]] = [...touches.current];
    const r = viewerRef.current!.getBoundingClientRect();
    pinch.current = {
      ids: [ida, idb],
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      mid: [(a.x + b.x) / 2 - (r.left + r.width / 2), (a.y + b.y) / 2 - (r.top + r.height / 2)],
      scale: live.current.scale,
      offset: live.current.offset,
    };
  };

  /** Zooms to `next`, keeping the comp point under (clientX, clientY) where it is, like AE's Zoom tool and wheel. */
  const zoomAt = (next: number, clientX?: number, clientY?: number) => {
    const el = viewerRef.current;
    const clamped = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], next));
    if (el && clientX !== undefined && clientY !== undefined) {
      const r = el.getBoundingClientRect();
      const cx = clientX - (r.left + r.width / 2);
      const cy = clientY - (r.top + r.height / 2);
      const k = clamped / scale;
      setPan([cx - (cx - offset[0]) * k, cy - (cy - offset[1]) * k]);
    } else if (zoom === "fit") setPan([0, 0]);
    setZoom(clamped);
  };
  const zoomStep = (dir: 1 | -1) => {
    const steps = dir > 0 ? ZOOMS.filter((z) => z > scale + 1e-6) : ZOOMS.filter((z) => z < scale - 1e-6).reverse();
    return steps[0] ?? scale;
  };
  const latestZoom = useRef({ zoomAt, zoomStep });
  latestZoom.current = { zoomAt, zoomStep };

  // The wheel zooms around the cursor; the listener is not passive so the page does not scroll.
  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const { zoomAt: at, zoomStep: step } = latestZoom.current;
      at(step(e.deltaY < 0 ? 1 : -1), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  useEffect(
    () =>
      viewerControls.handle((command) => {
        const { zoomAt: at, zoomStep: step } = latestZoom.current;
        if (command === "zoom-in" || command === "zoom-out") at(step(command === "zoom-in" ? 1 : -1));
        else if (command === "toggle-grid") setGuides((g) => ({ ...g, grid: !g.grid }));
        else setLayerControls((on) => !on);
      }),
    [],
  );
  useEffect(() => viewerControls.publish({ grid: guides.grid, layerControls }), [guides.grid, layerControls]);

  /** Pans the view by dragging (Hand tool, Space, middle button, or a finger on no layer); a fitted view stays fitted until it moves. */
  const panDrag = (e: PointerEvent<Element>) => {
    e.preventDefault();
    const start = [e.clientX, e.clientY];
    const from = offset;
    const fitted = zoom === "fit";
    let moved = false;
    drag.current = followPointer(e, (ev) => {
      if (!moved && fitted) setZoom(scale);
      moved = true;
      setPan([from[0] + ev.clientX - start[0], from[1] + ev.clientY - start[1]]);
    });
  };
  // `revision` changes after every edit; the layer objects behind `comp` are rebuilt then.
  const pickable = useMemo(() => pickableLayers(project, comp, time), [project, comp, time, revision]);
  const selected = comp.layers.find((l) => l.id === selectedLayerId);
  const effectDropPick = effectDrop !== undefined ? pickable.find((p) => p.layer.id === effectDrop) : undefined;
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
    if (e.button === 1 || (e.button === 0 && (tool === "hand" || spaceDown.current))) return panDrag(e);
    if (e.button !== undefined && e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const start = clientToComp(e.clientX, e.clientY, rect);
    if (tool === "zoom") return zoomAt(zoomStep(e.altKey ? -1 : 1), e.clientX, e.clientY);
    if (roiMode) {
      // Drawing the region of interest.
      e.preventDefault();
      drag.current = followPointer(
        e,
        (ev) => {
          const at = clientToComp(ev.clientX, ev.clientY, rect);
          const x0 = Math.max(0, Math.min(start[0], at[0]));
          const y0 = Math.max(0, Math.min(start[1], at[1]));
          const x1 = Math.min(comp.width, Math.max(start[0], at[0]));
          const y1 = Math.min(comp.height, Math.max(start[1], at[1]));
          setRoi([x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)]);
        },
        () => setRoiMode(false),
      );
      return;
    }
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
    if (!editor || !kind || !layer) {
      // A finger on no layer pans the view, as on other touch canvases.
      if (e.pointerType === "touch" && tool === "selection" && !picked) panDrag(e);
      return;
    }
    e.preventDefault();
    const handle = grip ? (grip.split(",").map(Number) as Handle) : ([0, 0] as Handle);
    const key = nextDragKey(kind);
    const id = layer.id;
    const action = kind;
    const snap = editing.snapping && kind === "move" ? snapTargets(comp, layer, time) : undefined;
    const stop = followPointer(
      e,
      (ev) => {
        const at = clientToComp(ev.clientX, ev.clientY, rect);
        const target = comp.layers.find((l) => l.id === id);
        if (!target || !at.every(Number.isFinite)) return;
        let delta: [number, number] = [at[0] - start[0], at[1] - start[1]];
        // Ctrl temporarily inverts Snapping, as in AE.
        if (snap && !ev.ctrlKey) delta = snapDelta(snap, delta, SNAP_PIXELS / scale);
        attempt(editing, () => {
          if (action === "move") moveLayers(editor, comp, [target], delta, time, { coalesce: key, constrain: ev.shiftKey });
          else if (action === "scale") scaleByHandle(editor, comp, target, handle, start, at, time, { coalesce: key, proportional: ev.shiftKey });
          else if (action === "rotation") rotateByDrag(editor, comp, target, start, at, time, { coalesce: key, snap: ev.shiftKey });
          else panBehind(editor, comp, target, delta, time, { coalesce: key, anchorOnly: ev.altKey });
        });
      },
      () => {
        drag.current = null;
        editor.commit();
      },
    );
    drag.current = () => {
      stop();
      editor.commit();
    };
  };

  const dragsItem = (e: DragEvent) => !!editor && Array.from(e.dataTransfer?.types ?? []).includes(ITEM_MIME);
  /** The layer an Effects & Presets effect dragged over the viewer applies to: the one under the pointer, or else the selected one. */
  const effectDropLayer = (e: DragEvent): Layer | undefined => {
    if (!editor || !actions?.applyEffect || !Array.from(e.dataTransfer?.types ?? []).includes(EFFECT_MIME)) return undefined;
    const rect = svgRef.current?.getBoundingClientRect();
    const under = rect?.width ? hit(...clientToComp(e.clientX, e.clientY, rect))?.layer : undefined;
    const layer = under ?? selected;
    return layer && !layer.locked ? layer : undefined;
  };
  const itemDrop = {
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      const effectLayer = effectDropLayer(e);
      if (!dragsItem(e) && !effectLayer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (effectLayer) setEffectDrop(effectLayer.id);
      else setItemOver(true);
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setItemOver(false);
      setEffectDrop(undefined);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      setItemOver(false);
      setEffectDrop(undefined);
      const effectLayer = effectDropLayer(e);
      if (effectLayer) {
        e.preventDefault();
        e.stopPropagation();
        actions?.applyEffect?.(e.dataTransfer.getData(EFFECT_MIME), { compId: comp.id, layerIds: [effectLayer.id] });
        return;
      }
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
    const engine = render.engine.current;
    const inside = x >= 0 && y >= 0 && x < comp.width && y < comp.height;
    // Reading a pixel back waits for the GPU to finish the frame, which would stall every move of a dragging finger.
    const rgba: [number, number, number, number] | undefined =
      e.pointerType === "touch" ? undefined : engine && inside && !playing ? engine.readPixel(frameIndex(comp, time), x, y) : [0, 0, 0, 0];
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
      <div className={`viewer ${itemOver ? "item-over" : ""}`} ref={viewerRef} {...itemDrop} onPointerDownCapture={onViewerPointerDown}>
        <div className="pasteboard">
          <div
            className={`comp-frame ${grid ? "transparency" : ""}`}
            style={{
              width: frameW * scale,
              height: comp.height * scale,
              background: grid ? undefined : channel === "rgb" || channel === "straight" ? colorCss(comp.bgColor) : "#000",
              transform: offset[0] || offset[1] ? `translate(${offset[0]}px, ${offset[1]}px)` : undefined,
            }}
          >
            <canvas
              ref={setCanvas}
              className={`comp-canvas ${scale * downsample > 1 ? "pixelated" : ""}`}
              aria-hidden="true"
              style={{
                filter: channelFilter(channel, exposure),
                clipPath: roi
                  ? `inset(${(roi[1] / comp.height) * 100}% ${(1 - (roi[0] + roi[2]) / comp.width) * 100}% ${(1 - (roi[1] + roi[3]) / comp.height) * 100}% ${(roi[0] / comp.width) * 100}%)`
                  : undefined,
              }}
            />
            {showingSnapshot && snapshot && <img className="comp-snapshot" src={snapshot} alt="" aria-hidden="true" />}
            <svg
              ref={svgRef}
              className={`comp-svg ${editor || tool === "hand" || tool === "zoom" ? `tool-${roiMode ? "roi" : tool}` : ""}`}
              viewBox={`0 0 ${comp.width} ${comp.height}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${comp.name}, ${comp.width} x ${comp.height}, at ${timecode(time + comp.displayStartTime, comp.frameRate)}`}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(undefined)}
              onPointerDown={onPointerDown}
              onContextMenu={(e) => {
                if (!actions) return;
                // Like AE: right-clicking a layer selects it and shows the layer menu; elsewhere the comp menu.
                const layer = hit(...toComp(e))?.layer;
                if (layer) onSelectLayer(layer.id);
                openContextMenu(e, layer ? layerMenu(project, comp, layer, actions) : viewerMenu(comp, actions));
              }}
            >
              {(guides.safe || guides.proportional || guides.grid) && <Guides comp={comp} options={guides} scale={scale} />}
              {roi && <rect className="roi-rect" x={roi[0]} y={roi[1]} width={roi[2]} height={roi[3]} strokeWidth={1 / scale} />}
              {!playing && showMasks && selected && selectedMatrix && <MaskPaths layer={selected} matrix={selectedMatrix} time={time} scale={scale} />}
              {effectDropPick && (
                <polygon
                  className="effect-drop"
                  points={[
                    [0, 0],
                    [effectDropPick.layer.width, 0],
                    [effectDropPick.layer.width, effectDropPick.layer.height],
                    [0, effectDropPick.layer.height],
                  ]
                    .map(([x, y]) => apply(effectDropPick.matrix, x, y).join(","))
                    .join(" ")}
                />
              )}
              {!playing && layerControls && selected && selectedMatrix && (
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
        {(render.error || render.notes.length > 0 || missing > 0 || integratedGpu) && (
          <div className="render-notes" role="status">
            {integratedGpu && (
              <div>
                {`Rendering on ${integratedGpu}, the processor's built-in GPU. For a dedicated GPU, set your browser to High performance in Windows Settings › Display › Graphics and restart it.`}
                <button
                  type="button"
                  className="locate-link"
                  onClick={() => {
                    setGpuHintHidden(true);
                    storeFlag(GPU_HINT_KEY);
                  }}
                >
                  Dismiss
                </button>
              </div>
            )}
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
      <ChannelFilters />
      <div className="viewer-bar">
        <ViewerButton icon="alwaysPreview" title="Always Preview This View" on={alwaysPreview} onClick={() => setAlwaysPreview(!alwaysPreview)} />
        <label className="vb-select" title="Magnification ratio popup">
          <select
            aria-label="Magnification"
            value={zoom === "fit" ? "fit" : String(zoom)}
            onChange={(e) => {
              setPan([0, 0]);
              setZoom(e.target.value === "fit" ? "fit" : Number(e.target.value));
            }}
          >
            <option value="fit">{zoom === "fit" ? `(${pct})` : "Fit up to 100%"}</option>
            {zoom !== "fit" && !ZOOMS.includes(zoom) && <option value={String(zoom)}>{pct}</option>}
            {ZOOMS.map((z) => (
              <option key={z} value={String(z)}>
                {`${Number((z * 100).toFixed(1))}%`}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" size={10} />
        </label>
        <Dropdown
          text={autoRes ? "Auto" : resolution}
          label="Resolution/Down Sample Factor"
          width={64}
          menu={() => [
            ...[1, 2, 3, 4].map((f) => ({
              label: RESOLUTIONS[f],
              checked: !autoRes && compFactor === f,
              onSelect:
                editor || f === compFactor
                  ? () => {
                      autoResolution.set(false);
                      if (editor && f !== compFactor) attempt(editing, () => editor.setCompSettings(comp, { resolutionFactor: [f, f] }));
                    }
                  : undefined,
            })),
            { label: "Auto", checked: autoRes, onSelect: () => autoResolution.set(true) },
          ]}
        />
        <ViewerButton
          icon="fastPreview"
          title={`Fast Previews: ${fastPreviews ? "Adaptive Resolution" : "Off (Final Quality)"}`}
          on={fastPreviews}
          onClick={() => fastPreviewSetting.set(!fastPreviews)}
        />
        <ViewerButton icon="transparency" title="Toggle Transparency Grid" on={grid} onClick={() => setGrid(!grid)} />
        <ViewerButton icon="maskPath" title="Toggle Mask and Shape Path Visibility" on={showMasks} onClick={() => setShowMasks(!showMasks)} />
        <ViewerButton
          icon="roi"
          title="Region of Interest"
          on={roiMode || !!roi}
          onClick={() => {
            // First click: drag a region in the viewer. Again: clear it.
            if (roi || roiMode) {
              setRoi(undefined);
              setRoiMode(false);
            } else setRoiMode(true);
          }}
        />
        <ViewerButton
          icon="grid"
          title="Choose grid and guide options"
          on={guides.safe || guides.proportional || guides.grid}
          onMenu={() => [
            { label: "Title/Action Safe", checked: guides.safe, onSelect: () => setGuides({ ...guides, safe: !guides.safe }) },
            { label: "Proportional Grid", checked: guides.proportional, onSelect: () => setGuides({ ...guides, proportional: !guides.proportional }) },
            { label: "Grid", checked: guides.grid, onSelect: () => setGuides({ ...guides, grid: !guides.grid }) },
          ]}
        />
        <ViewerButton
          icon="channels"
          title="Show Channel and Color Management Settings"
          on={channel !== "rgb"}
          onMenu={() =>
            (
              [
                ["rgb", "RGB"],
                ["red", "Red"],
                ["green", "Green"],
                ["blue", "Blue"],
                ["alpha", "Alpha"],
                ["straight", "RGB Straight"],
              ] as const
            ).map(([id, label]) => ({ label, checked: channel === id, onSelect: () => setChannel(id) }))
          }
        />
        {onTime ? (
          <span className="vb-time">
            <TimeDisplay comp={comp} time={time} onTime={onTime} title="Viewer Current Time (click to edit)" />
          </span>
        ) : (
          <span className="vb-time" title="Current time">
            {timecode(time + comp.displayStartTime, comp.frameRate)}
          </span>
        )}
        <ViewerButton icon="snapshot" title="Take Snapshot" onClick={() => canvas && setSnapshot(canvas.toDataURL())} />
        <button
          type="button"
          className={`vb-btn ${showingSnapshot ? "on" : ""}`}
          title="Show Snapshot (hold)"
          aria-label="Show Snapshot"
          disabled={!snapshot}
          onPointerDown={() => setShowingSnapshot(true)}
          onPointerUp={() => setShowingSnapshot(false)}
          onPointerLeave={() => setShowingSnapshot(false)}
        >
          <Icon name="showSnapshot" size={14} />
        </button>
        <ViewerButton icon="exposure" title="Reset Exposure" on={exposure !== 0} onClick={() => setExposure(0)} />
        <span
          className="vb-exposure scrub"
          title="Adjust Exposure (drag)"
          role="slider"
          aria-label="Exposure"
          aria-valuenow={exposure}
          tabIndex={0}
          onPointerDown={(e) => {
            const x0 = e.clientX;
            const from = exposure;
            followPointer(e, (ev) => setExposure(Math.round((from + (ev.clientX - x0) / 20) * 10) / 10));
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowUp") setExposure(Math.round((exposure + 0.1) * 10) / 10);
            if (e.key === "ArrowLeft" || e.key === "ArrowDown") setExposure(Math.round((exposure - 0.1) * 10) / 10);
          }}
        >
          {exposure >= 0 ? "+" : ""}
          {exposure.toFixed(1)}
        </span>
        <span className="vb-spacer" />
        <span className="vb-label">Classic 3D</span>
        <Dropdown
          text="Active Camera"
          label="3D View Popup"
          width={96}
          menu={() => [
            { label: "Active Camera", checked: true, onSelect: () => {} },
            "-",
            ...["Front", "Left", "Top", "Back", "Right", "Bottom", "Custom View 1", "Custom View 2", "Custom View 3"].map((label) => ({ label })),
          ]}
        />
        <Dropdown
          text="1 View"
          label="Select view layout"
          width={60}
          menu={() => [{ label: "1 View", checked: true, onSelect: () => {} }, { label: "2 Views" }, { label: "4 Views" }]}
        />
      </div>
    </div>
  );
}
