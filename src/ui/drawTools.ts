// The drawing tools of the Tools panel (the shape tools, the Pen tools and the Type tools), their options
// (whether a shape tool on a shape layer draws a shape or a mask; the Fill, Stroke and stroke width new
// shapes get, kept between sessions) and the shapes a drag with a shape tool draws.
import { useSyncExternalStore } from "react";
import type { Shape } from "../aep/model.ts";
import { ellipseShape, rectShape, starShape } from "../edit/masks.ts";
import type { NewShape, ShapePaint } from "../edit/shapes.ts";

export const SHAPE_TOOLS = ["rect", "roundedRect", "ellipse", "polygon", "star"] as const;
export const PEN_TOOLS = ["pen", "addVertex", "deleteVertex", "convertVertex"] as const;
export const TYPE_TOOLS = ["type", "typeVertical"] as const;
export type ShapeTool = (typeof SHAPE_TOOLS)[number];
export type PenTool = (typeof PEN_TOOLS)[number];

export const isShapeTool = (tool: string): tool is ShapeTool => (SHAPE_TOOLS as readonly string[]).includes(tool);
export const isPenTool = (tool: string): tool is PenTool => (PEN_TOOLS as readonly string[]).includes(tool);
export const isTypeTool = (tool: string) => (TYPE_TOOLS as readonly string[]).includes(tool);

export const TOOL_NAMES: Record<string, string> = {
  rect: "Rectangle Tool",
  roundedRect: "Rounded Rectangle Tool",
  ellipse: "Ellipse Tool",
  polygon: "Polygon Tool",
  star: "Star Tool",
  pen: "Pen Tool",
  addVertex: "Add Vertex Tool",
  deleteVertex: "Delete Vertex Tool",
  convertVertex: "Convert Vertex Tool",
  type: "Horizontal Type Tool",
  typeVertical: "Vertical Type Tool",
};

export interface DrawOptions extends ShapePaint {
  /** What a shape tool or the Pen makes when a shape layer is selected: a shape in it, or a mask on it. */
  creates: "shape" | "mask";
}

const STORE_KEY = "aep-web.drawOptions";
const DEFAULTS: DrawOptions = { fill: [1, 0, 0], stroke: null, strokeWidth: 2, creates: "shape" };

function load(): DrawOptions {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? "null") as Partial<DrawOptions> | null;
    return { ...DEFAULTS, ...stored };
  } catch {
    return DEFAULTS;
  }
}

let options = load();
const listeners = new Set<() => void>();

export const drawOptions = {
  get: () => options,
  set(next: Partial<DrawOptions>): void {
    options = { ...options, ...next };
    try {
      globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(options));
    } catch {
      // Kept for this session where storage is unavailable.
    }
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const useDrawOptions = () => useSyncExternalStore(drawOptions.subscribe, drawOptions.get);

/** Each flyout's tool shown in the Tools panel: the one last picked from it. */
const shown = { shape: "rect" as ShapeTool, pen: "pen" as PenTool, type: "type" };
export const shownTool = (group: keyof typeof shown) => shown[group];
export function rememberTool(tool: string): void {
  if (isShapeTool(tool)) shown.shape = tool;
  else if (isPenTool(tool)) shown.pen = tool;
  else if (isTypeTool(tool)) shown.type = tool;
}

/** The tool after `current` in its flyout, as pressing its shortcut again picks it (Q, G). */
export function nextInFlyout(current: string, group: "shape" | "pen"): string {
  const list: readonly string[] = group === "shape" ? SHAPE_TOOLS : PEN_TOOLS;
  const at = list.indexOf(current);
  return at < 0 ? shown[group] : list[(at + 1) % list.length];
}

/** Corners of a shape tool's drag: Shift keeps it square, Ctrl draws it out from where the drag started. */
export interface DragBox {
  center: [number, number];
  size: [number, number];
  /** Star and polygon: the outer radius and the angle of the drag (degrees). */
  radius: number;
  rotation: number;
}

export function dragBox(tool: ShapeTool, from: [number, number], to: [number, number], square: boolean, fromCenter: boolean): DragBox {
  let dx = to[0] - from[0];
  let dy = to[1] - from[1];
  if (tool === "polygon" || tool === "star") {
    // The Star and Polygon tools always draw out from the centre; Shift keeps the shape upright.
    const radius = Math.hypot(dx, dy);
    const rotation = square ? 0 : (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    return { center: from, size: [radius * 2, radius * 2], radius, rotation };
  }
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  const size: [number, number] = fromCenter ? [Math.abs(dx) * 2, Math.abs(dy) * 2] : [Math.abs(dx), Math.abs(dy)];
  const center: [number, number] = fromCenter ? from : [from[0] + dx / 2, from[1] + dy / 2];
  return { center, size, radius: Math.max(size[0], size[1]) / 2, rotation: 0 };
}

/** The rounded rectangle tool's corner radius for a box. */
export const roundness = (size: readonly number[]) => Math.min(size[0], size[1]) / 8;

/** A drag as a path (masks, previews), in the space the box is in. */
export function boxPath(tool: ShapeTool, box: DragBox): Shape {
  const [cx, cy] = box.center;
  const [w, h] = box.size;
  switch (tool) {
    case "rect":
      return rectShape(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
    case "roundedRect":
      return rectShape(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, roundness(box.size));
    case "ellipse":
      return ellipseShape(cx, cy, w / 2, h / 2);
    case "polygon":
      return starShape(cx, cy, 5, box.radius, 0, box.rotation);
    case "star":
      return starShape(cx, cy, 5, box.radius, box.radius / 2, box.rotation);
  }
}

/** A drag as a parametric shape group (shape layers), centred on the box. */
export function boxShape(tool: ShapeTool, box: DragBox, paint: ShapePaint): NewShape {
  switch (tool) {
    case "rect":
    case "roundedRect":
      return { kind: "rect", center: box.center, size: box.size, roundness: tool === "roundedRect" ? roundness(box.size) : 0, paint };
    case "ellipse":
      return { kind: "ellipse", center: box.center, size: box.size, paint };
    case "polygon":
      return { kind: "polygon", center: box.center, points: 5, outerRadius: box.radius, rotation: box.rotation, paint };
    case "star":
      return { kind: "star", center: box.center, points: 5, outerRadius: box.radius, innerRadius: box.radius / 2, rotation: box.rotation, paint };
  }
}

/** An SVG path for a Bezier path, its points mapped by `map`. */
export function svgPath(shape: Shape, map: (x: number, y: number) => [number, number]): string {
  const { vertices: v, inTangents: inT, outTangents: outT } = shape;
  if (!v.length) return "";
  const p = (x: number, y: number) => map(x, y).join(" ");
  let d = `M${p(v[0][0], v[0][1])}`;
  const segments = shape.closed ? v.length : v.length - 1;
  for (let k = 0; k < segments; k++) {
    const a = v[k];
    const b = v[(k + 1) % v.length];
    const bi = inT[(k + 1) % v.length] ?? [0, 0];
    const ao = outT[k] ?? [0, 0];
    d += `C${p(a[0] + ao[0], a[1] + ao[1])} ${p(b[0] + bi[0], b[1] + bi[1])} ${p(b[0], b[1])}`;
  }
  return shape.closed ? `${d}Z` : d;
}
