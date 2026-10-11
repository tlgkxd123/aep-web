// Encoders for the chunk fields the editor writes. Field offsets mirror
// decode.ts; the state-transition templates (static <-> animated tdb4,
// keyframe items, lhd3 counters) follow py-aep's writer (MIT,
// https://github.com/forticheprod/py-aep) and the AE-written corpus.
import { LdatKind, decodeTdb4, type Tdb4 } from "../aep/decode.ts";
import type { Chunk } from "../aep/riff.ts";
import { type Transaction, doubles, leaf, list, readDoubles } from "./chunks.ts";

const INT32_MAX = 0x7fffffff;

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** The exact value of a double as numerator / denominator. */
function exactFraction(x: number): [bigint, bigint] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const exponent = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(view.getUint32(4));
  let shift = -1074;
  if (exponent) {
    mantissa |= 1n << 52n;
    shift = exponent - 1075;
  }
  let num = mantissa;
  let den = 1n;
  if (shift >= 0) num <<= BigInt(shift);
  else den <<= BigInt(-shift);
  const g = gcd(num, den) || 1n;
  return [num / g, den / g];
}

/** Python's `Fraction.limit_denominator` for a non-negative fraction. */
function limitDenominator(n0: bigint, d0: bigint, maxDen: bigint): [bigint, bigint] {
  if (d0 <= maxDen) return [n0, d0];
  let [p0, q0, p1, q1] = [0n, 1n, 1n, 0n];
  let [n, d] = [n0, d0];
  for (;;) {
    const a = n / d;
    const q2 = q0 + a * q1;
    if (q2 > maxDen) break;
    [p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2];
    [n, d] = [d, n - a * d];
  }
  const k = (maxDen - q0) / q1;
  return 2n * d * (q0 + k * q1) <= d0 ? [p1, q1] : [p0 + k * p1, q0 + k * q1];
}

/** `value` as the (dividend, divisor) pair AE stores for times and ratios. */
export function ratio(value: number): [number, number] {
  if (!Number.isFinite(value) || Math.abs(value) > INT32_MAX) throw new RangeError(`ratio value ${value} is out of range`);
  if (value === 0) return [0, 1];
  const maxDen = Math.max(1, Math.floor(INT32_MAX / (Math.trunc(Math.abs(value)) + 2)));
  const [n, d] = exactFraction(Math.abs(value));
  const [p, q] = limitDenominator(n, d, BigInt(Math.min(1_000_000, maxDen)));
  return [Math.sign(value) * Number(p), Number(q)];
}

export function setRatio(view: DataView, at: number, value: number, signed = true): void {
  const [n, d] = ratio(value);
  if (signed) view.setInt32(at, n);
  else view.setUint32(at, n);
  view.setUint32(at + 4, d);
}

export function setBit(bytes: Uint8Array, at: number, bit: number, on: boolean): void {
  bytes[at] = on ? bytes[at] | (1 << bit) : bytes[at] & ~(1 << bit);
}

const getBit = (bytes: Uint8Array, at: number, bit: number) => ((bytes[at] >> bit) & 1) === 1;

/** NUL-padded UTF-8 in a fixed field, cut at a character boundary. */
export function fixedUtf8(text: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let used = 0;
  const encoder = new TextEncoder();
  for (const ch of text) {
    const bytes = encoder.encode(ch);
    if (used + bytes.length > size - 1) break;
    out.set(bytes, used);
    used += bytes.length;
  }
  return out;
}

// ---------------------------------------------------------------- ldta

/** ldta switch bits by model field: [byte, bit]. */
export const LAYER_SWITCHES = {
  enabled: [39, 0],
  audioEnabled: [39, 1],
  effectsActive: [39, 2],
  motionBlur: [39, 3],
  locked: [39, 5],
  shy: [39, 6],
  collapseTransformation: [39, 7],
  adjustmentLayer: [38, 1],
  threeDLayer: [38, 2],
  solo: [38, 3],
  guideLayer: [37, 1],
  environmentLayer: [37, 5],
  preserveTransparency: [103, 0],
} as const;
export type LayerSwitch = keyof typeof LAYER_SWITCHES;

