// Fills in properties After Effects does not write to the file (it stores only
// non-default or touched values) so every layer exposes the full property set
// ExtendScript reports. Tables come from py-aep's synthesis specs.
import specTables from "./data/property-specs.json" with { type: "json" };
import { PropertyValueType, type Layer, type Property, type PropertyGroup, type PropertyNode, type PropertyValue } from "./model.ts";

interface Spec {
  matchName: string;
  name: string;
  group?: boolean;
  enabled?: boolean;
  value?: PropertyValue;
  pvt?: number;
  dimensions?: number;
  isSpatial?: boolean;
  color?: boolean;
  integer?: boolean;
  min?: number;
  max?: number;
  canVaryOverTime?: boolean;
}

interface SpecTables {
  groupChildren: Record<string, Spec[]>;
  topLevel: Spec[];
  parametricMeshTopLevel: Spec[];
  skip: Record<string, string[]>;
  transform: Spec[];
  transformFixedDefaults: Record<string, number | number[]>;
}

const tables = specTables as unknown as SpecTables;
// AE also reports Taper and Wave under a solid-color stroke, not only under gradient strokes.
for (const group of ["ADBE Vector Stroke Taper", "ADBE Vector Stroke Wave"]) {
  const stroke = tables.groupChildren["ADBE Vector Graphic - Stroke"];
  const source = tables.groupChildren["ADBE Vector Graphic - G-Stroke"]?.find((s) => s.matchName === group);
  if (stroke && source && !stroke.some((s) => s.matchName === group)) stroke.push(source);
}
const skipSets = new Map(Object.entries(tables.skip).map(([k, v]) => [k, new Set(v)]));

/** Display names from every spec table, used when the file and the match-name table have none. */
export const SPEC_NAMES: ReadonlyMap<string, string> = (() => {
  const names = new Map<string, string>();
  const add = (specs: Spec[]) => specs.forEach((s) => names.has(s.matchName) || names.set(s.matchName, s.name));
  Object.values(tables.groupChildren).forEach(add);
  add(tables.topLevel);
  add(tables.parametricMeshTopLevel);
  add(tables.transform);
  return names;
})();

const SPEC_BY_MATCH_NAME: ReadonlyMap<string, Spec> = (() => {
  const map = new Map<string, Spec>();
  for (const specs of Object.values(tables.groupChildren)) for (const s of specs) if (!map.has(s.matchName)) map.set(s.matchName, s);
  return map;
})();

function clone(value: PropertyValue | undefined): PropertyValue {
  if (value === undefined) return null;
  return Array.isArray(value) ? [...value] : value;
}

/** Value types ExtendScript reports where the spec tables carry a placeholder. */
const VALUE_TYPE_OVERRIDES: Record<string, number> = {
  "ADBE Mask Shape": PropertyValueType.SHAPE,
  "ADBE Vector Shape": PropertyValueType.SHAPE,
  "ADBE Text Path": PropertyValueType.MASK_INDEX,
};

function synthProperty(spec: Spec, value: PropertyValue = clone(spec.value)): Property {
  const prop: Property = {
    kind: "property",
    matchName: spec.matchName,
    name: spec.name,
    propertyValueType: VALUE_TYPE_OVERRIDES[spec.matchName] ?? spec.pvt ?? PropertyValueType.OneD,
    value,
    keyframes: [],
    expression: "",
    expressionEnabled: false,
    enabled: true,
    dimensionsSeparated: false,
    isSpatial: spec.isSpatial ?? false,
    canVaryOverTime: spec.canVaryOverTime ?? true,
    synthesized: true,
  };
  if (spec.min !== undefined) prop.min = spec.min;
  if (spec.max !== undefined) prop.max = spec.max;
  return prop;
}

function synthGroup(spec: Spec): PropertyGroup {
  return {
    kind: "group",
    matchName: spec.matchName,
    name: spec.name,
    enabled: spec.enabled ?? true,
    children: [],
    synthesized: true,
  };
}

export interface CompContext {
  width: number;
  height: number;
  pixelAspect: number;
}

/** Defaults that depend on the composition rather than being fixed per property. */
function compDefaults(groupMatchName: string, comp: CompContext): ((spec: Spec) => PropertyValue) | undefined {
  if (groupMatchName !== "ADBE Camera Options Group") return undefined;
  // AE's new-camera zoom is the 50mm lens for the comp width, rounded to 8 decimals.
  const zoom = Math.round(((comp.width * comp.pixelAspect) / 0.72) * 1e8) / 1e8;
  return (spec) =>
    spec.matchName === "ADBE Camera Zoom" || spec.matchName === "ADBE Camera Focus Distance" ? zoom : clone(spec.value);
}

