// The After Effects expression object model (comp, layer, property group,
// property, key, path) over the parsed project. Objects are frozen callable
// facades (sandbox.ts) over nodes that read the current evaluation from the
// engine, so they hold no time and can be shared between evaluations. Values
// handed to expressions are always fresh copies; the model is never exposed.
import { layerTimeAt } from "../aep/evaluate.ts";
import {
  isShapeValue,
  PropertyValueType,
  type CompItem,
  type FootageItem,
  type Layer,
  type Project,
  type Property,
  type PropertyGroup,
  type PropertyNode,
  type PropertyValue,
  type Shape,
} from "../aep/model.ts";
import { activeCameraLayer, cameraAt, compPointToSource, projectThroughCamera, projectToComp, worldMatrix } from "../aep/transform.ts";
import matchNames from "../aep/data/match-names.json" with { type: "json" };
import { compMarkers, layerMarkers, type Marker } from "./markers.ts";
import type { ProjectIndex } from "./projectIndex.ts";
import { hashWords, RandomStream, wiggleOffset } from "./random.ts";
import { add, apiNodeOf, apiObject, div, mul, sub, unwrap, type ApiNode } from "./sandbox.ts";
import { num, scalar, vec } from "./vector.ts";

/** One running evaluation. */
export interface EvalFrame {
  prop: Property;
  layer: Layer;
  comp: CompItem;
  project: Project;
  /** The evaluation time (after posterizeTime). */
  time: number;
  seedOffset: number;
  timeless: boolean;
  rng?: RandomStream;
}

/** What the API needs from the engine. */
export interface Host {
  readonly index: ProjectIndex;
  /** The innermost running evaluation. */
  frame(): EvalFrame;
  /** Post-expression value of `prop` at `t` in model form (pre-expression for the property being evaluated). */
  modelValue(prop: Property, layer: Layer, t: number): PropertyValue;
  /** `posterizeTime(fps)`. */
  posterize(fps: number): void;
}

const DISPLAY_NAMES = matchNames as Record<string, string>;

/** Expression attribute names AE uses for property match names (others are camel-cased display names). */
const ATTRIBUTES: Record<string, string[]> = {
  "ADBE Transform Group": ["transform"],
  "ADBE Anchor Point": ["anchorPoint"],
  "ADBE Position": ["position"],
  "ADBE Position_0": ["xPosition"],
  "ADBE Position_1": ["yPosition"],
  "ADBE Position_2": ["zPosition"],
  "ADBE Scale": ["scale"],
  "ADBE Orientation": ["orientation"],
  "ADBE Rotate X": ["xRotation"],
  "ADBE Rotate Y": ["yRotation"],
  "ADBE Rotate Z": ["rotation", "zRotation"],
  "ADBE Opacity": ["opacity"],
  "ADBE Vector Transform Group": ["transform"],
  "ADBE Vector Anchor": ["anchorPoint"],
  "ADBE Vector Position": ["position"],
  "ADBE Vector Scale": ["scale"],
  "ADBE Vector Skew": ["skew"],
  "ADBE Vector Skew Axis": ["skewAxis"],
  "ADBE Vector Rotation": ["rotation"],
  "ADBE Vector Group Opacity": ["opacity"],
  "ADBE Vector Rect Size": ["size"],
  "ADBE Vector Rect Position": ["position"],
  "ADBE Vector Rect Roundness": ["roundness"],
  "ADBE Vector Ellipse Size": ["size"],
  "ADBE Vector Ellipse Position": ["position"],
  "ADBE Vector Star Type": ["type"],
  "ADBE Vector Star Points": ["points"],
  "ADBE Vector Star Position": ["position"],
  "ADBE Vector Star Rotation": ["rotation"],
  "ADBE Vector Star Inner Radius": ["innerRadius"],
  "ADBE Vector Star Outer Radius": ["outerRadius"],
  "ADBE Vector Star Inner Roundess": ["innerRoundness"],
  "ADBE Vector Star Outer Roundess": ["outerRoundness"],
  "ADBE Vector Shape": ["path"],
  "ADBE Vector Fill Color": ["color"],
  "ADBE Vector Fill Opacity": ["opacity"],
  "ADBE Vector Fill Rule": ["fillRule"],
  "ADBE Vector Stroke Color": ["color"],
  "ADBE Vector Stroke Opacity": ["opacity"],
  "ADBE Vector Stroke Width": ["strokeWidth"],
  "ADBE Vector Stroke Line Cap": ["lineCap"],
  "ADBE Vector Stroke Line Join": ["lineJoin"],
  "ADBE Vector Stroke Miter Limit": ["miterLimit"],
  "ADBE Vector Trim Start": ["start"],
  "ADBE Vector Trim End": ["end"],
  "ADBE Vector Trim Offset": ["offset"],
  "ADBE Vector Repeater Copies": ["copies"],
  "ADBE Vector Repeater Offset": ["offset"],
  "ADBE Vector Repeater Transform": ["transform"],
  "ADBE Vector Repeater Anchor": ["anchorPoint"],
  "ADBE Vector Repeater Position": ["position"],
  "ADBE Vector Repeater Scale": ["scale"],
  "ADBE Vector Repeater Rotation": ["rotation"],
  "ADBE Vector Repeater Opacity 1": ["startOpacity"],
  "ADBE Vector Repeater Opacity 2": ["endOpacity"],
  "ADBE Vector Grad Start Pt": ["startPoint"],
  "ADBE Vector Grad End Pt": ["endPoint"],
  "ADBE Vector Grad HiLite Length": ["highlightLength"],
  "ADBE Vector Grad HiLite Angle": ["highlightAngle"],
  "ADBE Vector Grad Colors": ["colors"],
  "ADBE Mask Shape": ["maskPath"],
  "ADBE Mask Feather": ["maskFeather"],
  "ADBE Mask Opacity": ["maskOpacity"],
  "ADBE Mask Offset": ["maskExpansion"],
  "ADBE Text Properties": ["text"],
  "ADBE Text Document": ["sourceText"],
  "ADBE Camera Options Group": ["cameraOption"],
  "ADBE Camera Zoom": ["zoom"],
  "ADBE Camera Depth of Field": ["depthOfField"],
  "ADBE Camera Focus Distance": ["focusDistance"],
  "ADBE Camera Aperture": ["aperture"],
  "ADBE Camera Blur Level": ["blurLevel"],
  "ADBE Light Options Group": ["lightOption"],
  "ADBE Light Intensity": ["intensity"],
  "ADBE Light Color": ["color"],
  "ADBE Light Cone Angle": ["coneAngle"],
  "ADBE Light Cone Feather 2": ["coneFeather"],
  "ADBE Light Shadow Darkness": ["shadowDarkness"],
  "ADBE Light Shadow Diffusion": ["shadowDiffusion"],
  "ADBE Time Remapping": ["timeRemap"],
  "ADBE Marker": ["marker"],
  "ADBE Audio Group": ["audio"],
  "ADBE Audio Levels": ["audioLevels"],
};