export const LDTA = {
  quality: 4,
  startTime: 12,
  inPoint: 20,
  outPoint: 28,
  flags0: 37,
  frameBlendingModeByte: 37,
  frameBlendingModeBit: 2,
  frameBlendingByte: 39,
  frameBlendingBit: 4,
  label: 61,
  name: 64,
  blendingMode: 99,
  transferFlags: 103,
  trackMatteType: 107,
  parentId: 132,
  matteLayerId: 160,
} as const;

// ---------------------------------------------------------------- cdta

export const CDTA = {
  resolutionFactor: 0,
  timeScale: 5,
  internalTimebase: 8,
  workAreaStart: 28,
  workAreaEnd: 36,
  duration: 44,
  bgColor: 52,
  width: 140,
  height: 142,
  pixelAspect: 144,
  frameRate: 156,
  displayStartTime: 164,
} as const;

const NTSC_MULTIPLIERS = new Set([24, 30, 48, 60, 120]);

function isNtsc(fps: number): boolean {
  const n = Math.round((fps * 1001) / 1000);
  return NTSC_MULTIPLIERS.has(n) && Math.abs(fps - (n * 1000) / 1001) < 0.01;
}

/** The internal timebase and time scale AE derives for a frame rate. */
export function timebaseFor(fps: number): { internalTimebase: number; timeScale: number } {
  if (isNtsc(fps)) return { internalTimebase: 23976, timeScale: 23976 / (fps * 256) };
  const timeScale = 2 ** Math.floor(Math.log2(144 / fps));
  return { internalTimebase: Math.round(fps * timeScale * 256), timeScale };
}

export function writeFrameRate(view: DataView, fps: number): void {
  const whole = Math.trunc(fps);
  view.setUint16(CDTA.frameRate, whole);
  view.setUint16(CDTA.frameRate + 2, Math.round((fps - whole) * 65536));
  const { internalTimebase, timeScale } = timebaseFor(fps);
  view.setUint32(CDTA.internalTimebase, internalTimebase);
  const scaleWhole = Math.trunc(timeScale);
  view.setUint16(CDTA.timeScale, scaleWhole);
  view.setUint8(CDTA.timeScale + 2, Math.round((timeScale - scaleWhole) * 256));
}

// ---------------------------------------------------------------- tdb4

export const TDB4 = {
  spatialStatic: 5,
  pad2a: 6,
  valueHintType: 8,
  valueHintFlag: 10,
  canVaryFlags: 11,
  timeBase: 12,
  pixelAspect: 24,
  typeFlags: 59,
  category: 60,
  animated: 68,
  pad7b: 73,
  pad7c: 77,
  spatialMarker: 79,
  expressionFlags: 119,
  hasExpression: 120,
} as const;

/** Spatial-static flag byte AE writes for a static effect parameter with an instance value. */
const EFFECT_PARAM_SPATIAL_FLAGS: Partial<Record<number, number>> = { 5: 0x07, 6: 0x0f, 18: 0x0f };

export interface PropertyClass {
  color: boolean;
  /** Interpolates along a motion path (spatial and not a color). */
  spatial: boolean;
  noValue: boolean;
  dimensions: number;
  /** The keyframe value lives in a parallel container (orientation). */
  parallel: boolean;
  /** Effect parameter control type, when the property is an effect parameter. */
  controlType?: number;
}

export function propertyClass(tdb4: Tdb4, options: { parallel?: boolean; controlType?: number } = {}): PropertyClass {
  const color = tdb4.color || options.controlType === 5;
  return {
    color,
    spatial: tdb4.isSpatial && !color,
    noValue: tdb4.noValue,
    dimensions: tdb4.dimensions,
    parallel: !!options.parallel,
    controlType: options.controlType,
  };
}

function set16(bytes: Uint8Array, at: number, v: number) {
  new DataView(bytes.buffer, bytes.byteOffset).setUint16(at, v);
}

