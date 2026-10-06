// Layer transforms: local and world (parented) matrices, AE's comp camera
// projection, and camera rays. Ported from py-aep's resolvers/transform.py
// (MIT, https://github.com/forticheprod/py-aep).
import { valueAtTime } from "./evaluate.ts";
import type { CompItem, Layer, Property, PropertyGroup, PropertyNode } from "./model.ts";

const DEG2RAD = Math.PI / 180;
const EPSILON = 1e-10;
const CAMERA_OR_POINT_OF_INTEREST = 4214;

export type Vec3 = [number, number, number];

/** 4x4 matrix, row-major, acting on column vectors. */
export class Mat4 {
  readonly m: number[];
  constructor(m?: number[]) {
    this.m = m ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  static translation(x: number, y: number, z: number): Mat4 {
    return new Mat4([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);
  }
  static scale(x: number, y: number, z: number): Mat4 {
    return new Mat4([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
  }
  static rotateX(deg: number): Mat4 {
    const c = Math.cos(deg * DEG2RAD);
    const s = Math.sin(deg * DEG2RAD);
    return new Mat4([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]);
  }
  static rotateY(deg: number): Mat4 {
    const c = Math.cos(deg * DEG2RAD);
    const s = Math.sin(deg * DEG2RAD);
    return new Mat4([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]);
  }
  static rotateZ(deg: number): Mat4 {
    const c = Math.cos(deg * DEG2RAD);
    const s = Math.sin(deg * DEG2RAD);
    return new Mat4([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }

  /** `this @ other`. */
  mul(other: Mat4): Mat4 {
    const a = this.m;
    const b = other.m;
    const out = new Array<number>(16);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
      }
    }
    return new Mat4(out);
  }

  transformPoint([x, y, z]: number[]): Vec3 {
    const m = this.m;
    const w = m[12] * x + m[13] * y + m[14] * z + m[15] || 1;
    return [
      (m[0] * x + m[1] * y + m[2] * z + m[3]) / w,
      (m[4] * x + m[5] * y + m[6] * z + m[7]) / w,
      (m[8] * x + m[9] * y + m[10] * z + m[11]) / w,
    ];
  }

  transformVector([x, y, z]: number[]): Vec3 {
    const m = this.m;
    return [m[0] * x + m[1] * y + m[2] * z, m[4] * x + m[5] * y + m[6] * z, m[8] * x + m[9] * y + m[10] * z];
  }

  inverse(): Mat4 {
    const m = this.m;
    const inv = new Array<number>(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (Math.abs(det) < 1e-300) throw new Error("matrix is singular");
    return new Mat4(inv.map((v) => v / det));
  }
}

function group(nodes: PropertyNode[], matchName: string): PropertyGroup | undefined {
  const node = nodes.find((n) => n.matchName === matchName);
  return node?.kind === "group" ? node : undefined;
}

function prop(nodes: PropertyNode[], matchName: string): Property | undefined {
  const node = nodes.find((n) => n.matchName === matchName);
  return node?.kind === "property" ? node : undefined;
}

/** Evaluates a transform property; separated Position is composed from its followers. */
function transformValue(layer: Layer, matchName: string, time: number): number | number[] {
  const transform = group(layer.properties, "ADBE Transform Group");
  const p = transform && prop(transform.children, matchName);
  if (!p) throw new Error(`layer "${layer.name}" has no ${matchName}`);
  const value = valueAtTime(p, time, layer, transform.children);
  if (typeof value === "number" || Array.isArray(value)) return value;
  throw new Error(`${matchName} on "${layer.name}" is not numeric`);
}

const vec3 = (v: number | number[]): Vec3 => (Array.isArray(v) ? [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0] : [v, 0, 0]);
const scalar = (v: number | number[]): number => (Array.isArray(v) ? (v[0] ?? 0) : v);

export interface LocalTransform {
  position: Vec3;
  anchor: Vec3;
  scale: Vec3;
  orientation: Vec3;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  opacity: number;
}

export function localTransform(layer: Layer, time: number): LocalTransform {
  return {
    position: vec3(transformValue(layer, "ADBE Position", time)),
    anchor: vec3(transformValue(layer, "ADBE Anchor Point", time)),
    scale: vec3(transformValue(layer, "ADBE Scale", time)),
    orientation: vec3(transformValue(layer, "ADBE Orientation", time)),
    rotateX: scalar(transformValue(layer, "ADBE Rotate X", time)),
    rotateY: scalar(transformValue(layer, "ADBE Rotate Y", time)),
    rotateZ: scalar(transformValue(layer, "ADBE Rotate Z", time)),
    opacity: scalar(transformValue(layer, "ADBE Opacity", time)),
  };
}

/** T(position) . Rx.Ry.Rz(orientation) . Rx(x).Ry(y).Rz(z) . S(scale) . T(-anchor). */
export function localMatrix(t: LocalTransform): Mat4 {
  const [ox, oy, oz] = t.orientation;
  const is3D = t.rotateX !== 0 || t.rotateY !== 0 || ox !== 0 || oy !== 0 || oz !== 0;
  let m = Mat4.translation(-t.anchor[0], -t.anchor[1], -t.anchor[2]);
  m = Mat4.scale(t.scale[0] / 100, t.scale[1] / 100, t.scale[2] / 100).mul(m);
  m = Mat4.rotateZ(t.rotateZ).mul(m);
  m = Mat4.rotateY(t.rotateY).mul(m);
  m = Mat4.rotateX(t.rotateX).mul(m);
  if (is3D) {
    m = Mat4.rotateZ(oz).mul(m);
    m = Mat4.rotateY(oy).mul(m);
    m = Mat4.rotateX(ox).mul(m);
  }
  return Mat4.translation(t.position[0], t.position[1], t.position[2]).mul(m);
}

/** Layer space to world (comp 3D) space, composed through the parent chain. */
export function worldMatrix(layer: Layer, comp: CompItem, time: number): Mat4 {
  const chain: Layer[] = [];
  const seen = new Set<number>();
  for (let current: Layer | undefined = layer; current && !seen.has(current.id); ) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId ? comp.layers.find((l) => l.id === current!.parentId) : undefined;
  }
  let m = new Mat4();
  for (let i = chain.length - 1; i >= 0; i--) m = m.mul(localMatrix(localTransform(chain[i], time)));
  return m;
}

/** AE's default comp camera zoom: the 50mm preset, in square pixels. */
export function defaultCameraZoom(comp: CompItem): number {
  return (comp.width * comp.pixelAspect) / 0.72;
}

/** Projects a world point through AE's default comp camera (identity for z = 0). */
export function projectToComp(point: Vec3, comp: CompItem): [number, number] {
  const zoom = defaultCameraZoom(comp);
  const cx = comp.width / 2;
  const cy = comp.height / 2;
  const factor = zoom / (zoom + point[2]);
  return [cx + (point[0] - cx) * factor, cy + (point[1] - cy) * factor];
}

/** ExtendScript `sourcePointToComp`: camera-independent (always the default camera). */
export function sourcePointToComp(layer: Layer, comp: CompItem, point: [number, number], time: number): [number, number] {
  return projectToComp(worldMatrix(layer, comp, time).transformPoint([point[0], point[1], 0]), comp);
}

const sub = (a: number[], b: number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
const normalize = (v: number[]): Vec3 => {
  const n = norm(v);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
};

/** A two-node camera's rotation: +Z toward the point of interest, roll referenced to +Y. */
function lookAt(eye: Vec3, target: Vec3): Mat4 {
  const delta = sub(target, eye);
  const forward = norm(delta) < EPSILON ? ([0, 0, 1] as Vec3) : normalize(delta);
  const c = cross([0, 1, 0], forward);
  const xAxis = norm(c) < EPSILON ? ([1, 0, 0] as Vec3) : normalize(c);
  const yAxis = cross(forward, xAxis);
  return new Mat4([xAxis[0], yAxis[0], forward[0], 0, xAxis[1], yAxis[1], forward[1], 0, xAxis[2], yAxis[2], forward[2], 0, 0, 0, 0, 1]);
}

export interface Camera {
  position: Vec3;
  /** Camera-to-world rotation. */
  rotation: Mat4;
  /** Distance from the camera to its image plane, in pixels. */
  zoom: number;
}

/** The front-most enabled camera layer active at `time`, or undefined for the default camera. */
export function activeCameraLayer(comp: CompItem, time: number): Layer | undefined {
  return comp.layers.find((l) => l.layerType === "CameraLayer" && l.enabled && l.inPoint <= time && time < l.outPoint);
}

/** The camera at `time`; pass `null` for AE's default comp camera. */
export function cameraAt(comp: CompItem, time: number, cameraLayer: Layer | null | undefined = activeCameraLayer(comp, time)): Camera {
  if (!cameraLayer) {
    const zoom = defaultCameraZoom(comp);
    return { position: [comp.width / 2, comp.height / 2, -zoom], rotation: new Mat4(), zoom };
  }
  const t = localTransform(cameraLayer, time);
  let rotation = cameraLayer.autoOrient === CAMERA_OR_POINT_OF_INTEREST ? lookAt(t.position, t.anchor) : new Mat4();
  rotation = rotation
    .mul(Mat4.rotateX(t.orientation[0]))
    .mul(Mat4.rotateY(t.orientation[1]))
    .mul(Mat4.rotateZ(t.orientation[2]))
    .mul(Mat4.rotateX(t.rotateX))
    .mul(Mat4.rotateY(t.rotateY))
    .mul(Mat4.rotateZ(t.rotateZ));
  const options = group(cameraLayer.properties, "ADBE Camera Options Group");
  const zoomProp = options && prop(options.children, "ADBE Camera Zoom");
  const zoom = zoomProp ? scalar(valueAtTime(zoomProp, time, cameraLayer) as number | number[]) : defaultCameraZoom(comp);
  return { position: t.position, rotation, zoom };
}

/** ExtendScript `compPointToSource`: a ray from the active camera intersected with the layer plane. */
export function compPointToSource(layer: Layer, comp: CompItem, point: [number, number], time: number): [number, number] {
  const world = worldMatrix(layer, comp, time);
  const camera = layer.threeDLayer ? cameraAt(comp, time) : cameraAt(comp, time, null);
  const origin = camera.position;
  const direction = camera.rotation.transformVector([point[0] - comp.width / 2, point[1] - comp.height / 2, camera.zoom]);
  const inverse = world.inverse();
  const o = inverse.transformPoint(origin);
  const d = inverse.transformVector(direction);
  if (Math.abs(d[2]) < EPSILON) throw new Error("ray is parallel to the layer plane");
  const t = -o[2] / d[2];
  if (t <= 0) throw new Error("the layer plane is not in front of the camera");
  return [o[0] + t * d[0], o[1] + t * d[1]];
}

/**
 * World to comp-pixel projection through `camera`: `[x, y, depth]`, where
 * depth is the distance along the camera's view axis (positive in front).
 */
export function projectThroughCamera(point: Vec3, camera: Camera, comp: CompItem): Vec3 {
  const local = camera.rotation.inverse().transformVector(sub(point, camera.position));
  const factor = camera.zoom / local[2];
  return [comp.width / 2 + local[0] * factor, comp.height / 2 + local[1] * factor, local[2]];
}
