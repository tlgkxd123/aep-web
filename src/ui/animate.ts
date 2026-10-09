import { currentValue, getExpressionScope, setExpressionScope, valueAtTime, type ExpressionScope } from "../aep/evaluate.ts";
import type { CompItem, Layer, Project, Property, PropertyValue } from "../aep/model.ts";
import { sourcePointToComp } from "../aep/transform.ts";

/** `prop`'s value at comp time `t`, falling back to its stored value if it cannot be evaluated. */
export function valueAt(prop: Property, t: number, layer: Layer): PropertyValue {
  try {
    return valueAtTime(prop, t, layer);
  } catch {
    return prop.value;
  }
}

/** One expression scope per project and time, so the panels share evaluations while the playhead stays. */
const panelScopes = new WeakMap<Project, { time: number; scope: ExpressionScope }>();

/**
 * The value a panel shows: after the property's expression when one is enabled, as After Effects shows it (in
 * red). Evaluating it also records the expression's error for the expression row.
 */
export function shownValue(project: Project, prop: Property, t: number, layer: Layer): PropertyValue {
  if (!prop.expression || !prop.expressionEnabled) return valueAt(prop, t, layer);
  let entry = panelScopes.get(project);
  if (!entry || entry.time !== t) panelScopes.set(project, (entry = { time: t, scope: { project, warn: () => {} } }));
  const previous = getExpressionScope();
  setExpressionScope(entry.scope);
  try {
    return currentValue(prop, t, layer);
  } catch {
    return valueAt(prop, t, layer);
  } finally {
    setExpressionScope(previous);
  }
}

export const keyframeAt = (prop: Property, t: number, epsilon: number) =>
  prop.keyframes.findIndex((k) => Math.abs(k.time - t) < epsilon);

/** 2D affine matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

export function invert(m: Matrix): Matrix | undefined {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return undefined;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/**
 * Layer space to comp space for a 2D layer at comp time `t`, through its parent chain.
 * Exact only while the chain stays in the z = 0 plane; undefined if the layer lacks transform data.
 */
export function layerAffine(layer: Layer, comp: CompItem, t: number): Matrix | undefined {
  try {
    const [ox, oy] = sourcePointToComp(layer, comp, [0, 0], t);
    const [xx, xy] = sourcePointToComp(layer, comp, [1, 0], t);
    const [yx, yy] = sourcePointToComp(layer, comp, [0, 1], t);
    return [xx - ox, xy - oy, yx - ox, yy - oy, ox, oy];
  } catch {
    return undefined;
  }
}