const camelCase = (name: string) =>
  name
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
    .replace(/^[A-Z]/, (c) => c.toLowerCase());

function attributeNames(node: PropertyNode): string[] {
  return ATTRIBUTES[node.matchName] ?? [camelCase(DISPLAY_NAMES[node.matchName] ?? node.name)];
}

/** Child of a group by display name, match name or 1-based index. */
function childOf(children: PropertyNode[], key: unknown): PropertyNode | undefined {
  const k = unwrap(key);
  if (typeof k === "number") return children[Math.round(k) - 1];
  const s = String(k);
  return children.find((c) => c.name === s) ?? children.find((c) => c.matchName === s);
}

const missing = (cls: string, key: PropertyKey): never => {
  throw new TypeError(`property or method named '${String(key)}' in class '${cls}' is missing or does not exist`);
};

const isIndexKey = (key: PropertyKey): boolean => typeof key === "number" || (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key));

const TWO_D_IN_2D_LAYERS = new Set(["ADBE Position", "ADBE Anchor Point", "ADBE Scale"]);

/** Number of dimensions AE shows expressions for this property (2D layers use 2D transforms). */
export function expressionDimensions(prop: Property, layer: Layer, model: PropertyValue): number {
  if (typeof model === "number") return 1;
  if (!Array.isArray(model)) return 0;
  if (TWO_D_IN_2D_LAYERS.has(prop.matchName) && !layer.threeDLayer && model.length === 3) return 2;
  return model.length;
}

const cloneShape = (s: Shape): Shape => ({
  closed: s.closed,
  vertices: s.vertices.map((v) => [...v]),
  inTangents: s.inTangents.map((v) => [...v]),
  outTangents: s.outTangents.map((v) => [...v]),
});

/** A path value (the value of a mask or shape path) as expressions see it. */
export interface PathNode extends ApiNode {
  readonly shape: Shape;
}

const pathShapes = new WeakMap<ApiNode, Shape>();

/** The shape behind a path value object, if `value` is one. */
export function shapeOf(value: unknown): Shape | undefined {
  const node = apiNodeOf(value);
  return node ? pathShapes.get(node) : undefined;
}

// --- path geometry --------------------------------------------------------------------

type Cubic = [number[], number[], number[], number[]];

function cubics(s: Shape): Cubic[] {
  const n = s.vertices.length;
  const out: Cubic[] = [];
  for (let i = 0; i < (s.closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    const a = s.vertices[i];
    const b = s.vertices[j];
    out.push([a, [a[0] + s.outTangents[i][0], a[1] + s.outTangents[i][1]], [b[0] + s.inTangents[j][0], b[1] + s.inTangents[j][1]], b]);
  }
  return out;
}

function cubicAt(c: Cubic, t: number): number[] {
  const u = 1 - t;
  return [0, 1].map((d) => u * u * u * c[0][d] + 3 * u * u * t * c[1][d] + 3 * u * t * t * c[2][d] + t * t * t * c[3][d]);
}

function cubicTangent(c: Cubic, t: number): number[] {
  const u = 1 - t;
  return [0, 1].map((d) => 3 * u * u * (c[1][d] - c[0][d]) + 6 * u * t * (c[2][d] - c[1][d]) + 3 * t * t * (c[3][d] - c[2][d]));
}

/** Point, unit tangent at a fraction of a path's arc length. */
function alongPath(s: Shape, fraction: number): { point: number[]; tangent: number[] } {
  const segs = cubics(s);
  if (!segs.length) return { point: [...(s.vertices[0] ?? [0, 0])], tangent: [1, 0] };
  const SAMPLES = 64;
  const tables = segs.map((c) => {
    const table = [0];
    let prev = c[0];
    for (let k = 1; k <= SAMPLES; k++) {
      const p = cubicAt(c, k / SAMPLES);
      table.push(table[k - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]));
      prev = p;
    }
    return table;
  });
  const total = tables.reduce((sum, t) => sum + t[SAMPLES], 0);
  let target = Math.min(Math.max(fraction, 0), 1) * total;
  for (let i = 0; i < segs.length; i++) {
    const table = tables[i];
    if (target <= table[SAMPLES] || i === segs.length - 1) {
      let k = 1;
      while (k < SAMPLES && table[k] < target) k++;
      const span = table[k] - table[k - 1];
      const t = (k - 1 + (span > 0 ? Math.min(1, Math.max(0, (target - table[k - 1]) / span)) : 0)) / SAMPLES;
      const d = cubicTangent(segs[i], t);
      const len = Math.hypot(d[0], d[1]) || 1;
      return { point: cubicAt(segs[i], t), tangent: [d[0] / len, d[1] / len] };
    }
    target -= table[SAMPLES];
  }
  return { point: [...s.vertices[0]], tangent: [1, 0] };
}

