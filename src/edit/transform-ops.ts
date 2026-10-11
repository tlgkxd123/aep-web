// Layer > Transform commands and Composition-panel direct manipulation
// (move, handle scale, rotate, pan behind, nudge). Values are worked out in
// comp space and taken through the parent chain into the space each Transform
// property is stored in; keyframed properties get a keyframe at `time`
// through Editor.setValue.
import { valueAtTime } from "../aep/evaluate.ts";
import type { CompItem, Layer, Property, PropertyGroup } from "../aep/model.ts";
import { localTransform, Mat4, worldMatrix } from "../aep/transform.ts";
import type { CommandOptions, Editor } from "./editor.ts";
import { materializeTransformProp } from "./layer-templates.ts";

type Vec2 = [number, number];
/** 2x2 linear map, row-major: [a, b, c, d] maps (x, y) to (a·x + b·y, c·x + d·y). */
type Lin = [number, number, number, number];

const DEG = Math.PI / 180;

const linOf = (m: Mat4): Lin => [m.m[0], m.m[1], m.m[4], m.m[5]];
const mulLin = (p: Lin, q: Lin): Lin => [p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3], p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3]];
const applyLin = (l: Lin, [x, y]: Vec2): Vec2 => [l[0] * x + l[1] * y, l[2] * x + l[3] * y];
const detLin = (l: Lin) => l[0] * l[3] - l[1] * l[2];
const rotLin = (deg: number): Lin => {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c, -s, s, c];
};

function invertLin(l: Lin): Lin {
  const det = detLin(l);
  if (Math.abs(det) < 1e-12) throw new Error("The layer's transform is degenerate (zero scale)");
  return [l[3] / det, -l[1] / det, -l[2] / det, l[0] / det];
}

/** Scale (percent) and rotation (degrees) of a 2x2 map R(rotation)·S(scale); a mirror lands in the y scale. */
export function decomposeLin(l: Lin): { scale: Vec2; rotation: number } {
  const sx = Math.hypot(l[0], l[2]);
  const rotation = Math.atan2(l[2], l[0]) / DEG;
  const sy = sx ? detLin(l) / sx : Math.hypot(l[1], l[3]);
  return { scale: [sx * 100, sy * 100], rotation };
}

const transformGroup = (layer: Layer) =>
  layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Transform Group");

export function transformProp(layer: Layer, matchName: string): Property | undefined {
  const node = transformGroup(layer)?.children.find((n) => n.matchName === matchName);
  return node?.kind === "property" ? node : undefined;
}

/** A Transform property's value at comp time `time`, as numbers (one for Rotation and Opacity). */
export function transformValueAt(layer: Layer, matchName: string, time: number): number[] {
  const prop = transformProp(layer, matchName);
  if (!prop) return [];
  const value = valueAtTime(prop, time, layer, transformGroup(layer)?.children);
  return typeof value === "number" ? [value] : Array.isArray(value) ? [...value] : [];
}

/** The 2D map from the space Position is stored in (the parent's layer space) to comp space. */
function parentLin(comp: CompItem, layer: Layer, time: number): Lin {
  const parent = layer.parentId ? comp.layers.find((l) => l.id === layer.parentId) : undefined;
  return parent ? linOf(worldMatrix(parent, comp, time)) : [1, 0, 0, 1];
}

function parentAffine(comp: CompItem, layer: Layer, time: number): { lin: Lin; origin: Vec2 } {
  const parent = layer.parentId ? comp.layers.find((l) => l.id === layer.parentId) : undefined;
  if (!parent) return { lin: [1, 0, 0, 1], origin: [0, 0] };
  const m = worldMatrix(parent, comp, time);
  return { lin: linOf(m), origin: [m.m[3], m.m[7]] };
}

/** Comp point to the parent space Position is stored in. */
function compToParent(comp: CompItem, layer: Layer, time: number, [x, y]: Vec2): Vec2 {
  const { lin, origin } = parentAffine(comp, layer, time);
  return applyLin(invertLin(lin), [x - origin[0], y - origin[1]]);
}

const sourcePixelAspect = (editor: Editor, comp: CompItem, layer: Layer): number => {
  const source = editor.project.items.get(layer.sourceId);
  const par = source && source.kind !== "folder" ? source.pixelAspect : 1;
  return (par || 1) / (comp.pixelAspect || 1);
};