/** Rewrites a tdb4 body to AE's animated-property state. */
export function animateTdb4(bytes: Uint8Array, cls: PropertyClass, timeBase: number, pixelAspect: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (cls.parallel) {
    setBit(bytes, TDB4.spatialStatic, 0, false);
    bytes[TDB4.animated] = 1;
    bytes[TDB4.spatialMarker] = 0;
    view.setUint32(TDB4.pad7b, 0);
    view.setUint16(TDB4.pad7c, 0);
    return;
  }
  bytes[TDB4.animated] = 1;
  bytes[TDB4.canVaryFlags] = 0xff;
  bytes[TDB4.valueHintFlag] = 0xff;
  if (cls.color) {
    bytes[TDB4.category] = 0x01;
    set16(bytes, TDB4.valueHintType, 2);
    bytes[TDB4.spatialStatic] = 6;
    set16(bytes, TDB4.pad2a, 1);
  } else if (cls.spatial) {
    bytes[TDB4.category] = 0x09;
    bytes[TDB4.typeFlags] |= 0x08;
    set16(bytes, TDB4.valueHintType, 0xffff);
    bytes[TDB4.spatialStatic] = 14;
    set16(bytes, TDB4.pad2a, 3);
  } else {
    bytes[TDB4.category] = 0x09;
    bytes[TDB4.typeFlags] |= 0x08;
    set16(bytes, TDB4.valueHintType, 1);
    bytes[TDB4.spatialStatic] = 0;
    set16(bytes, TDB4.pad2a, 0);
  }
  stampTimeBase(bytes, timeBase, pixelAspect);
}

/** Rewrites a tdb4 body to AE's static-property state. */
export function staticTdb4(bytes: Uint8Array, cls: PropertyClass): void {
  if (cls.parallel) {
    setBit(bytes, TDB4.spatialStatic, 0, true);
    bytes[TDB4.animated] = 0;
    bytes[TDB4.spatialMarker] = bytes[TDB4.spatialStatic] & 0x02 ? 1 : 0;
    return;
  }
  bytes[TDB4.animated] = 0;
  bytes[TDB4.canVaryFlags] = 0x02;
  bytes[TDB4.valueHintFlag] = 0;
  set16(bytes, TDB4.valueHintType, 0);
  bytes[TDB4.category] = 0;
  if (cls.color) {
    bytes[TDB4.spatialStatic] = 6;
    set16(bytes, TDB4.pad2a, 1);
  } else if (cls.spatial) {
    bytes[TDB4.spatialStatic] = 9;
    set16(bytes, TDB4.pad2a, 0);
  } else {
    bytes[TDB4.spatialStatic] = 1;
    set16(bytes, TDB4.pad2a, 0);
  }
  const effectFlags = cls.controlType === undefined ? undefined : EFFECT_PARAM_SPATIAL_FLAGS[cls.controlType];
  if (effectFlags !== undefined) bytes[TDB4.spatialStatic] = effectFlags;
}

/** The layer's keyframe timebase, and the comp pixel aspect on spatial points. */
export function stampTimeBase(bytes: Uint8Array, timeBase: number, pixelAspect: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(TDB4.timeBase, timeBase);
  const tdb4 = decodeTdb4(leaf("tdb4", bytes));
  if (bytes[TDB4.spatialMarker] && !tdb4.color && !tdb4.noValue) view.setFloat64(TDB4.pixelAspect, pixelAspect);
}

export function setExpressionFlags(bytes: Uint8Array, present: boolean, enabled: boolean): void {
  setBit(bytes, TDB4.hasExpression, 0, present);
  setBit(bytes, TDB4.expressionFlags, 0, present && !enabled);
}

// ---------------------------------------------------------------- keyframes

/** Serialized size of a keyframe item, by layout. */
export const ITEM_SIZES: Partial<Record<LdatKind, number>> = {
  color: 152,
  threeDSpatial: 128,
  threeD: 128,
  twoDSpatial: 104,
  twoD: 88,
  orientation: 80,
  noValue: 64,
  oneD: 48,
};

const DIMENSIONS: Partial<Record<LdatKind, number>> = { threeD: 3, threeDSpatial: 3, twoD: 2, twoDSpatial: 2, oneD: 1 };

/** Keyframe layout for a property that has no keyframe list yet. */
export function keyframeKindFor(cls: PropertyClass): LdatKind {
  if (cls.parallel) return LdatKind.orientation;
  if (cls.color) return LdatKind.color;
  if (cls.noValue) return LdatKind.noValue;
  if (cls.dimensions >= 3) return cls.spatial ? LdatKind.threeDSpatial : LdatKind.threeD;
  if (cls.dimensions === 2) return cls.spatial ? LdatKind.twoDSpatial : LdatKind.twoD;
  return LdatKind.oneD;
}

