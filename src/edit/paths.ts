// Path values (a mask's Mask Path, a shape's Path) as After Effects stores them. The property is an `om-s`
// holding its tdbs and an `omks` with one `shap` per keyframe, or the static value; the keyframe list itself
// holds only timing (value-less items). A shap is a bounding box (shph) and three points per vertex inside
// it (the vertex, its out handle and the next vertex's in handle), the last pointing back at the first vertex
// even when the path is open. Mask paths on layers with a source are stored in shares of the source's size;
// every other path in layer pixels.
import { PropertyValueType, type Layer, type Project, type Property, type Shape } from "../aep/model.ts";
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import { clone } from "./effects.ts";
import { setBit } from "./encode.ts";

const SHPH = { flags: 3, openBit: 3, topLeft: 4, bottomRight: 12 } as const;
/** Point count, then the counters After Effects checks it against: vertices, 1, and four per vertex. */
const LHD3 = { count: 10, vertices: 12, one: 24, capacity: 28 } as const;

/** Whether `prop` holds a path value stored the way this module writes it. */
export function isPathProperty(prop: Property): boolean {
  return prop.propertyValueType === PropertyValueType.SHAPE && !!prop.chunk && !prop.synthesized;
}

/** What one stored unit of a mask path on `layer` is in layer pixels, per axis. */
export function maskUnits(project: Project, layer: Layer): [number, number] {
  const source = layer.sourceId ? project.items.get(layer.sourceId) : undefined;
  return source && source.kind !== "folder" ? [source.width, source.height] : [1, 1];
}

/** What one stored unit of `prop`'s path is in layer pixels, per axis. */
export function pathUnits(project: Project, layer: Layer, prop: Property): [number, number] {
  return prop.matchName === "ADBE Mask Shape" ? maskUnits(project, layer) : [1, 1];
}

/** The path's shph box and point list, in `units`, written into `shph`, `lhd3` and `ldat` (chunks not yet in a project). */
export function encodePath(shape: Shape, units: readonly [number, number], shph: Chunk, lhd3: Chunk, ldat: Chunk): void {
  const n = shape.vertices.length;
  if (!n) throw new Error("a path needs at least one vertex");
  const absolute: number[][] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = shape.vertices[i];
    const next = shape.vertices[(i + 1) % n];
    const out = shape.outTangents[i] ?? [0, 0];
    const inn = shape.inTangents[(i + 1) % n] ?? [0, 0];
    absolute.push([x, y], [x + out[0], y + out[1]], [next[0] + inn[0], next[1] + inn[1]]);
  }
  const points = absolute.map(([x, y]) => [x / units[0], y / units[1]]);
  const lo = [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))];
  const hi = [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
  const span = [hi[0] - lo[0] || 1, hi[1] - lo[1] || 1];
  const box = new Uint8Array(Math.max(shph.data.length, 20));
  box.set(shph.data);
  const boxView = new DataView(box.buffer);
  setBit(box, SHPH.flags, SHPH.openBit, !shape.closed);
  boxView.setFloat32(SHPH.topLeft, lo[0]);
  boxView.setFloat32(SHPH.topLeft + 4, lo[1]);
  boxView.setFloat32(SHPH.bottomRight, hi[0]);
  boxView.setFloat32(SHPH.bottomRight + 4, hi[1]);
  shph.data = box;
  const header = new Uint8Array(Math.max(lhd3.data.length, 32));
  header.set(lhd3.data);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(LHD3.count, points.length);
  headerView.setUint32(LHD3.vertices, n);
  headerView.setUint32(LHD3.one, 1);
  headerView.setUint32(LHD3.capacity, 4 * n);
  lhd3.data = header;
  const data = new Uint8Array(points.length * 8);
  const view = new DataView(data.buffer);
  points.forEach(([x, y], i) => {
    view.setFloat32(i * 8, (x - lo[0]) / span[0]);
    view.setFloat32(i * 8 + 4, (y - lo[1]) / span[1]);
  });
  ldat.data = data;
}

/** A new `shap` holding `shape`, built on a copy of `like` (another shap of the same property). */
export function shapChunk(like: Chunk, shape: Shape, units: readonly [number, number]): Chunk {
  const shap = clone(like);
  const list = findList(shap, "list");
  const shph = findChild(shap, "shph");
  const lhd3 = findChild(list, "lhd3");
  let ldat = findChild(list, "ldat");
  if (!list || !shph || !lhd3) throw new Error("the path value is damaged");
  if (!ldat) {
    ldat = { type: "ldat", offset: -1, data: new Uint8Array(0) };
    list.children = [...(list.children ?? []), ldat];
  }
  encodePath(shape, units, shph, lhd3, ldat);
  return shap;
}

/** The om-s container's value list (`omks`) of a path property's tdbs, found from its layer. */
export function pathValues(layerChunk: Chunk, tdbs: Chunk): Chunk | undefined {
  const find = (c: Chunk): Chunk | undefined => {
    if (c.listType === "om-s" && c.children?.includes(tdbs)) return findList(c, "omks");
    for (const child of c.children ?? []) {
      const found = find(child);
      if (found) return found;
    }
    return undefined;
  };
  return find(layerChunk);
}

export const shapsOf = (omks: Chunk): Chunk[] => (omks.children ?? []).filter((c) => c.listType === "shap");