export interface TransformEdit {
  anchor?: number[];
  position?: number[];
  scale?: number[];
  rotation?: number;
  opacity?: number;
  orientation?: number[];
  rotationX?: number;
  rotationY?: number;
}

const EDIT_PROPS: [keyof TransformEdit, string][] = [
  ["anchor", "ADBE Anchor Point"],
  ["position", "ADBE Position"],
  ["scale", "ADBE Scale"],
  ["orientation", "ADBE Orientation"],
  ["rotationX", "ADBE Rotate X"],
  ["rotationY", "ADBE Rotate Y"],
  ["rotation", "ADBE Rotate Z"],
  ["opacity", "ADBE Opacity"],
];

const sameValue = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

/**
 * Writes Transform values of one layer at `time`, keeping the components a
 * partial vector leaves out. Must run inside `editor.perform`, which refreshes
 * the comp after each write; the layer is looked up again by id each time.
 */
export function writeTransform(editor: Editor, comp: CompItem, layerId: number, edit: TransformEdit, time: number): void {
  for (const [key, matchName] of EDIT_PROPS) {
    const wanted = edit[key];
    if (wanted === undefined) continue;
    const layer = comp.layers.find((l) => l.id === layerId);
    const prop = layer && transformProp(layer, matchName);
    if (!layer || !prop) continue;
    const before = transformValueAt(layer, matchName, time);
    const values = typeof wanted === "number" ? [wanted] : wanted;
    const next = before.length ? before.map((v, i) => values[i] ?? v) : values;
    if (sameValue(before, next)) continue;
    if (matchName === "ADBE Position" && prop.dimensionsSeparated) {
      next.forEach((v, i) => {
        const follower = editable(editor, comp, layerId, `ADBE Position_${i}`);
        if (follower && Math.abs(v - before[i]) > 1e-9) editor.setValue(comp, follower.layer, follower.prop, v, time);
      });
      continue;
    }
    const target = editable(editor, comp, layerId, matchName);
    if (target) editor.setValue(comp, target.layer, target.prop, next.length > 1 || Array.isArray(prop.value) ? next : next[0], time);
  }
}

/** The layer and Transform property, with the property's chunks written first when AE left them out. */
export function editable(editor: Editor, comp: CompItem, layerId: number, matchName: string): { layer: Layer; prop: Property } | undefined {
  const find = () => {
    const layer = comp.layers.find((l) => l.id === layerId);
    const prop = layer && transformProp(layer, matchName);
    return layer && prop ? { layer, prop } : undefined;
  };
  const found = find();
  if (!found?.prop.synthesized) return found;
  editor.perform("", [comp], (tx) => materializeTransformProp(tx, comp, found.layer, matchName));
  return find();
}

/** Runs `body` for each layer id as one undoable command. */
function each(editor: Editor, comp: CompItem, label: string, layers: Layer[], body: (layer: Layer) => void, options: CommandOptions = {}): void {
  const ids = layers.map((l) => l.id);
  if (!ids.length) return;
  editor.perform(
    label,
    [comp],
    () => {
      for (const id of ids) {
        const layer = comp.layers.find((l) => l.id === id);
        if (layer) body(layer);
      }
    },
    options,
  );
}

const hasTransform = (layer: Layer) =>
  layer.layerType !== "CameraLayer" && layer.layerType !== "LightLayer" && !!transformProp(layer, "ADBE Position");

/** Layers whose content rectangle is their source's frame (shape and text bounds come from their contents). */
const hasSourceFrame = (layer: Layer) => hasTransform(layer) && !!layer.sourceId && layer.width > 0 && layer.height > 0;

// ---------------------------------------------------------------- Layer > Transform

export type FitMode = "both" | "width" | "height";

const FIT_LABELS: Record<FitMode, string> = { both: "Fit to Comp", width: "Fit to Comp Width", height: "Fit to Comp Height" };

/**
 * Fit to Comp / Width / Height: Scale and Position so the layer's source
 * rectangle covers the comp (non-uniform) or spans its width or height
 * (uniform, centred). Rotation is kept and the fit is taken through the
 * parent chain.
 */