// --- the object model ---------------------------------------------------------------------

export class Api {
  private readonly host: Host;
  private readonly cache = new WeakMap<object, Map<string, unknown>>();

  constructor(host: Host) {
    this.host = host;
  }

  private cached(owner: object, key: string, make: () => unknown): unknown {
    let map = this.cache.get(owner);
    if (!map) this.cache.set(owner, (map = new Map()));
    if (!map.has(key)) map.set(key, make());
    return map.get(key);
  }

  private get time(): number {
    return this.host.frame().time;
  }

  // --- values -------------------------------------------------------------------

  /** A model value as expressions see it (always a copy). */
  toExpression(prop: Property, layer: Layer, v: PropertyValue): unknown {
    if (typeof v === "number") return v;
    if (Array.isArray(v)) return expressionDimensions(prop, layer, v) === 2 && v.length === 3 ? v.slice(0, 2) : [...v];
    if (isShapeValue(v)) return this.path(v);
    if (prop.propertyValueType === PropertyValueType.TEXT_DOCUMENT) return textDocumentOf(v)?.text ?? textOf(prop);
    if (v && typeof v === "object") return JSON.parse(JSON.stringify(v));
    return v;
  }

  valueAt(prop: Property, layer: Layer, t: number): unknown {
    return this.toExpression(prop, layer, this.host.modelValue(prop, layer, t));
  }

  path(shape: Shape): unknown {
    const s = cloneShape(shape);
    const node: ApiNode = {
      get: (key) => {
        switch (key) {
          case "points":
            return () => s.vertices.map((v) => [...v]);
          case "inTangents":
            return () => s.inTangents.map((v) => [...v]);
          case "outTangents":
            return () => s.outTangents.map((v) => [...v]);
          case "isClosed":
            return () => s.closed;
          case "pointOnPath":
            return (pct: unknown = 0.5) => alongPath(s, scalar(pct)).point;
          case "tangentOnPath":
            return (pct: unknown = 0.5) => alongPath(s, scalar(pct)).tangent;
          case "normalOnPath":
            return (pct: unknown = 0.5) => {
              const [x, y] = alongPath(s, scalar(pct)).tangent;
              return [y, -x];
            };
        }
        return missing("Path", key);
      },
    };
    pathShapes.set(node, s);
    return apiObject(node, "Path");
  }

  createPath(points: unknown = [[0, 0], [100, 0], [100, 100], [0, 100]], inTangents: unknown = [], outTangents: unknown = [], isClosed: unknown = true): unknown {
    const pts = (unwrap(points) as unknown[]).map((p) => vec(p).slice(0, 2));
    const tangents = (list: unknown) => {
      const l = (unwrap(list) as unknown[]) ?? [];
      return pts.map((_, i) => (l[i] !== undefined ? vec(l[i]).slice(0, 2) : [0, 0]));
    };
    return this.path({ closed: !!unwrap(isClosed), vertices: pts, inTangents: tangents(inTangents), outTangents: tangents(outTangents) });
  }

  // --- project, comps, footage ----------------------------------------------------------

  project(project: Project): unknown {
    return this.cached(project, "project", () =>
      apiObject(
        {
          get: (key) => {
            switch (key) {
              case "fullPath":
                return "";
              case "bitsPerChannel":
                return project.bitsPerChannel;
              case "linearBlending":
                return false;
            }
            return missing("Project", key);
          },
        },
        "Project",
      ),
    );
  }

  comp(comp: CompItem): unknown {
    return this.cached(comp, "comp", () => {
      const layerAt = (i: number) => {
        const layer = comp.layers[Math.round(i) - 1];
        if (!layer) throw new RangeError(`layer index ${i} out of range (the comp has ${comp.layers.length} layers)`);
        return this.layer(layer, comp);
      };
      const node: ApiNode = {
        get: (key) => {
          switch (key) {
            case "name":
              return comp.name;
            case "numLayers":
              return comp.layers.length;
            case "width":
              return comp.width;
            case "height":
              return comp.height;
            case "duration":
              return comp.duration;
            case "frameDuration":
              return comp.frameDuration;
            case "displayStartTime":
              return comp.displayStartTime;
            case "pixelAspect":
              return comp.pixelAspect;
            case "bgColor":
              return [...comp.bgColor, 1];
            case "shutterAngle":
              return comp.shutterAngle;
            case "shutterPhase":
              return comp.shutterPhase;
            case "ntscDropFrame":
              return false;
            case "activeCamera": {
              const cam = activeCameraLayer(comp, this.time);
              if (!cam) throw new Error("the composition has no active camera");
              return this.layer(cam, comp);
            }
            case "marker":
              return this.markers(comp, () => compMarkers(comp));
            case "layer":
              return (a: unknown, b?: unknown) => {
                const first = unwrap(a);
                const other = apiNodeOf(a) ? this.layerOf(a) : undefined;
                if (other && b !== undefined) return layerAt(other.index + scalar(b));
                if (other) return this.layer(other, comp);
                if (typeof first === "number") return layerAt(first);
                const name = String(first);
                const found = comp.layers.find((l) => l.name === name);
                if (!found) throw new Error(`layer named '${name}' is missing or does not exist`);
                return this.layer(found, comp);
              };
            case "layerByComment":
              return (comment: unknown) => {
                const found = comp.layers.find((l) => l.comment === String(unwrap(comment)));
                if (!found) throw new Error(`no layer has the comment '${String(comment)}'`);
                return this.layer(found, comp);
              };
          }
          return missing("Comp", key);
        },
      };
      return apiObject(node, "Comp");
    });
  }