/** Orders `existing` by `specs`, creating whatever is missing (unless skipped); extra nodes keep their order at the end. */
function reorderAndFill(
  existing: PropertyNode[],
  specs: Spec[],
  skip: ReadonlySet<string> = new Set(),
  valueFor?: (spec: Spec) => PropertyValue,
): PropertyNode[] {
  const pool = new Map<string, PropertyNode[]>();
  for (const node of existing) {
    const list = pool.get(node.matchName);
    if (list) list.push(node);
    else pool.set(node.matchName, [node]);
  }
  const ordered: PropertyNode[] = [];
  for (const spec of specs) {
    const found = pool.get(spec.matchName);
    if (found?.length) {
      for (const node of found) if (node.autoNamed) node.name = spec.name;
      ordered.push(...found);
      pool.delete(spec.matchName);
    } else if (!skip.has(spec.matchName)) {
      ordered.push(spec.group ? synthGroup(spec) : synthProperty(spec, valueFor ? valueFor(spec) : undefined));
    }
  }
  for (const node of existing) if (pool.has(node.matchName)) ordered.push(node);
  return ordered;
}

function fillGroup(group: PropertyGroup, comp: CompContext): void {
  const specs = tables.groupChildren[group.matchName];
  if (specs && !group.isEffect) {
    group.children = reorderAndFill(group.children, specs, new Set(), compDefaults(group.matchName, comp));
  }
  for (const child of group.children) {
    if (child.kind === "group") fillGroup(child, comp);
    else applySpecType(child);
  }
}

/** A few stored properties carry flags that do not reflect what ExtendScript reports. */
function applySpecType(prop: Property): void {
  if (prop.synthesized) return;
  const spec = SPEC_BY_MATCH_NAME.get(prop.matchName);
  if (spec?.pvt === PropertyValueType.NO_VALUE) prop.propertyValueType = PropertyValueType.NO_VALUE;
}

export function synthesizeLayer(layer: Layer, comp: CompContext): void {
  const isMesh = layer.layerType === "ParametricMeshLayer";
  const topSpecs = isMesh ? tables.parametricMeshTopLevel : tables.topLevel;
  const skip = isMesh ? new Set<string>() : (skipSets.get(layer.layerType) ?? skipSets.get("AVLayer")!);
  layer.properties = reorderAndFill(layer.properties, topSpecs, skip);

  const transform = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Transform Group");
  if (transform) fillTransform(layer, transform, comp);

  for (const node of layer.properties) {
    if (node.kind === "group" && node !== transform) fillGroup(node, comp);
    else if (node.kind === "property") applySpecType(node);
  }
}

function fillTransform(layer: Layer, transform: PropertyGroup, comp: CompContext): void {
  const camOrLight = layer.layerType === "CameraLayer" || layer.layerType === "LightLayer";
  const sourceless =
    layer.layerType === "TextLayer" ||
    layer.layerType === "ShapeLayer" ||
    layer.layerType === "ParametricMeshLayer" ||
    layer.layerType === "ThreeDModelLayer" ||
    layer.nullLayer;
  let anchor: number[];
  if (camOrLight) anchor = [comp.width / 2, comp.height / 2, 0];
  else if (sourceless) anchor = [0, 0, 0];
  // A source without pixels (audio) reports the anchor in its stored 0-1 form.
  else if (!layer.width || !layer.height) anchor = [0.5, 0.5, 0];
  else anchor = [layer.width / 2, layer.height / 2, 0];
  // A camera's default position sits one 50mm-lens zoom distance in front of the comp.
  const cameraZ = layer.layerType === "CameraLayer" ? -Math.round(((comp.width * comp.pixelAspect) / 0.72) * 1e8) / 1e8 : 0;
  const spatial: Record<string, PropertyValue> = {
    "ADBE Anchor Point": anchor,
    "ADBE Position": [comp.width / 2, comp.height / 2, cameraZ],
    "ADBE Position_0": 0,
    "ADBE Position_1": 0,
  };
  transform.children = reorderAndFill(transform.children, tables.transform, new Set(), (spec) => {
    const fixed = tables.transformFixedDefaults[spec.matchName];
    if (fixed !== undefined) return clone(fixed);
    if (spec.matchName in spatial) return clone(spatial[spec.matchName]);
    return (spec.dimensions ?? 1) > 1 ? new Array(spec.dimensions).fill(0) : 0;
  });
  if (layer.nullLayer) {
    const opacity = transform.children.find((n): n is Property => n.kind === "property" && n.matchName === "ADBE Opacity");
    if (opacity && opacity.value === 100) opacity.value = 0;
  }
  if (camOrLight) {
    const anchor = transform.children.find((n) => n.matchName === "ADBE Anchor Point");
    if (anchor && anchor.name === "Anchor Point") anchor.name = "Point of Interest";
  }
}