export function fitToComp(editor: Editor, comp: CompItem, layers: Layer[], mode: FitMode, time: number): void {
  each(editor, comp, FIT_LABELS[mode], layers.filter(hasSourceFrame), (layer) => {
    const k = sourcePixelAspect(editor, comp, layer);
    const w = layer.width * k;
    const h = layer.height;
    const fx = comp.width / w;
    const fy = comp.height / h;
    const [sx, sy] = mode === "both" ? [fx, fy] : mode === "width" ? [fx, fx] : [fy, fy];
    const anchor = transformValueAt(layer, "ADBE Anchor Point", time);
    const rotation = transformValueAt(layer, "ADBE Rotate Z", time)[0] ?? 0;
    const parent = parentLin(comp, layer, time);
    const world = decomposeLin(mulLin(parent, rotLin(rotation)));
    const worldLin = mulLin(rotLin(world.rotation), [sx * Math.sign(world.scale[0] || 1), 0, 0, sy * Math.sign(world.scale[1] || 1)]);
    const local = decomposeLin(mulLin(invertLin(parent), worldLin));
    const offset = applyLin(worldLin, [(anchor[0] - layer.width / 2) * k, anchor[1] - layer.height / 2]);
    const position = compToParent(comp, layer, time, [comp.width / 2 + offset[0], comp.height / 2 + offset[1]]);
    const scale = transformValueAt(layer, "ADBE Scale", time);
    writeTransform(editor, comp, layer.id, { scale: [local.scale[0], local.scale[1], scale[2] ?? 100], position, rotation: local.rotation }, time);
  });
}

/** Layer > Transform > Center In View: the anchor point goes to the centre of the comp. */
export function centerInView(editor: Editor, comp: CompItem, layers: Layer[], time: number): void {
  each(editor, comp, "Center In View", layers.filter(hasTransform), (layer) => {
    writeTransform(editor, comp, layer.id, { position: compToParent(comp, layer, time, [comp.width / 2, comp.height / 2]) }, time);
  });
}

/** Layer > Transform > Center Anchor Point in Layer Content; Position compensates so the layer stays put. */
export function centerAnchorPoint(editor: Editor, comp: CompItem, layers: Layer[], time: number): void {
  each(editor, comp, "Center Anchor Point", layers.filter(hasSourceFrame), (layer) => {
    const anchor = transformValueAt(layer, "ADBE Anchor Point", time);
    const target: Vec2 = [layer.width / 2, layer.height / 2];
    const lin = linOf(localMatrixOf(layer, time));
    const k = sourcePixelAspect(editor, comp, layer);
    const shift = applyLin(lin, [(target[0] - anchor[0]) * k, target[1] - anchor[1]]);
    const position = transformValueAt(layer, "ADBE Position", time);
    writeTransform(editor, comp, layer.id, { anchor: target, position: [position[0] + shift[0], position[1] + shift[1]] }, time);
  });
}

function localMatrixOf(layer: Layer, time: number): Mat4 {
  const t = localTransform(layer, time);
  return Mat4.rotateZ(t.rotateZ).mul(Mat4.scale(t.scale[0] / 100, t.scale[1] / 100, t.scale[2] / 100));
}

/** Layer > Transform > Reset: AE's defaults for every Transform property. */
export function resetTransform(editor: Editor, comp: CompItem, layers: Layer[], time: number): void {
  each(editor, comp, "Reset Transform", layers.filter(hasTransform), (layer) => {
    const anchor: Vec2 = hasSourceFrame(layer) ? [layer.width / 2, layer.height / 2] : [0, 0];
    writeTransform(
      editor,
      comp,
      layer.id,
      {
        anchor: [...anchor, 0],
        position: [comp.width / 2, comp.height / 2, 0],
        scale: [100, 100, 100],
        orientation: [0, 0, 0],
        rotationX: 0,
        rotationY: 0,
        rotation: 0,
        opacity: 100,
      },
      time,
    );
  });
}