  footage(item: FootageItem): unknown {
    return this.cached(item, "footage", () =>
      apiObject(
        {
          get: (key) => {
            switch (key) {
              case "name":
                return item.name;
              case "width":
                return item.width;
              case "height":
                return item.height;
              case "duration":
                return item.duration;
              case "frameDuration":
                return item.frameRate ? 1 / item.frameRate : 0;
              case "ntscDropFrame":
                return false;
              case "pixelAspect":
                return item.pixelAspect;
            }
            return missing("Footage", key);
          },
        },
        "Footage",
      ),
    );
  }

  private readonly layerByFacade = new WeakMap<object, Layer>();

  /** The model layer behind a layer object. */
  layerOf(value: unknown): Layer | undefined {
    return typeof value === "function" ? this.layerByFacade.get(value) : undefined;
  }

  // --- layers -------------------------------------------------------------------

  layer(layer: Layer, comp: CompItem): unknown {
    return this.cached(layer, "layer", () => {
      const top = (matchName: string) => layer.properties.find((n) => n.matchName === matchName);
      const transformGroup = () => top("ADBE Transform Group") as PropertyGroup | undefined;
      const transformProp = (matchName: string) => {
        const g = transformGroup();
        const p = g?.children.find((c) => c.matchName === matchName);
        if (!p || p.kind !== "property") return missing("Layer", matchName);
        return this.property(p, layer, comp);
      };
      const listed = (matchName: string, cls: string) => (key: unknown) => {
        const parade = top(matchName);
        const children = parade?.kind === "group" ? parade.children : [];
        const found = childOf(children, key);
        if (!found) throw new Error(`${cls} named '${String(unwrap(key))}' is missing or does not exist`);
        return this.node(found, layer, comp);
      };
      const world = (t: unknown) => worldMatrix(layer, comp, t === undefined ? this.time : scalar(t));
      const is3D = () => layer.threeDLayer;
      const node: ApiNode = {
        invoke: (args) => {
          const found = childOf(layer.properties, args[0]);
          if (!found) throw new Error(`property named '${String(unwrap(args[0]))}' is missing or does not exist`);
          return this.node(found, layer, comp);
        },
        get: (key) => {
          switch (key) {
            case "name":
              return layer.name;
            case "index":
              return layer.index;
            case "hasParent":
              return !!layer.parentId && comp.layers.some((l) => l.id === layer.parentId);
            case "parent": {
              const parent = layer.parentId ? comp.layers.find((l) => l.id === layer.parentId) : undefined;
              if (!parent) throw new Error(`layer '${layer.name}' has no parent`);
              return this.layer(parent, comp);
            }
            case "inPoint":
              return layer.inPoint;
            case "outPoint":
              return layer.outPoint;
            case "startTime":
              return layer.startTime;
            case "hasVideo":
              return layer.layerType !== "CameraLayer" && layer.layerType !== "LightLayer";
            case "hasAudio":
              return false;
            case "active":
              return layer.enabled && this.time >= layer.inPoint && this.time < layer.outPoint;
            case "enabled":
              return layer.enabled;
            case "audioActive":
              return false;
            case "width":
              return layer.width;
            case "height":
              return layer.height;
            case "source": {
              const item = layer.sourceId ? this.host.frame().project.items.get(layer.sourceId) : undefined;
              if (item?.kind === "comp") return this.comp(item);
              if (item?.kind === "footage") return this.footage(item);
              throw new Error(`layer '${layer.name}' has no source`);
            }
            case "transform": {
              const g = transformGroup();
              if (!g) return missing("Layer", key);
              return this.group(g, layer, comp);
            }
            case "anchorPoint":
              return transformProp("ADBE Anchor Point");
            case "position":
              return transformProp("ADBE Position");
            case "xPosition":
              return transformProp("ADBE Position_0");
            case "yPosition":
              return transformProp("ADBE Position_1");
            case "zPosition":
              return transformProp("ADBE Position_2");
            case "scale":
              return transformProp("ADBE Scale");
            case "rotation":
            case "zRotation":
              return transformProp("ADBE Rotate Z");
            case "xRotation":
              return transformProp("ADBE Rotate X");
            case "yRotation":
              return transformProp("ADBE Rotate Y");
            case "orientation":
              return transformProp("ADBE Orientation");
            case "opacity":
              return transformProp("ADBE Opacity");
            case "effect":
              return listed("ADBE Effect Parade", "effect");
            case "mask":
              return listed("ADBE Mask Parade", "mask");
            case "content":
              return listed("ADBE Root Vectors Group", "content");
            case "marker":
              return this.markers(layer, () => layerMarkers(layer, comp));
            case "text":
            case "timeRemap":
            case "cameraOption":
            case "lightOption":
            case "materialOption": {
              const matchName = {
                text: "ADBE Text Properties",
                timeRemap: "ADBE Time Remapping",
                cameraOption: "ADBE Camera Options Group",
                lightOption: "ADBE Light Options Group",
                materialOption: "ADBE Material Options Group",
              }[key];
              const found = top(matchName);
              if (found) return this.node(found, layer, comp);
              return missing("Layer", key);
            }
            case "audioLevels": {
              const audio = top("ADBE Audio Group");
              const levels = audio?.kind === "group" ? audio.children.find((c) => c.matchName === "ADBE Audio Levels") : undefined;
              if (!levels) return missing("Layer", key);
              return this.node(levels, layer, comp);
            }
            case "numProperties":
              return layer.properties.length;
            case "toWorld":
              return (p: unknown, t?: unknown) => {
                const v = vec(p);
                const r = world(t).transformPoint([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
                return v.length >= 3 ? r : r.slice(0, 2);
              };
            case "fromWorld":
              return (p: unknown, t?: unknown) => {
                const v = vec(p);
                const r = world(t).inverse().transformPoint([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
                return v.length >= 3 ? r : r.slice(0, 2);
              };
            case "toWorldVec":
            case "toCompVec":
              return (p: unknown, t?: unknown) => {
                const v = vec(p);
                const r = world(t).transformVector([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
                return v.length >= 3 ? r : r.slice(0, 2);
              };
            case "fromWorldVec":
            case "fromCompVec":
              return (p: unknown, t?: unknown) => {
                const v = vec(p);
                const r = world(t).inverse().transformVector([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
                return v.length >= 3 ? r : r.slice(0, 2);
              };
            case "toComp":
              return (p: unknown, t?: unknown) => {
                const time = t === undefined ? this.time : scalar(t);
                const v = vec(p);
                const w = worldMatrix(layer, comp, time).transformPoint([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
                if (!is3D()) return v.length >= 3 ? w : w.slice(0, 2);
                const cam = activeCameraLayer(comp, time);
                const [x, y] = cam ? projectThroughCamera(w, cameraAt(comp, time, cam), comp) : projectToComp(w, comp);
                return v.length >= 3 ? [x, y, w[2]] : [x, y];
              };
            case "fromComp":
            case "fromCompToSurface":
              return (p: unknown, t?: unknown) => {
                const time = t === undefined ? this.time : scalar(t);
                const v = vec(p);
                if (!is3D()) {
                  const r = worldMatrix(layer, comp, time).inverse().transformPoint([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
                  return v.length >= 3 && key === "fromComp" ? r : r.slice(0, 2);
                }
                const r = compPointToSource(layer, comp, [v[0] ?? 0, v[1] ?? 0], time);
                return v.length >= 3 && key === "fromComp" ? [r[0], r[1], 0] : r;
              };
            case "sourceRectAtTime":
              return (t?: unknown, includeExtents?: unknown) => this.sourceRect(layer, comp, t === undefined ? this.time : scalar(t), !!unwrap(includeExtents));
            case "sourceTime":
              return (t?: unknown) => {
                const time = t === undefined ? this.time : scalar(t);
                const remap = top("ADBE Time Remapping");
                if (layer.timeRemapEnabled && remap?.kind === "property") return scalar(this.valueAt(remap, layer, time));
                return layerTimeAt(layer, time);
              };
            case "sampleImage":
              throw new Error("sampleImage() is not supported yet");
          }
          return missing("Layer", key);
        },
      };
      const facade = apiObject(node, "Layer");
      this.layerByFacade.set(facade as object, layer);
      return facade;
    });
  }

  /** A layer's or comp's Marker property: numKeys, key(index or comment), nearestKey(t). */
  private markers(owner: object, list: () => Marker[]): unknown {
    return this.cached(owner, "marker", () => {
      const markerKey = (m: Marker, index: number) =>
        apiObject(
          {
            get: (key) => {
              switch (key) {
                case "time":
                  return m.time;
                case "index":
                  return index;
                case "duration":
                case "comment":
                case "chapter":
                case "url":
                case "frameTarget":
                case "eventCuePoint":
                case "cuePointName":
                case "protectedRegion":
                case "label":
                  return m[key];
                case "parameters":
                  return { ...m.parameters };
              }
              return missing("MarkerKey", key);
            },
          },
          "MarkerKey",
        );
      const node: ApiNode = {
        get: (key) => {
          switch (key) {
            case "numKeys":
              return list().length;
            case "key":
              return (k: unknown) => {
                const markers = list();
                const u = unwrap(k);
                const i = typeof u === "number" ? Math.round(u) - 1 : markers.findIndex((m) => m.comment === String(u));
                if (!markers[i]) throw new RangeError(typeof u === "number" ? `marker index ${u} out of range (there are ${markers.length} markers)` : `no marker has the comment '${String(u)}'`);
                return markerKey(markers[i], i + 1);
              };
            case "nearestKey":
              return (t: unknown) => {
                const markers = list();
                if (!markers.length) throw new RangeError("there are no markers");
                const time = t === undefined ? this.time : scalar(t);
                let best = 0;
                markers.forEach((m, i) => {
                  if (Math.abs(m.time - time) < Math.abs(markers[best].time - time)) best = i;
                });
                return markerKey(markers[best], best + 1);
              };
            case "name":
              return "Marker";
          }
          return missing("Property", key);
        },
      };
      return apiObject(node, "Property");
    });
  }

  /** sourceRectAtTime(): the layer's source bounds; shape layers measure their paths. */
  private sourceRect(layer: Layer, comp: CompItem, t: number, includeExtents: boolean): unknown {
    const rect = (left: number, top: number, width: number, height: number) => ({ top, left, width, height });
    if (layer.layerType === "ShapeLayer") {
      const root = layer.properties.find((n) => n.matchName === "ADBE Root Vectors Group");
      const b = root?.kind === "group" ? this.shapeBounds(root.children, layer, t, includeExtents) : null;
      return b ? rect(b[0], b[1], b[2] - b[0], b[3] - b[1]) : rect(0, 0, 0, 0);
    }
    if (layer.layerType === "TextLayer") return rect(0, 0, 0, 0);
    const item = layer.sourceId ? this.host.frame().project.items.get(layer.sourceId) : undefined;
    if (item && item.kind !== "folder") return rect(0, 0, item.width, item.height);
    return rect(0, 0, layer.width || comp.width, layer.height || comp.height);
  }

  private shapeBounds(items: PropertyNode[], layer: Layer, t: number, extents: boolean): [number, number, number, number] | null {
    let box: [number, number, number, number] | null = null;
    const grow = (x: number, y: number, pad = 0) => {
      if (!box) box = [x - pad, y - pad, x + pad, y + pad];
      else box = [Math.min(box[0], x - pad), Math.min(box[1], y - pad), Math.max(box[2], x + pad), Math.max(box[3], y + pad)];
    };
    const get = (g: PropertyGroup, m: string): unknown => {
      const p = g.children.find((c) => c.matchName === m);
      return p?.kind === "property" ? this.host.modelValue(p, layer, t) : undefined;
    };
    let stroke = 0;
    for (const item of items) {
      if (item.kind === "group" && item.enabled && item.matchName === "ADBE Vector Graphic - Stroke") stroke = Math.max(stroke, scalar(get(item, "ADBE Vector Stroke Width") ?? 0));
    }
    const pad = extents ? stroke / 2 : 0;
    for (const item of items) {
      if (item.kind !== "group" || !item.enabled) continue;
      const pos = (m: string) => vec(get(item, m) ?? [0, 0]);
      switch (item.matchName) {
        case "ADBE Vector Shape - Rect":
        case "ADBE Vector Shape - Ellipse": {
          const prefix = item.matchName.endsWith("Rect") ? "ADBE Vector Rect" : "ADBE Vector Ellipse";
          const [px, py] = pos(`${prefix} Position`);
          const [sx, sy] = vec(get(item, `${prefix} Size`) ?? [100, 100]);
          grow(px - sx / 2, py - sy / 2, pad);
          grow(px + sx / 2, py + sy / 2, pad);
          break;
        }
        case "ADBE Vector Shape - Star": {
          const [px, py] = pos("ADBE Vector Star Position");
          const r = scalar(get(item, "ADBE Vector Star Outer Radius") ?? 100);
          grow(px - r, py - r, pad);
          grow(px + r, py + r, pad);
          break;
        }
        case "ADBE Vector Shape - Group": {
          const s = get(item, "ADBE Vector Shape");
          if (s && isShapeValue(s as PropertyValue)) for (const v of (s as Shape).vertices) grow(v[0], v[1], pad);
          break;
        }
        case "ADBE Vector Group": {
          const contents = item.children.find((c) => c.matchName === "ADBE Vectors Group");
          const inner = contents?.kind === "group" ? this.shapeBounds(contents.children, layer, t, extents) : null;
          if (!inner) break;
          const tg = item.children.find((c) => c.matchName === "ADBE Vector Transform Group");
          let corners = [[inner[0], inner[1]], [inner[2], inner[1]], [inner[2], inner[3]], [inner[0], inner[3]]];
          if (tg?.kind === "group") {
            const [ax, ay] = vec(get(tg, "ADBE Vector Anchor") ?? [0, 0]);
            const [gx, gy] = vec(get(tg, "ADBE Vector Position") ?? [0, 0]);
            const [sx, sy] = vec(get(tg, "ADBE Vector Scale") ?? [100, 100]);
            const r = (scalar(get(tg, "ADBE Vector Rotation") ?? 0) * Math.PI) / 180;
            corners = corners.map(([x, y]) => {
              const lx = ((x - ax) * sx) / 100;
              const ly = ((y - ay) * sy) / 100;
              return [gx + lx * Math.cos(r) - ly * Math.sin(r), gy + lx * Math.sin(r) + ly * Math.cos(r)];
            });
          }
          for (const [x, y] of corners) grow(x, y);
          break;
        }
      }
    }
    return box;
  }

  // --- property groups and properties ------------------------------------------------------

  /** The API object for any property tree node. */
  node(n: PropertyNode, layer: Layer, comp: CompItem): unknown {
    if (n.kind === "group") return this.group(n, layer, comp);
    if (n.propertyValueType === PropertyValueType.LAYER_INDEX) {
      const index = scalar(this.valueAt(n, layer, this.time));
      return index > 0 && comp.layers[index - 1] ? this.layer(comp.layers[index - 1], comp) : null;
    }
    return this.property(n, layer, comp);
  }

  private propertyGroupOf(n: PropertyNode, layer: Layer, comp: CompItem) {
    return (countUp: unknown = 1) => {
      let current: PropertyNode | null | undefined = n;
      for (let i = 0; i < Math.max(1, Math.round(scalar(countUp))); i++) {
        current = current ? this.host.index.parent(layer, current) : null;
        if (current === null) return this.layer(layer, comp);
        if (current === undefined) throw new RangeError("propertyGroup() went past the layer");
      }
      return this.group(current as PropertyGroup, layer, comp);
    };
  }

  group(g: PropertyGroup, layer: Layer, comp: CompItem): unknown {
    return this.cached(g, "group", () => {
      const isEffect = !!g.isEffect;
      const param = (key: unknown) => {
        const k = unwrap(key);
        const found =
          isEffect && typeof k === "number"
            ? g.children.find((c) => c.matchName === `${g.matchName}-${String(Math.round(k)).padStart(4, "0")}`)
            : childOf(g.children, key);
        if (!found) throw new Error(`property named '${String(k)}' is missing or does not exist`);
        return this.node(found, layer, comp);
      };
      const node: ApiNode = {
        invoke: (args) => param(args[0]),
        get: (key) => {
          switch (key) {
            case "name":
              return g.name;
            case "numProperties":
              return g.children.length;
            case "propertyIndex":
              return this.host.index.indexInParent(layer, g);
            case "propertyGroup":
              return this.propertyGroupOf(g, layer, comp);
            case "active":
            case "enabled":
              return g.enabled;
            case "param":
              return param;
            case "content":
              if (g.matchName === "ADBE Vector Group" || g.matchName === "ADBE Root Vectors Group") {
                return (k: unknown) => {
                  const contents = g.matchName === "ADBE Vector Group" ? g.children.find((c) => c.matchName === "ADBE Vectors Group") : g;
                  const found = contents?.kind === "group" ? childOf(contents.children, k) : undefined;
                  if (!found) throw new Error(`content named '${String(unwrap(k))}' is missing or does not exist`);
                  return this.node(found, layer, comp);
                };
              }
              break;
            case "invert":
              if (g.mask) return g.mask.inverted;
              break;
          }
          if (typeof key === "string") {
            const found = g.children.find((c) => attributeNames(c).includes(key));
            if (found) return this.node(found, layer, comp);
          }
          return missing(isEffect ? "Effect" : g.mask ? "Mask" : "Group", key);
        },
      };
      return apiObject(node, isEffect ? "Effect" : g.mask ? "Mask" : "Group");
    });
  }

  property(p: Property, layer: Layer, comp: CompItem): unknown {
    return this.cached(p, "property", () => {
      const at = (t: unknown) => (t === undefined ? this.time : scalar(t));
      const valueAt = (t: number) => this.valueAt(p, layer, t);
      const node: ApiNode = {
        primitive: () => valueAt(this.time),
        get: (key) => {
          if (isIndexKey(key)) {
            const v = valueAt(this.time);
            return Array.isArray(v) ? v[Number(key)] : typeof v === "string" ? v[Number(key)] : undefined;
          }
          switch (key) {
            case "value":
              return valueAt(this.time);
            case "length": {
              const v = valueAt(this.time);
              if (Array.isArray(v) || typeof v === "string") return v.length;
              return missing("Property", key);
            }
            case "text":
              if (p.propertyValueType === PropertyValueType.TEXT_DOCUMENT) return textOf(p);
              break;
            case "valueAtTime":
              return (t: unknown) => valueAt(scalar(t));
            case "velocity":
              return this.velocity(p, layer, this.time);
            case "velocityAtTime":
              return (t: unknown) => this.velocity(p, layer, scalar(t));
            case "speed":
              return this.speed(p, layer, this.time);
            case "speedAtTime":
              return (t: unknown) => this.speed(p, layer, scalar(t));
            case "numKeys":
              return p.keyframes.length;
            case "key":
              return (k: unknown) => this.key(p, layer, k);
            case "nearestKey":
              return (t: unknown) => {
                if (!p.keyframes.length) throw new RangeError("the property has no keyframes");
                const time = at(t);
                let best = 0;
                p.keyframes.forEach((k, i) => {
                  if (Math.abs(k.time - time) < Math.abs(p.keyframes[best].time - time)) best = i;
                });
                return this.key(p, layer, best + 1);
              };
            case "name":
              return p.name;
            case "propertyIndex":
              return this.host.index.indexInParent(layer, p);
            case "propertyGroup":
              return this.propertyGroupOf(p, layer, comp);
            case "active":
            case "enabled":
              return p.enabled;
            case "wiggle":
              return (freq: unknown, amp: unknown, octaves: unknown = 1, ampMult: unknown = 0.5, t?: unknown) =>
                this.wiggle(p, layer, scalar(freq), num(amp), scalar(octaves), scalar(ampMult), at(t));
            case "temporalWiggle":
              return (freq: unknown, amp: unknown, octaves: unknown = 1, ampMult: unknown = 0.5, t?: unknown) => {
                const time = at(t);
                const offset = wiggleOffset(this.wiggleSeed(p, layer, 0), time, scalar(freq), scalar(amp), scalar(octaves), scalar(ampMult));
                return valueAt(time + offset);
              };
            case "smooth":
              return (width: unknown = 0.2, samples: unknown = 5, t?: unknown) => this.smooth(p, layer, scalar(width), Math.max(1, Math.round(scalar(samples))), at(t));
            case "loopIn":
            case "loopOut":
              return (type: unknown = "cycle", numKeyframes: unknown = 0) => this.loop(p, layer, key === "loopIn", String(unwrap(type)), { keys: scalar(numKeyframes) });
            case "loopInDuration":
            case "loopOutDuration":
              return (type: unknown = "cycle", duration: unknown = 0) => this.loop(p, layer, key === "loopInDuration", String(unwrap(type)), { duration: scalar(duration) });
            case "points":
            case "inTangents":
            case "outTangents":
            case "isClosed":
            case "pointOnPath":
            case "tangentOnPath":
            case "normalOnPath":
              if (p.propertyValueType === PropertyValueType.SHAPE) {
                return (...args: unknown[]) => {
                  // Path methods take an optional time last: points(t), pointOnPath(pct, t).
                  const timed = key === "pointOnPath" || key === "tangentOnPath" || key === "normalOnPath" ? args[1] : args[0];
                  const pathValue = valueAt(at(timed));
                  const f = apiNodeOf(pathValue)!.get(key) as (...a: unknown[]) => unknown;
                  return key === "pointOnPath" || key === "tangentOnPath" || key === "normalOnPath" ? f(args[0] ?? 0.5) : f();
                };
              }
              break;
            case "createPath":
              if (p.propertyValueType === PropertyValueType.SHAPE) return (...args: unknown[]) => this.createPath(...args);
              break;
          }
          return missing("Property", key);
        },
      };
      return apiObject(node, "Property");
    });
  }

  // --- keys -------------------------------------------------------------------------

  private key(p: Property, layer: Layer, k: unknown): unknown {
    const i = Math.round(scalar(k));
    const kf = p.keyframes[i - 1];
    if (!kf) throw new RangeError(`key index ${i} out of range (the property has ${p.keyframes.length} keys)`);
    const value = () => this.toExpression(p, layer, kf.value);
    return apiObject(
      {
        primitive: value,
        get: (key) => {
          if (isIndexKey(key)) {
            const v = value();
            return Array.isArray(v) ? v[Number(key)] : undefined;
          }
          switch (key) {
            case "time":
              return kf.time;
            case "value":
              return value();
            case "index":
              return i;
          }
          return missing("Key", key);
        },
      },
      "Key",
    );
  }

  // --- motion -----------------------------------------------------------------------

  /** Finite-difference step (seconds) for velocities. */
  private readonly H = 1e-6;

  velocity(p: Property, layer: Layer, t: number): unknown {
    const onKey = p.keyframes.some((k) => Math.abs(k.time - t) < 1e-9);
    const a = num(this.valueAt(p, layer, onKey ? t : t - this.H));
    const b = num(this.valueAt(p, layer, t + this.H));
    return div(sub(b, a), onKey ? this.H : 2 * this.H);
  }

  speed(p: Property, layer: Layer, t: number): number {
    const v = this.velocity(p, layer, t);
    return Array.isArray(v) ? Math.hypot(...v) : Math.abs(v as number);
  }

  private smooth(p: Property, layer: Layer, width: number, samples: number, t: number): unknown {
    if (samples === 1) return this.valueAt(p, layer, t);
    let sum: unknown = 0;
    for (let i = 0; i < samples; i++) {
      const v = num(this.valueAt(p, layer, t - width / 2 + (width * i) / (samples - 1)));
      sum = i === 0 ? v : add(sum, v);
    }
    return div(sum, samples);
  }

  /** Seed for one dimension of a property's wiggle, from the layer index, property position and seedRandom offset. */
  wiggleSeed(p: Property, layer: Layer, dimension: number): number {
    const frame = this.host.frame();
    const path = this.host.index.path(layer, p).map((n) => this.host.index.indexInParent(layer, n));
    return hashWords(0x77696767, layer.index, ...path, dimension, Math.round(frame.seedOffset * 1000));
  }

  private wiggle(p: Property, layer: Layer, freq: number, amp: number | number[], octaves: number, ampMult: number, t: number): unknown {
    const base = this.valueAt(p, layer, t);
    const b = num(base);
    if (!Array.isArray(b)) return b + wiggleOffset(this.wiggleSeed(p, layer, 0), t, freq, Array.isArray(amp) ? (amp[0] ?? 0) : amp, octaves, ampMult);
    return b.map((v, d) => v + wiggleOffset(this.wiggleSeed(p, layer, d), t, freq, Array.isArray(amp) ? (amp[d] ?? 0) : amp, octaves, ampMult));
  }

  /** loopIn/loopOut and their Duration forms: "cycle", "pingpong", "offset", "continue". */
  private loop(p: Property, layer: Layer, before: boolean, type: string, range: { keys?: number; duration?: number }): unknown {
    const t = this.time;
    const keys = p.keyframes;
    const value = (time: number) => this.valueAt(p, layer, time);
    if (keys.length < 2) return value(t);
    const first = keys[0].time;
    const last = keys[keys.length - 1].time;
    let start: number;
    let end: number;
    if (range.duration !== undefined) {
      const d = range.duration;
      if (before) {
        start = first;
        end = d > 0 ? first + d : layer.outPoint;
      } else {
        end = last;
        start = d > 0 ? last - d : layer.inPoint;
      }
    } else {
      const n = Math.round(range.keys ?? 0);
      const count = n <= 0 || n >= keys.length ? keys.length - 1 : n;
      if (before) {
        start = first;
        end = keys[count].time;
      } else {
        end = last;
        start = keys[keys.length - 1 - count].time;
      }
    }
    if (before ? t >= first : t <= last) return value(t);
    const span = end - start;
    if (span <= 0) return value(t);
    if (type === "continue") {
      // The slope with which the animation leaves its first or reaches its last key.
      const edge = before ? first : last;
      const inner = before ? edge + this.H : edge - this.H;
      const slope = div(sub(num(value(edge)), num(value(inner))), edge - inner);
      return add(num(value(edge)), mul(slope, t - edge));
    }
    const offsetFromStart = t - start;
    const cycles = Math.floor(offsetFromStart / span);
    let local = offsetFromStart - cycles * span;
    if (type === "pingpong" && Math.abs(cycles) % 2 === 1) local = span - local;
    const inCycle = value(start + local);
    if (type === "offset") {
      const delta = sub(num(value(end)), num(value(start)));
      return add(num(inCycle), mul(delta, cycles));
    }
    if (type === "cycle" || type === "pingpong") return inCycle;
    throw new TypeError(`unknown loop type '${type}' (use "cycle", "pingpong", "offset" or "continue")`);
  }
}

/** A Source Text value (a text document with its `text`), when the parser provides one. */
export function textDocumentOf(v: unknown): { text: string } | undefined {
  return v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string" ? (v as { text: string }) : undefined;
}

function textOf(p: Property): string {
  return typeof p.value === "string" ? p.value : (textDocumentOf(p.value)?.text ?? "");
}