/** The raw binary interpolation byte (1 linear, 2 bezier, 3 hold) for a KeyframeInterpolationType. */
export const rawInterpolation = (type: number) => (type >= 6612 && type <= 6614 ? type - 6611 : 1);

export const DEFAULT_INFLUENCE = 1 / 6;

/** Byte offsets within one keyframe item. */
export class ItemLayout {
  readonly kind: LdatKind;
  readonly size: number;
  readonly dims: number;

  constructor(kind: LdatKind) {
    this.kind = kind;
    this.size = ITEM_SIZES[kind] ?? 0;
    this.dims = kind === LdatKind.color ? 4 : (DIMENSIONS[kind] ?? 0);
  }

  get spatial(): boolean {
    return this.kind === LdatKind.twoDSpatial || this.kind === LdatKind.threeDSpatial;
  }

  /** One ease shared by all dimensions (spatial, color and value-less items). */
  get sharedEase(): boolean {
    return !(this.kind === LdatKind.oneD || this.kind === LdatKind.twoD || this.kind === LdatKind.threeD);
  }

  get easeCount(): number {
    return this.sharedEase ? 1 : this.dims;
  }

  valueAt(i: number): number | undefined {
    if (i >= this.dims) return undefined;
    if (this.kind === LdatKind.color || this.spatial) return 56 + i * 8;
    return this.sharedEase ? undefined : 8 + i * 8;
  }

  tangentAt(direction: "in" | "out", i: number): number | undefined {
    if (!this.spatial) return undefined;
    return 56 + ((direction === "in" ? 1 : 2) * this.dims + i) * 8;
  }

  /** [speed offset, influence offset] of ease `i` on one side. */
  easeAt(direction: "in" | "out", i: number): [number, number] {
    if (this.sharedEase) {
      const at = direction === "in" ? 24 : 40;
      return [at, at + 8];
    }
    const n = this.dims;
    const speed = 8 + ((direction === "in" ? 1 : 3) * n + i) * 8;
    const influence = 8 + ((direction === "in" ? 2 : 4) * n + i) * 8;
    return [speed, influence];
  }
}

/** A mutable view of one keyframe item. */
export class KeyItem {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly layout: ItemLayout;

  constructor(bytes: Uint8Array, layout: ItemLayout) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.layout = layout;
  }

  static create(layout: ItemLayout, timeUnits: number): KeyItem {
    const item = new KeyItem(new Uint8Array(layout.size), layout);
    item.timeUnits = timeUnits;
    item.bytes[4] = 1;
    item.bytes[5] = 1;
    const kind = layout.kind;
    item.bytes[7] = layout.spatial ? 7 : kind === LdatKind.color || kind === LdatKind.noValue || kind === LdatKind.orientation ? 1 : 0;
    if (layout.spatial) item.bytes[11] = 1;
    for (const direction of ["in", "out"] as const) {
      for (let i = 0; i < layout.easeCount; i++) item.setEase(direction, i, 0, DEFAULT_INFLUENCE);
    }
    return item;
  }

  clone(): KeyItem {
    return new KeyItem(this.bytes.slice(), this.layout);
  }

  get timeUnits(): number {
    return this.view.getInt32(0);
  }

  set timeUnits(units: number) {
    if (!Number.isInteger(units) || units < -0x80000000 || units > INT32_MAX) {
      throw new RangeError(`keyframe time ${units} does not fit the 32-bit time field`);
    }
    this.view.setInt32(0, units);
  }

  get inInterpolation(): number {
    return this.bytes[4];
  }

  set inInterpolation(raw: number) {
    this.bytes[4] = raw;
  }

  get outInterpolation(): number {
    return this.bytes[5];
  }

  set outInterpolation(raw: number) {
    this.bytes[5] = raw;
  }

  get temporalAutoBezier(): boolean {
    return getBit(this.bytes, 7, 4);
  }

  set temporalAutoBezier(on: boolean) {
    setBit(this.bytes, 7, 4, on);
  }

  get temporalContinuous(): boolean {
    return getBit(this.bytes, 7, 3);
  }

  set temporalContinuous(on: boolean) {
    setBit(this.bytes, 7, 3, on);
  }

  /** Stored value components (raw units), or undefined for value-less items. */
  get value(): number[] | undefined {
    const n = this.layout.dims;
    if (this.layout.valueAt(0) === undefined) return undefined;
    return Array.from({ length: n }, (_, i) => this.view.getFloat64(this.layout.valueAt(i)!));
  }

  set value(raw: number[] | undefined) {
    if (!raw) return;
    raw.forEach((v, i) => {
      const at = this.layout.valueAt(i);
      if (at !== undefined) this.view.setFloat64(at, v);
    });
  }

  ease(direction: "in" | "out", i: number): { speed: number; influence: number } {
    const [s, f] = this.layout.easeAt(direction, i);
    return { speed: this.view.getFloat64(s), influence: this.view.getFloat64(f) };
  }

  setEase(direction: "in" | "out", i: number, speed: number, influence: number): void {
    const [s, f] = this.layout.easeAt(direction, i);
    this.view.setFloat64(s, speed);
    this.view.setFloat64(f, influence);
  }

  /** The orientation angles AE mirrors into an orientation item, little-endian. */
  set orientation(values: number[]) {
    values.slice(0, 3).forEach((v, i) => this.view.setFloat64(56 + i * 8, v, true));
  }
}