/** Layer > Transform > Flip Horizontal / Vertical: one Scale component times -1. */
export function flipLayers(editor: Editor, comp: CompItem, layers: Layer[], axis: "horizontal" | "vertical", time: number): void {
  each(editor, comp, axis === "horizontal" ? "Flip Horizontal" : "Flip Vertical", layers.filter(hasTransform), (layer) => {
    const scale = transformValueAt(layer, "ADBE Scale", time);
    const i = axis === "horizontal" ? 0 : 1;
    scale[i] = -scale[i];
    writeTransform(editor, comp, layer.id, { scale }, time);
  });
}

/** Arrow keys: Position moves by `delta` (1 or 10 px) in its own units. */
export function nudgeLayers(editor: Editor, comp: CompItem, layers: Layer[], delta: Vec2, time: number): void {
  each(editor, comp, "Nudge Position", layers.filter(hasTransform), (layer) => {
    const position = transformValueAt(layer, "ADBE Position", time);
    writeTransform(editor, comp, layer.id, { position: [position[0] + delta[0], position[1] + delta[1]] }, time);
  });
}

// ---------------------------------------------------------------- parenting

/**
 * Sets the parent and rewrites the child's Position, Scale and Rotation so it
 * stays where it is in the comp (the parent pick whip without Shift). Keyed
 * Position keys are taken through the same parent change.
 */
export function setParentKeepingTransform(editor: Editor, comp: CompItem, layer: Layer, parentId: number, time: number): void {
  const id = layer.id;
  editor.perform("Change parent", [comp], () => {
    const child = comp.layers.find((l) => l.id === id);
    if (!child || child.parentId === parentId) return;
    const oldParent = parentAffine(comp, child, time);
    const newParentLayer = parentId ? comp.layers.find((l) => l.id === parentId) : undefined;
    const newParent: { lin: Lin; origin: Vec2 } = newParentLayer
      ? (() => {
          const m = worldMatrix(newParentLayer, comp, time);
          return { lin: linOf(m), origin: [m.m[3], m.m[7]] as Vec2 };
        })()
      : { lin: [1, 0, 0, 1], origin: [0, 0] };
    const rotation = transformValueAt(child, "ADBE Rotate Z", time)[0] ?? 0;
    const scale = transformValueAt(child, "ADBE Scale", time);
    const local: Lin = mulLin(rotLin(rotation), [scale[0] / 100, 0, 0, scale[1] / 100]);
    const remapLin = mulLin(invertLin(newParent.lin), oldParent.lin);
    const remap = ([x, y]: number[]): Vec2 => {
      const [cx, cy] = applyLin(oldParent.lin, [x, y]);
      return applyLin(invertLin(newParent.lin), [cx + oldParent.origin[0] - newParent.origin[0], cy + oldParent.origin[1] - newParent.origin[1]]);
    };
    const next = decomposeLin(mulLin(remapLin, local));
    editor.setParent(comp, child, parentId);
    const fresh = () => comp.layers.find((l) => l.id === id)!;
    const positionProp = transformProp(fresh(), "ADBE Position");
    if (positionProp?.keyframes.length && !positionProp.dimensionsSeparated) {
      positionProp.keyframes.forEach((key, index) => {
        const value = key.value as number[];
        const [x, y] = remap(value);
        const p = transformProp(fresh(), "ADBE Position")!;
        editor.setKeyframeValue(comp, fresh(), p, index, [x, y, ...value.slice(2)], {});
      });
    } else {
      const position = transformValueAt(child, "ADBE Position", time);
      writeTransform(editor, comp, id, { position: remap(position) }, time);
    }
    const scaleProp = transformProp(fresh(), "ADBE Scale");
    if (!scaleProp?.keyframes.length) writeTransform(editor, comp, id, { scale: [next.scale[0], next.scale[1], scale[2] ?? 100] }, time);
    const rotationProp = transformProp(fresh(), "ADBE Rotate Z");
    if (rotationProp?.keyframes.length) {
      const offset = next.rotation - rotation;
      rotationProp.keyframes.forEach((key, index) => {
        const p = transformProp(fresh(), "ADBE Rotate Z")!;
        editor.setKeyframeValue(comp, fresh(), p, index, (key.value as number) + offset, {});
      });
    } else writeTransform(editor, comp, id, { rotation: next.rotation }, time);
  });
}

// ---------------------------------------------------------------- direct manipulation

