// Property evaluation at a point in time: keyframe interpolation with After
// Effects' temporal ease, spatial motion paths, roving keys, path morphing and
// Orientation slerp. Ported from py-aep's resolvers/interpolation.py (MIT,
// https://github.com/forticheprod/py-aep), which follows lottie-web's structure
// with numerics matched to AE's own valueAtTime output.
import {
  isGradientValue,
  isShapeValue,
  KeyframeInterpolationType,
  PropertyValueType,
  type Gradient,
  type Keyframe,
  type Layer,
  type Property,
  type PropertyNode,
  type PropertyValue,
  type Shape,
} from "./model.ts";

const { LINEAR, HOLD } = KeyframeInterpolationType;
const DEFAULT_INFLUENCE = 100 / 6;
/** AE's arc-length table: 128 samples taken uniformly in the curve parameter. */
const CURVE_SEGMENTS = 128;
const EPS = 1e-10;
/**
 * Below this cos(Y), AE treats an Orientation as gimbal-locked and puts the
 * combined X+Z turn on Z. AE's sampled output brackets it between 4.5e-6
 * (locked) and 3.6e-5 (not locked); both readings describe the same rotation.
 */
const EULER_EPS = 1e-5;
const RAD2DEG = 180 / Math.PI;

interface Ease {
  speed: number;
  /** Percent, 0-100. */
  influence: number;
}

type ValueKind = "shape" | "orientation" | "gradient" | null;