/** lhd3 count plus the capacity counters AE validates with it (blocks of 4 for keyframes). */
export function writeLhd3Count(bytes: Uint8Array, count: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks = Math.max(1, Math.ceil(count / 4));
  view.setUint16(10, count);
  view.setUint32(12, blocks);
  view.setUint32(24, 1);
  view.setUint32(28, blocks * 4);
}

/** A fresh keyframe `LIST:list` (lhd3 + ldat) for `kind`. */
export function keyframeList(kind: LdatKind, items: KeyItem[]): Chunk {
  const lhd3 = new Uint8Array(52);
  lhd3.set([0x00, 0xd0, 0x0b, 0xee]);
  const view = new DataView(lhd3.buffer);
  view.setUint16(18, ITEM_SIZES[kind] ?? 0);
  lhd3[23] = 4;
  writeLhd3Count(lhd3, items.length);
  return list("list", [leaf("lhd3", lhd3), leaf("ldat", joinItems(items))]);
}

export function joinItems(items: KeyItem[]): Uint8Array {
  const size = items.reduce((n, item) => n + item.bytes.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const item of items) {
    out.set(item.bytes, at);
    at += item.bytes.length;
  }
  return out;
}

export function splitItems(ldat: Uint8Array, count: number, layout: ItemLayout): KeyItem[] {
  const items: KeyItem[] = [];
  for (let i = 0; i < count && (i + 1) * layout.size <= ldat.length; i++) {
    items.push(new KeyItem(ldat.slice(i * layout.size, (i + 1) * layout.size), layout));
  }
  return items;
}

/** A static cdat padded to AE's canonical length: 3 doubles per dimension for colors and spatial values, else 5. */
export function staticCdat(raw: number[], cls: PropertyClass): Chunk {
  if (cls.noValue) return leaf("cdat", new Uint8Array(4));
  if (cls.parallel) return leaf("cdat", doubles(raw.slice(0, 3), true));
  const target = Math.max(raw.length, cls.dimensions * (cls.color || cls.spatial ? 3 : 5));
  const values = raw.slice();
  while (values.length < target) values.push(0);
  return leaf("cdat", doubles(values));
}

export { doubles, readDoubles };

export function replaceChild(tx: Transaction, parent: Chunk, old: Chunk, replacement: Chunk[]): void {
  const children = parent.children ?? [];
  const i = children.indexOf(old);
  if (i < 0) throw new Error(`chunk ${old.type} is not a child of ${parent.listType ?? parent.type}`);
  tx.setChildren(parent, [...children.slice(0, i), ...replacement, ...children.slice(i + 1)]);
}

export function insertAfter(tx: Transaction, parent: Chunk, anchor: Chunk | undefined, inserted: Chunk): void {
  const children = parent.children ?? [];
  const i = anchor ? children.indexOf(anchor) : -1;
  tx.setChildren(parent, [...children.slice(0, i + 1), inserted, ...children.slice(i + 1)]);
}

export function removeChild(tx: Transaction, parent: Chunk, removed: Chunk): void {
  tx.setChildren(
    parent,
    (parent.children ?? []).filter((c) => c !== removed),
  );
}