export interface DragOptions {
  /** Collapses the drag into one undo step; pass the same key for every event of one drag. */
  coalesce?: string;
}

/**
 * Selection-tool drag: the layers follow the pointer by `delta` comp pixels,
 * measured from where the drag started. `constrain` (Shift) keeps the larger
 * axis only.
 */
export function moveLayers(editor: Editor, comp: CompItem, layers: Layer[], delta: Vec2, time: number, options: DragOptions & { constrain?: boolean } = {}): void {
  let [dx, dy] = delta;
  if (options.constrain) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  each(
    editor,
    comp,
    "Move",
    layers.filter(hasTransform),
    (layer) => {
      const shift = applyLin(invertLin(parentLin(comp, layer, time)), [dx, dy]);
      const position = transformValueAt(layer, "ADBE Position", time);
      writeTransform(editor, comp, layer.id, { position: [position[0] + shift[0], position[1] + shift[1]] }, time);
    },
    { coalesce: options.coalesce },
  );
}

/** A bounding-box handle: -1 / 0 / 1 per axis for left / centre / right and top / middle / bottom. */
export type Handle = [-1 | 0 | 1, -1 | 0 | 1];

/**
 * Handle drag: Scale changes around the anchor point so the grabbed handle
 * follows the pointer; corner handles scale freely, side handles one axis,
 * and `proportional` (Shift) keeps the current aspect ratio.
 */
export function scaleByHandle(
  editor: Editor,
  comp: CompItem,
  layer: Layer,
  handle: Handle,
  from: Vec2,
  to: Vec2,
  time: number,
  options: DragOptions & { proportional?: boolean } = {},
): void {
  const id = layer.id;
  editor.perform(
    "Scale",
    [comp],
    () => {
      const target = comp.layers.find((l) => l.id === id);
      if (!target || !hasTransform(target)) return;
      const k = sourcePixelAspect(editor, comp, target);
      const anchor = transformValueAt(target, "ADBE Anchor Point", time);
      const scale = transformValueAt(target, "ADBE Scale", time);
      const rotation = transformValueAt(target, "ADBE Rotate Z", time)[0] ?? 0;
      const toLayerFrame = invertLin(mulLin(parentLin(comp, target, time), rotLin(rotation)));
      const move = applyLin(toLayerFrame, [to[0] - from[0], to[1] - from[1]]);
      const grab: Vec2 = [((handle[0] + 1) / 2) * target.width - anchor[0], ((handle[1] + 1) / 2) * target.height - anchor[1]];
      const start: Vec2 = [grab[0] * k * (scale[0] / 100), grab[1] * (scale[1] / 100)];
      const end: Vec2 = [start[0] + move[0], start[1] + move[1]];
      const next = [scale[0], scale[1]];
      for (const axis of [0, 1] as const) {
        if (handle[axis] !== 0 && Math.abs(grab[axis]) > 1e-9) next[axis] = (end[axis] / (grab[axis] * (axis ? 1 : k))) * 100;
      }
      if (options.proportional && scale[0] && scale[1]) {
        let factor: number;
        if (handle[0] && handle[1]) {
          const length = start[0] * start[0] + start[1] * start[1];
          factor = length ? (end[0] * start[0] + end[1] * start[1]) / length : 1;
        } else factor = handle[0] ? next[0] / scale[0] : next[1] / scale[1];
        next[0] = scale[0] * factor;
        next[1] = scale[1] * factor;
      }
      writeTransform(editor, comp, id, { scale: [next[0], next[1], scale[2] ?? 100] }, time);
    },
    { coalesce: options.coalesce },
  );
}

/** Where the layer's anchor point lands in the comp. */
export function anchorInComp(comp: CompItem, layer: Layer, time: number): Vec2 {
  const anchor = transformValueAt(layer, "ADBE Anchor Point", time);
  const p = worldMatrix(layer, comp, time).transformPoint([anchor[0] ?? 0, anchor[1] ?? 0, anchor[2] ?? 0]);
  return [p[0], p[1]];
}