/** Blends two gradient ramps stop by stop; differing stop counts hold the left ramp. */
function interpolateGradients(a: Gradient, b: Gradient, t: number): Gradient {
  if (a.colorStops.length !== b.colorStops.length || a.alphaStops.length !== b.alphaStops.length) return a;
  const lerp = (x: number, y: number) => x + (y - x) * t;
  return {
    colorStops: a.colorStops.map((s, i) => {
      const o = b.colorStops[i];
      return { offset: lerp(s.offset, o.offset), midpoint: lerp(s.midpoint, o.midpoint), color: s.color.map((c, k) => lerp(c, o.color[k])) as [number, number, number] };
    }),
    alphaStops: a.alphaStops.map((s, i) => {
      const o = b.alphaStops[i];
      return { offset: lerp(s.offset, o.offset), midpoint: lerp(s.midpoint, o.midpoint), alpha: lerp(s.alpha, o.alpha) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Unit-square bezier easing, solved in closed form the way AE does.
// ---------------------------------------------------------------------------

const bezA = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1;
const bezB = (a1: number, a2: number) => 3 * a2 - 6 * a1;
const bezC = (a1: number) => 3 * a1;
const calcBezier = (t: number, a1: number, a2: number) => ((bezA(a1, a2) * t + bezB(a1, a2)) * t + bezC(a1)) * t;

/** The root of `a t^3 + b t^2 + c t + d` in [0, 1] that AE picks (Cardano), or null. */
function solveCubic(a: number, b: number, c: number, d: number): number | null {
  let root: number;
  if (Math.abs(a) >= EPS) {
    const bigA = b / a;
    const q = (bigA * bigA - 3 * (c / a)) / 9;
    const r = (2 * bigA * bigA * bigA - 9 * bigA * (c / a) + 27 * (d / a)) / 54;
    const third = bigA / 3;
    const q3 = q * q * q;
    if (q3 < r * r) {
      const sq = Math.sqrt(r * r - q3);
      if (r < 0) {
        const x = Math.pow(sq - r, 1 / 3);
        return q / x + x - third;
      }
      const x = Math.pow(sq + r, 1 / 3);
      return -x - q / x - third;
    }
    if (Math.abs(q) < EPS) return -third;
    const theta = Math.acos(r / Math.sqrt(q3));
    const scale = -2 * Math.sqrt(q);
    const first = Math.cos(theta / 3) * scale - third;
    if (first > 0 && first < 1) return first;
    const second = Math.cos((theta + 2 * Math.PI) / 3) * scale - third;
    if (second >= 0 && second <= 1) return second;
    root = Math.cos((theta + 4 * Math.PI) / 3) * scale - third;
  } else {
    if (Math.abs(b) < EPS) return Math.abs(c) >= EPS ? -d / c : 0;
    const disc = c * c - 4 * b * d;
    if (disc < 0) return null;
    if (Math.abs(disc) < EPS) return -c / (2 * b);
    const sq = Math.sqrt(disc);
    const qQuad = c <= 0 ? sq - c : -(sq + c);
    const first = (2 * d) / qQuad;
    root = qQuad / (2 * b);
    if (first >= 0 && first <= 1) return first;
  }
  return root >= 0 && root <= 1 ? root : null;
}

class BezierEasing {
  readonly cx1: number;
  readonly cy1: number;
  readonly cx2: number;
  readonly cy2: number;
  constructor(cx1: number, cy1: number, cx2: number, cy2: number) {
    this.cx1 = cx1;
    this.cy1 = cy1;
    this.cx2 = cx2;
    this.cy2 = cy2;
  }

  get(x: number): number {
    if (this.cx1 === this.cy1 && this.cx2 === this.cy2) return x;
    return calcBezier(this.parameterAt(x), this.cy1, this.cy2);
  }

  /** The curve parameter whose x-coordinate is `x`; ends snap within EPS. */
  parameterAt(x: number): number {
    if (x < 0 || Math.abs(x) < EPS) return 0;
    if (x > 1 || Math.abs(x - 1) < EPS) return 1;
    const u = solveCubic(bezA(this.cx1, this.cx2), bezB(this.cx1, this.cx2), bezC(this.cx1), -x);
    return u === null ? x : u;
  }
}

/** One temporal bezier dimension; the value handles are absolute so equal-valued keys still bow. */
function interpolateBezier1d(t: number, t0: number, t1: number, v0: number, v1: number, out: Ease, inn: Ease): number {
  const dt = t1 - t0;
  if (dt === 0) return v0;
  const dv = v1 - v0;
  const cx1 = out.influence / 100;
  const cx2 = 1 - inn.influence / 100;
  const cy1 = Math.abs(dv) > 1e-12 ? (out.speed * cx1 * dt) / dv : cx1;
  const cy2 = Math.abs(dv) > 1e-12 ? 1 - (inn.speed * (1 - cx2) * dt) / dv : cx2;
  const u = new BezierEasing(cx1, cy1, cx2, cy2).parameterAt((t - t0) / dt);
  const y1 = v0 + out.speed * (out.influence / 100) * dt;
  const y2 = v1 - inn.speed * (inn.influence / 100) * dt;
  const mu = 1 - u;
  return mu * mu * mu * v0 + 3 * mu * mu * u * y1 + 3 * mu * u * u * y2 + u * u * u * v1;
}

// ---------------------------------------------------------------------------
// Spatial paths
// ---------------------------------------------------------------------------

function cubicNd(p0: number[], p1: number[], p2: number[], p3: number[], t: number): number[] {
  const u = 1 - t;
  return p0.map((_, d) => u * u * u * p0[d] + 3 * u * u * t * p1[d] + 3 * u * t * t * p2[d] + t * t * t * p3[d]);
}

class BezierPath {
  readonly points: number[][] = [];
  readonly partialLengths: number[] = [];
  readonly length: number;

  constructor(v0: number[], v1: number[], outTangent: number[], inTangent: number[]) {
    const p1 = v0.map((v, d) => v + (outTangent[d] ?? 0));
    const p2 = v1.map((v, d) => v + (inTangent[d] ?? 0));
    let total = 0;
    let last: number[] | undefined;
    for (let k = 0; k < CURVE_SEGMENTS; k++) {
      const point = cubicNd(v0, p1, p2, v1, k / (CURVE_SEGMENTS - 1));
      const dist = last ? Math.hypot(...point.map((p, d) => p - last![d])) : 0;
      total += dist;
      this.points.push(point);
      this.partialLengths.push(dist);
      last = point;
    }
    this.length = total;
  }

  /** The point at an arc-length fraction, walking the sampled polyline. */
  pointAt(perc: number): number[] {
    if (perc <= 0) return [...this.points[0]];
    if (perc >= 1) return [...this.points[this.points.length - 1]];
    const distance = this.length * perc;
    let added = 0;
    const n = this.points.length;
    for (let j = 0; j < n; j++) {
      added += this.partialLengths[j];
      if (distance === 0 || j === n - 1) return [...this.points[j]];
      if (distance >= added && distance < added + this.partialLengths[j + 1]) {
        const seg = (distance - added) / this.partialLengths[j + 1];
        const a = this.points[j];
        const b = this.points[j + 1];
        return a.map((v, d) => v + (b[d] - v) * seg);
      }
    }
    return [...this.points[n - 1]];
  }
}

const isZero = (t: number[] | undefined) => !t || t.every((x) => Math.abs(x) < 1e-12);

/** Ease mapping a time fraction to an arc-length fraction, or null for constant progress. */
function spatialProgressEasing(
  dt: number,
  arcLength: number,
  out: Ease | undefined,
  inn: Ease | undefined,
  outLinear: boolean,
  inLinear: boolean,
): BezierEasing | null {
  if (!out || !inn) return null;
  if (out.influence <= 0 && inn.influence <= 0) return null;
  const outFrac = out.influence / 100;
  const inFrac = inn.influence / 100;
  const dsdt = arcLength > 1e-12 ? 1 / arcLength : 0;
  let cx1 = outFrac;
  let cy1 = out.speed * dsdt * outFrac * dt;
  let cx2 = 1 - inFrac;
  let cy2 = 1 - inn.speed * dsdt * inFrac * dt;
  if (outLinear) cy1 = cx1;
  if (inLinear) cy2 = cx2;
  // A handle past the unit square is shortened along its own slope, keeping the speed.
  if (cy1 > 1) {
    cx1 = cx1 / cy1;
    cy1 = 1;
  } else if (cy1 < 0) cy1 = 0;
  if (cy2 < 0) {
    cx2 = 1 - (1 - cx2) / (1 - cy2);
    cy2 = 0;
  } else if (cy2 > 1) cy2 = 1;
  return new BezierEasing(cx1, cy1, cx2, cy2);
}

// ---------------------------------------------------------------------------
// Orientation (quaternion slerp in AE's Rx.Ry.Rz order)
// ---------------------------------------------------------------------------

type Quat = [number, number, number, number];

function axisQuat(axis: number, degrees: number): Quat {
  const half = (degrees * Math.PI) / 360;
  const q: Quat = [0, 0, 0, Math.cos(half)];
  q[axis] = Math.sin(half);
  return q;
}

function quatMul([ax, ay, az, aw]: Quat, [bx, by, bz, bw]: Quat): Quat {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function eulerToQuat(angles: number[]): Quat {
  let q: Quat = [0, 0, 0, 1];
  for (let axis = 0; axis < 3; axis++) q = quatMul(q, axisQuat(axis, angles[axis] ?? 0));
  return q;
}

function quatToEuler(q: Quat): number[] {
  const norm = Math.hypot(...q);
  const [x, y, z, w] = norm > 0 ? (q.map((v) => v / norm) as Quat) : q;
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - z * w);
  const r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - x * w);
  const r22 = 1 - 2 * (x * x + y * y);
  const beta = Math.asin(Math.max(-1, Math.min(1, r02)));
  const cosBeta = Math.hypot(r00, r01);
  let angles: number[];
  if (Math.abs(cosBeta) > EULER_EPS) {
    angles = [Math.atan2(-r12, r22) * RAD2DEG, beta * RAD2DEG, Math.atan2(-r01, r00) * RAD2DEG];
  } else {
    angles = [0, beta * RAD2DEG, Math.atan2(r10, r11) * RAD2DEG];
  }
  return angles.map((a) => ((a % 360) + 360) % 360);
}

function slerpOrientation(start: number[], end: number[], progress: number): number[] {
  const q0 = eulerToQuat(start);
  let q1 = eulerToQuat(end);
  let dot = q0.reduce((s, v, i) => s + v * q1[i], 0);
  if (dot < 0) {
    q1 = q1.map((v) => -v) as Quat;
    dot = -dot;
  }
  dot = Math.min(1, Math.max(-1, dot));
  if (dot > 0.9995) return quatToEuler(q0.map((a, i) => a + (q1[i] - a) * progress) as Quat);
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const s0 = Math.sin((1 - progress) * theta) / sinTheta;
  const s1 = Math.sin(progress * theta) / sinTheta;
  return quatToEuler(q0.map((a, i) => a * s0 + q1[i] * s1) as Quat);
}

// ---------------------------------------------------------------------------
// Path morphing
// ---------------------------------------------------------------------------

type Pt = [number, number];
type Cubic = [Pt, Pt, Pt, Pt];
const lerpPt = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function splitCubic([p0, p1, p2, p3]: Cubic, t: number): [Cubic, Cubic] {
  const a = lerpPt(p0, p1, t);
  const b = lerpPt(p1, p2, t);
  const c = lerpPt(p2, p3, t);
  const d = lerpPt(a, b, t);
  const e = lerpPt(b, c, t);
  const f = lerpPt(d, e, t);
  return [
    [p0, a, d, f],
    [f, e, c, p3],
  ];
}

/** AE bisects breadth-first in path order until the segment counts match. */
function subdivisionCuts(segmentCount: number, targetCount: number): number[][] {
  const pieces: [number, number, number][] = [];
  for (let i = 0; i < segmentCount; i++) pieces.push([i, 0, 1]);
  let head = 0;
  while (pieces.length - head < targetCount) {
    const [index, start, end] = pieces[head++];
    const middle = (start + end) / 2;
    pieces.push([index, start, middle], [index, middle, end]);
  }
  const cuts: number[][] = Array.from({ length: segmentCount }, () => []);
  for (const [index, start] of pieces.slice(head)) if (start > 0) cuts[index].push(start);
  cuts.forEach((c) => c.sort((a, b) => a - b));
  return cuts;
}

function resamplePath(shape: Shape, target: number): Shape {
  const { vertices, inTangents, outTangents, closed } = shape;
  const count = vertices.length;
  const segmentCount = closed ? count : count - 1;
  if (segmentCount < 1) return shape;
  const cuts = subdivisionCuts(segmentCount, segmentCount + target - count);
  const chain: Cubic[] = [];
  for (let index = 0; index < segmentCount; index++) {
    const tail = (index + 1) % count;
    const start: Pt = [vertices[index][0], vertices[index][1]];
    const end: Pt = [vertices[tail][0], vertices[tail][1]];
    const outT = outTangents[index];
    const inT = inTangents[tail];
    if (!outT.some(Boolean) && !inT.some(Boolean)) {
      // A straight segment stays straight: new vertices land on the line with zero handles.
      const bounds = [0, ...cuts[index], 1];
      for (let i = 0; i + 1 < bounds.length; i++) {
        const a = lerpPt(start, end, bounds[i]);
        const b = lerpPt(start, end, bounds[i + 1]);
        chain.push([a, a, b, b]);
      }
      continue;
    }
    let cubic: Cubic = [start, [start[0] + outT[0], start[1] + outT[1]], [end[0] + inT[0], end[1] + inT[1]], end];
    let consumed = 0;
    for (const cut of cuts[index]) {
      const [left, right] = splitCubic(cubic, (cut - consumed) / (1 - consumed));
      chain.push(left);
      cubic = right;
      consumed = cut;
    }
    chain.push(cubic);
  }
  const newVertices = chain.map((c) => [c[0][0], c[0][1]]);
  const newOut = chain.map((c) => [c[1][0] - c[0][0], c[1][1] - c[0][1]]);
  const arriving = chain.map((c) => [c[2][0] - c[3][0], c[2][1] - c[3][1]]);
  let newIn: number[][];
  if (closed) newIn = [...arriving.slice(-1), ...arriving.slice(0, -1)];
  else {
    const last = chain[chain.length - 1];
    newVertices.push([last[3][0], last[3][1]]);
    newOut.push([...outTangents[outTangents.length - 1]]);
    newIn = [[...inTangents[0]], ...arriving];
  }
  return { closed, vertices: newVertices, inTangents: newIn, outTangents: newOut };
}

function interpolateShapes(start: Shape, end: Shape, progress: number): Shape | null {
  if (!start.vertices.length || !end.vertices.length) return null;
  const target = Math.max(start.vertices.length, end.vertices.length);
  const a = start.vertices.length < target ? resamplePath(start, target) : start;
  const b = end.vertices.length < target ? resamplePath(end, target) : end;
  if (a.vertices.length !== b.vertices.length) return null;
  const lerp = (p: number[][], q: number[][]) => p.map((v, i) => [v[0] + (q[i][0] - v[0]) * progress, v[1] + (q[i][1] - v[1]) * progress]);
  return {
    closed: start.closed,
    vertices: lerp(a.vertices, b.vertices),
    inTangents: lerp(a.inTangents, b.inTangents),
    outTangents: lerp(a.outTangents, b.outTangents),
  };
}

// ---------------------------------------------------------------------------
// Ease resolution: what AE reports (and interpolates with) for each side.
// ---------------------------------------------------------------------------

const asVector = (v: PropertyValue): number[] | null =>
  typeof v === "number" ? [v] : Array.isArray(v) ? v : null;

function autoTemporalSpeeds(keys: Keyframe[], index: number): [number[], number[]] | null {
  const values = keys.map((k) => asVector(k.value));
  if (values.some((v) => v === null)) return null;
  const vs = values as number[][];
  const ndim = vs[index].length;
  const zero = () => new Array(ndim).fill(0);
  if (keys.length < 2) return [zero(), zero()];
  const slope = (lo: number, hi: number) => {
    const span = keys[hi].layerTime - keys[lo].layerTime;
    return span <= 0 ? zero() : vs[index].map((_, d) => (vs[hi][d] - vs[lo][d]) / span);
  };
  if (index === 0) return [zero(), slope(0, 1)];
  if (index === keys.length - 1) return [slope(index - 1, index), zero()];
  const through = slope(index - 1, index + 1);
  return [through, [...through]];
}

function segmentSpeed(a: Keyframe, b: Keyframe, motionPath: boolean): number[] {
  const span = b.layerTime - a.layerTime;
  if (span === 0) return [0];
  const va = asVector(a.value);
  const vb = asVector(b.value);
  if (!va || !vb) return [0];
  if (typeof a.value === "number") return [(vb[0] - va[0]) / span];
  if (motionPath) return [Math.hypot(...va.map((v, d) => vb[d] - v)) / span];
  return va.map((v, d) => (vb[d] - v) / span);
}

function resolveEase(keys: Keyframe[], index: number, direction: "in" | "out", motionPath: boolean, kind: ValueKind): Ease[] {
  const kf = keys[index];
  const raw = direction === "in" ? kf.inTemporalEase : kf.outTemporalEase;
  if (!raw.length) return [{ speed: 0, influence: 0 }];
  if (kf.temporalAutoBezier) {
    const auto = autoTemporalSpeeds(keys, index);
    const chosen = auto && (direction === "in" ? auto[0] : auto[1]);
    if (chosen && chosen.length === raw.length) return chosen.map((speed) => ({ speed, influence: DEFAULT_INFLUENCE }));
  }
  const interp = direction === "in" ? kf.inInterpolationType : kf.outInterpolationType;
  const other = direction === "out" ? keys[index + 1] : keys[index - 1];
  if (interp === LINEAR) {
    const flat = () => raw.map(() => ({ speed: 0, influence: DEFAULT_INFLUENCE }));
    if (!other) return flat();
    const adjacent = direction === "out" ? other.inInterpolationType : other.outInterpolationType;
    if (adjacent === HOLD) return flat();
    if (kind) return raw.map(() => ({ speed: 1, influence: DEFAULT_INFLUENCE }));
    const speeds = direction === "out" ? segmentSpeed(kf, other, motionPath) : segmentSpeed(other, kf, motionPath);
    return speeds.map((speed) => ({ speed, influence: DEFAULT_INFLUENCE }));
  }
  if (interp === HOLD) return raw.map(() => ({ speed: 0, influence: DEFAULT_INFLUENCE }));
  if (!other) return raw.map((e) => ({ speed: 0, influence: e.influence }));
  return raw;
}

// ---------------------------------------------------------------------------
// Prepared property and the public entry points
// ---------------------------------------------------------------------------

interface Prepared {
  keys: Keyframe[];
  inEase: Ease[][];
  outEase: Ease[][];
  motionPath: boolean;
  kind: ValueKind;
  inert: ReadonlySet<number>;
}

const prepared = new WeakMap<Property, Prepared>();

function prepare(prop: Property, layer: Layer): Prepared {
  const cached = prepared.get(prop);
  if (cached) return cached;
  const keys = prop.keyframes;
  const kind: ValueKind =
    prop.propertyValueType === PropertyValueType.SHAPE
      ? "shape"
      : prop.matchName === "ADBE Orientation"
        ? "orientation"
        : isGradientValue(keys[0]?.value)
          ? "gradient"
          : null;
  const color = prop.propertyValueType === PropertyValueType.COLOR;
  const motionPath = !color && (prop.isSpatial || prop.propertyValueType === PropertyValueType.ThreeD_SPATIAL || prop.propertyValueType === PropertyValueType.TwoD_SPATIAL) && kind === null;
  const result: Prepared = {
    keys,
    inEase: keys.map((_, i) => resolveEase(keys, i, "in", motionPath, kind)),
    outEase: keys.map((_, i) => resolveEase(keys, i, "out", motionPath, kind)),
    motionPath,
    kind,
    inert: prop.matchName === "ADBE Scale" && !layer.threeDLayer ? new Set([2]) : new Set(),
  };
  prepared.set(prop, result);
  return result;
}

function interpolateSpatial(p: Prepared, t: number, i0: number, i1: number): number[] {
  const k0 = p.keys[i0];
  const k1 = p.keys[i1];
  const v0 = k0.value as number[];
  const v1 = k1.value as number[];
  const dt = k1.layerTime - k0.layerTime;
  if (dt === 0) return [...v0];
  const outTan = k0.outSpatialTangent ?? v0.map(() => 0);
  const inTan = k1.inSpatialTangent ?? v1.map(() => 0);
  const straight = isZero(outTan) && isZero(inTan);
  const out = p.outEase[i0][0];
  const inn = p.inEase[i1][0];
  const explicit = !!out && !!inn && (out.influence > 0 || inn.influence > 0);
  const path = straight ? null : new BezierPath(v0, v1, outTan, inTan);
  const arc = path ? path.length : Math.hypot(...v0.map((v, d) => v1[d] - v));
  const easing = explicit
    ? spatialProgressEasing(dt, arc, out, inn, k0.outInterpolationType === LINEAR, k1.inInterpolationType === LINEAR)
    : null;
  const x = (t - k0.layerTime) / dt;
  const perc = easing ? easing.get(x) : x;
  return path ? path.pointAt(perc) : v0.map((v, d) => v + (v1[d] - v) * perc);
}

/** A roving run is eased once across its enclosing anchors and read along the joined path. */
function interpolateRoving(p: Prepared, t: number, start: number, end: number): number[] | null {
  const values = p.keys.slice(start, end + 1).map((k) => k.value);
  if (!values.every(Array.isArray)) return null;
  const paths: BezierPath[] = [];
  for (let i = start; i < end; i++) {
    const a = p.keys[i].value as number[];
    const b = p.keys[i + 1].value as number[];
    paths.push(new BezierPath(a, b, p.keys[i].outSpatialTangent ?? a.map(() => 0), p.keys[i + 1].inSpatialTangent ?? b.map(() => 0)));
  }
  const total = paths.reduce((s, path) => s + path.length, 0);
  if (total <= 0) return null;
  const spanStart = p.keys[start].layerTime;
  const span = p.keys[end].layerTime - spanStart;
  if (span <= 0) return [...(p.keys[start].value as number[])];
  const easing = spatialProgressEasing(
    span,
    total,
    p.outEase[start][0],
    p.inEase[end][0],
    p.keys[start].outInterpolationType === LINEAR,
    p.keys[end].inInterpolationType === LINEAR,
  );
  const x = (t - spanStart) / span;
  const target = (easing ? easing.get(x) : x) * total;
  let travelled = 0;
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (travelled + path.length >= target || i === paths.length - 1) {
      return path.pointAt(Math.min(Math.max((target - travelled) / path.length, 0), 1));
    }
    travelled += path.length;
  }
  return null;
}

function interpolate(p: Prepared, t: number): PropertyValue {
  const { keys } = p;
  const n = keys.length;
  if (n === 1 || t <= keys[0].layerTime) return keys[0].value;
  if (t >= keys[n - 1].layerTime) return keys[n - 1].value;
  let i1 = 1;
  while (i1 < n - 1 && keys[i1].layerTime < t) i1++;
  const i0 = i1 - 1;
  const k0 = keys[i0];
  const k1 = keys[i1];
  const t0 = k0.layerTime;
  const t1 = k1.layerTime;
  if (Math.abs(t - t0) < 1e-12) return k0.value;
  if (Math.abs(t - t1) < 1e-12) return k1.value;

  if (p.motionPath && (k0.roving || k1.roving)) {
    let start = i0;
    while (start > 0 && keys[start].roving) start--;
    let end = i1;
    while (end < n - 1 && keys[end].roving) end++;
    const roving = interpolateRoving(p, t, start, end);
    if (roving) return roving;
  }

  const outType = k0.outInterpolationType;
  const inType = k1.inInterpolationType;
  if (outType === HOLD) return k0.value;
  if (inType === HOLD) return k1.value;
  const v0 = k0.value;
  const v1 = k1.value;

  if (p.kind) {
    // Paths and Orientation blend as one eased quantity; a stored ease speed is dimensionless here.
    const easing = spatialProgressEasing(1, 1, p.outEase[i0][0], p.inEase[i1][0], outType === LINEAR, inType === LINEAR);
    const x = (t - t0) / (t1 - t0);
    const progress = easing ? easing.get(x) : x;
    if (p.kind === "shape" && isShapeValue(v0) && isShapeValue(v1)) {
      return interpolateShapes(v0, v1, progress) ?? v0;
    }
    if (p.kind === "orientation" && Array.isArray(v0) && Array.isArray(v1)) return slerpOrientation(v0, v1, progress);
    if (p.kind === "gradient" && isGradientValue(v0) && isGradientValue(v1)) return interpolateGradients(v0, v1, progress);
  }

  if (p.motionPath && Array.isArray(v0) && Array.isArray(v1)) return interpolateSpatial(p, t, i0, i1);

  if (Array.isArray(v0) && Array.isArray(v1)) {
    const outE = p.outEase[i0];
    const inE = p.inEase[i1];
    // A single ease on a multi-dimensional value (a color) drives every channel with one
    // progress that follows the influences alone.
    if (Math.min(outE.length, inE.length) === 1) {
      const progress = new BezierEasing(outE[0].influence / 100, 0, 1 - inE[0].influence / 100, 1).get((t - t0) / (t1 - t0));
      return v0.map((v, d) => v + (v1[d] - v) * progress);
    }
    return v0.map((v, d) =>
      p.inert.has(d) ? v : interpolateBezier1d(t, t0, t1, v, v1[d], outE[d] ?? outE[0], inE[d] ?? inE[0]),
    );
  }

  if (typeof v0 === "number" && typeof v1 === "number") {
    const out = p.outEase[i0][0];
    const inn = p.inEase[i1][0];
    if (out && inn) return interpolateBezier1d(t, t0, t1, v0, v1, out, inn);
    return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }
  return v0;
}

/** Composition seconds to the layer's own seconds, the axis keyframe eases are defined on. */
export function layerTimeAt(layer: Layer, compTime: number): number {
  const stretch = layer.stretch ? layer.stretch / 100 : 1;
  const offset = stretch >= 0 ? layer.startTime : layer.startTime - Math.abs(stretch) / 3000;
  return (compTime - offset) / stretch;
}

function findChild(nodes: PropertyNode[], matchName: string): Property | undefined {
  const node = nodes.find((n) => n.matchName === matchName);
  return node?.kind === "property" ? node : undefined;
}

/**
 * The value of `prop` (a property of `layer`) at composition time `compTime`,
 * before expressions. `siblings` are the properties of the group holding
 * `prop`, needed for a Position whose dimensions are separated.
 */
export function valueAtTime(prop: Property, compTime: number, layer: Layer, siblings?: PropertyNode[]): PropertyValue {
  if (prop.matchName === "ADBE Position" && prop.dimensionsSeparated && siblings) {
    const followers = ["ADBE Position_0", "ADBE Position_1", "ADBE Position_2"].map((m) => findChild(siblings, m));
    if (followers.every(Boolean)) {
      const parts = followers.map((f) => valueAtTime(f!, compTime, layer));
      if (parts.every((v) => typeof v === "number")) return parts as number[];
    }
  }
  if (!prop.keyframes.length) return prop.value;
  return interpolate(prepare(prop, layer), layerTimeAt(layer, compTime));
}

/** Computes the post-expression value of a property; installed by the expression engine. */
export type ExpressionEvaluator = (prop: Property, compTime: number, layer: Layer, preExpression: PropertyValue) => PropertyValue;
let expressionEvaluator: ExpressionEvaluator | undefined;

export function setExpressionEvaluator(evaluator: ExpressionEvaluator | undefined): void {
  expressionEvaluator = evaluator;
}

/** The value of `prop` at `compTime` after its expression, when it has one and an engine is installed. */
export function currentValue(prop: Property, compTime: number, layer: Layer, siblings?: PropertyNode[]): PropertyValue {
  const value = valueAtTime(prop, compTime, layer, siblings);
  return expressionEvaluator && prop.expressionEnabled ? expressionEvaluator(prop, compTime, layer, value) : value;
}
