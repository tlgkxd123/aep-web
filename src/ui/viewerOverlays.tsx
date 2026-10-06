// Composition viewer overlays and options: mask paths of the selected layer,
// safe zones and grids, channel display filters, and layer snapping.
import { valueAtTime } from "../aep/evaluate.ts";
import { isShapeValue, type CompItem, type Layer, type PropertyGroup } from "../aep/model.ts";
import { apply, layerAffine, type Matrix } from "./animate.ts";

export type Channel = "rgb" | "red" | "green" | "blue" | "alpha" | "straight";
export interface GuideOptions {
  safe: boolean;
  proportional: boolean;
  grid: boolean;
}

/** AE's defaults: action-safe 10 % and title-safe 20 % inset, a 4 x 4 proportional grid, a 50 px grid. */
const ACTION_SAFE = 0.1;
const TITLE_SAFE = 0.2;
const PROPORTIONAL = 4;
const GRID_PX = 50;

/** The selected layer's mask paths in comp space, AE's yellow outlines. */
export function MaskPaths({ layer, matrix, time, scale }: { layer: Layer; matrix: Matrix; time: number; scale: number }) {
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Mask Parade");
  const masks = (parade?.children ?? []).filter((n): n is PropertyGroup => n.kind === "group" && !!n.mask);
  return (
    <g className="mask-paths" strokeWidth={1 / scale}>
      {masks.map((mask, i) => {
        const shapeProp = mask.children.find((c) => c.matchName === "ADBE Mask Shape");
        const shape = shapeProp?.kind === "property" ? valueAtTime(shapeProp, time, layer) : null;
        if (!isShapeValue(shape) || !shape.vertices.length) return null;
        const { vertices: v, inTangents: inT, outTangents: outT } = shape;
        const p = (x: number, y: number) => apply(matrix, x, y).join(" ");
        let d = `M${p(v[0][0], v[0][1])}`;
        const segments = shape.closed ? v.length : v.length - 1;
        for (let k = 0; k < segments; k++) {
          const a = v[k];
          const b = v[(k + 1) % v.length];
          const bi = inT[(k + 1) % v.length];
          d += `C${p(a[0] + outT[k][0], a[1] + outT[k][1])} ${p(b[0] + bi[0], b[1] + bi[1])} ${p(b[0], b[1])}`;
        }
        if (shape.closed) d += "Z";
        const [r, g, b] = mask.mask!.color;
        return <path key={i} d={d} stroke={`rgb(${r * 255} ${g * 255} ${b * 255})`} fill="none" />;
      })}
    </g>
  );
}

/** Safe zones, proportional grid and grid over the comp frame. */
export function Guides({ comp, options, scale }: { comp: CompItem; options: GuideOptions; scale: number }) {
  const { width: w, height: h } = comp;
  const lines: string[] = [];
  if (options.proportional) {
    for (let i = 1; i < PROPORTIONAL; i++) lines.push(`M${(w * i) / PROPORTIONAL} 0V${h}`, `M0 ${(h * i) / PROPORTIONAL}H${w}`);
  }
  const grid: string[] = [];
  if (options.grid) {
    for (let x = GRID_PX; x < w; x += GRID_PX) grid.push(`M${x} 0V${h}`);
    for (let y = GRID_PX; y < h; y += GRID_PX) grid.push(`M0 ${y}H${w}`);
  }
  const rect = (inset: number) => <rect x={w * inset / 2} y={h * inset / 2} width={w * (1 - inset)} height={h * (1 - inset)} />;
  const cross = Math.min(w, h) * 0.03;
  return (
    <g className="viewer-guides" strokeWidth={1 / scale} fill="none">
      {options.grid && <path className="grid-lines" d={grid.join("")} />}
      {options.proportional && <path className="prop-grid" d={lines.join("")} />}
      {options.safe && (
        <g className="safe-zones">
          {rect(ACTION_SAFE)}
          {rect(TITLE_SAFE)}
          <path d={`M${w / 2 - cross} ${h / 2}H${w / 2 + cross}M${w / 2} ${h / 2 - cross}V${h / 2 + cross}`} />
        </g>
      )}
    </g>
  );
}

const CHANNEL_MATRICES: Record<Exclude<Channel, "rgb" | "straight">, string> = {
  red: "1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1",
  green: "0 1 0 0 0  0 1 0 0 0  0 1 0 0 0  0 0 0 0 1",
  blue: "0 0 1 0 0  0 0 1 0 0  0 0 1 0 0  0 0 0 0 1",
  alpha: "0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 0 1",
};

/** SVG filters the viewer canvas uses to show one channel as gray, as AE's channel popup does. */
export function ChannelFilters() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      {Object.entries(CHANNEL_MATRICES).map(([name, values]) => (
        <filter key={name} id={`aep-channel-${name}`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={values} />
        </filter>
      ))}
    </svg>
  );
}

export function channelFilter(channel: Channel, exposure: number): string | undefined {
  const parts: string[] = [];
  if (channel !== "rgb" && channel !== "straight") parts.push(`url(#aep-channel-${channel})`);
  if (exposure) parts.push(`brightness(${2 ** exposure})`);
  return parts.length ? parts.join(" ") : undefined;
}

/** Comp-space bounding box [x0, y0, x1, y1] of a 2D layer at `time`. */
export function bounds(comp: CompItem, layer: Layer, time: number): [number, number, number, number] | undefined {
  if (layer.threeDLayer || layer.width <= 0) return undefined;
  const m = layerAffine(layer, comp, time);
  if (!m) return undefined;
  const pts = [apply(m, 0, 0), apply(m, layer.width, 0), apply(m, layer.width, layer.height), apply(m, 0, layer.height)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export interface SnapTargets {
  box: [number, number, number, number];
  xs: number[];
  ys: number[];
}

/**
 * What a drag of `layer` snaps to, measured when the drag starts (the layer
 * moves during the drag): the comp's edges and centre and the edges and
 * centres of the other visible 2D layers.
 */
export function snapTargets(comp: CompItem, layer: Layer, time: number): SnapTargets | undefined {
  const box = bounds(comp, layer, time);
  if (!box) return undefined;
  const xs = [0, comp.width / 2, comp.width];
  const ys = [0, comp.height / 2, comp.height];
  for (const other of comp.layers) {
    if (other.id === layer.id || !other.enabled || time < other.inPoint || time >= other.outPoint) continue;
    const b = bounds(comp, other, time);
    if (b) xs.push(b[0], (b[0] + b[2]) / 2, b[2]), ys.push(b[1], (b[1] + b[3]) / 2, b[3]);
  }
  return { box, xs, ys };
}

/** The drag delta adjusted so the layer's edges or centre land on a target within `threshold` comp pixels, per axis. */
export function snapDelta({ box, xs, ys }: SnapTargets, delta: [number, number], threshold: number): [number, number] {
  const axis = (lo: number, hi: number, d: number, targets: number[]) => {
    let best = d;
    let bestDist = threshold;
    for (const own of [lo, (lo + hi) / 2, hi]) {
      for (const t of targets) {
        const dist = Math.abs(own + d - t);
        if (dist < bestDist) [best, bestDist] = [t - own, dist];
      }
    }
    return best;
  };
  return [axis(box[0], box[2], delta[0], xs), axis(box[1], box[3], delta[1], ys)];
}