/** Rotation-tool drag around the anchor point; `snap` (Shift) lands on 45° steps. */
export function rotateByDrag(editor: Editor, comp: CompItem, layer: Layer, from: Vec2, to: Vec2, time: number, options: DragOptions & { snap?: boolean } = {}): void {
  const id = layer.id;
  editor.perform(
    "Rotate",
    [comp],
    () => {
      const target = comp.layers.find((l) => l.id === id);
      if (!target || !hasTransform(target)) return;
      const [cx, cy] = anchorInComp(comp, target, time);
      let delta = (Math.atan2(to[1] - cy, to[0] - cx) - Math.atan2(from[1] - cy, from[0] - cx)) / DEG;
      delta = ((delta + 540) % 360) - 180;
      if (detLin(parentLin(comp, target, time)) < 0) delta = -delta;
      const before = transformValueAt(target, "ADBE Rotate Z", time)[0] ?? 0;
      let rotation = before + delta;
      if (options.snap) rotation = Math.round(rotation / 45) * 45;
      writeTransform(editor, comp, id, { rotation }, time);
    },
    { coalesce: options.coalesce },
  );
}

/**
 * Pan Behind (Anchor Point) tool drag: the anchor point follows the pointer
 * and Position compensates so the layer stays put; `anchorOnly` (Alt) changes
 * the Anchor Point alone, so the layer moves instead.
 */
export function panBehind(editor: Editor, comp: CompItem, layer: Layer, delta: Vec2, time: number, options: DragOptions & { anchorOnly?: boolean } = {}): void {
  const id = layer.id;
  editor.perform(
    "Move Anchor Point",
    [comp],
    () => {
      const target = comp.layers.find((l) => l.id === id);
      if (!target || !hasTransform(target)) return;
      const k = sourcePixelAspect(editor, comp, target);
      const world = linOf(worldMatrix(target, comp, time));
      const inLayer = applyLin(invertLin(world), delta);
      const anchor = transformValueAt(target, "ADBE Anchor Point", time);
      const edit: TransformEdit = { anchor: [anchor[0] + inLayer[0] / k, anchor[1] + inLayer[1]] };
      if (!options.anchorOnly) {
        const shift = applyLin(invertLin(parentLin(comp, target, time)), delta);
        const position = transformValueAt(target, "ADBE Position", time);
        edit.position = [position[0] + shift[0], position[1] + shift[1]];
      }
      writeTransform(editor, comp, id, edit, time);
    },
    { coalesce: options.coalesce },
  );
}

// ---------------------------------------------------------------- Timeline value fields

const EDIT_KEYS = new Map(EDIT_PROPS.map(([key, matchName]) => [matchName, key]));

/** Whether the Timeline can edit this Transform property through `setTransformValue`. */
export const isTransformValue = (matchName: string) => EDIT_KEYS.has(matchName) || /^ADBE Position_[012]$/.test(matchName);

/**
 * One Transform property set at `time` the way the Timeline's value fields
 * do: the static value, or a keyframe when the stopwatch is on. Components
 * left out of `value` keep their value; separated Position dimensions take a number.
 */
export function setTransformValue(
  editor: Editor,
  comp: CompItem,
  layer: Layer,
  matchName: string,
  value: number | (number | undefined)[],
  time: number,
  options: CommandOptions = {},
): void {
  const separated = /^ADBE Position_([012])$/.exec(matchName);
  let edit: TransformEdit;
  if (separated) {
    const position: number[] = [];
    position[Number(separated[1])] = value as number;
    edit = { position };
  } else {
    const key = EDIT_KEYS.get(matchName);
    if (!key) throw new Error(`"${matchName}" is not a Transform value`);
    edit = { [key]: value } as TransformEdit;
  }
  const name = transformProp(layer, matchName)?.name ?? "Transform";
  const id = layer.id;
  editor.perform(`Change ${name}`, [comp], () => writeTransform(editor, comp, id, edit, time), options);
}

/** The stopwatch of a Transform property, which AE may have left out of the file while it held its default. */
export function toggleTransformStopwatch(editor: Editor, comp: CompItem, layer: Layer, matchName: string, time: number): void {
  const animated = !!transformProp(layer, matchName)?.keyframes.length;
  const id = layer.id;
  editor.perform(animated ? "Remove keyframes" : "Add keyframe", [comp], () => {
    const target = editable(editor, comp, id, matchName);
    if (target) editor.toggleStopwatch(comp, target.layer, target.prop, time);
  });
}
