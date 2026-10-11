// Decoders for fixed-layout chunk bodies. Offsets follow py-aep's chunk
// definitions (MIT, https://github.com/forticheprod/py-aep).
import type { Chunk } from "./riff.ts";

const utf8 = new TextDecoder("utf-8");
const ascii = new TextDecoder("latin1");
/** Longest text read without a decoder (see asciiText). */
const SHORT_TEXT = 256;

/**
 * Short all-ASCII bytes as text, which UTF-8 and latin1 decode alike; undefined otherwise. Match names and most other
 * strings of a project are, and a call into TextDecoder costs more than reading them here.
 */
function asciiText(bytes: Uint8Array): string | undefined {
  if (bytes.length > SHORT_TEXT) return undefined;
  const codes: number[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c >= 0x80) return undefined;
    codes[i] = c;
  }
  return String.fromCharCode.apply(null, codes);
}

function untilNul(bytes: Uint8Array): Uint8Array {
  const nul = bytes.indexOf(0);
  return nul >= 0 ? bytes.subarray(0, nul) : bytes;
}

export class Bytes {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number {
    return this.bytes.length;
  }
  has(offset: number, size: number): boolean {
    return offset + size <= this.bytes.length;
  }
  u8(o: number): number {
    return this.has(o, 1) ? this.view.getUint8(o) : 0;
  }
  u16(o: number): number {
    return this.has(o, 2) ? this.view.getUint16(o, false) : 0;
  }
  u32(o: number): number {
    return this.has(o, 4) ? this.view.getUint32(o, false) : 0;
  }
  s32(o: number): number {
    return this.has(o, 4) ? this.view.getInt32(o, false) : 0;
  }
  f32(o: number): number {
    return this.has(o, 4) ? this.view.getFloat32(o, false) : 0;
  }
  f64(o: number, littleEndian = false): number {
    return this.has(o, 8) ? this.view.getFloat64(o, littleEndian) : 0;
  }
  bit(o: number, bit: number): boolean {
    return ((this.u8(o) >> bit) & 1) === 1;
  }
  cstr(o: number, size: number): string {
    const text = untilNul(this.bytes.subarray(o, Math.min(o + size, this.bytes.length)));
    return asciiText(text) ?? utf8.decode(text);
  }
  ascii(o: number, size: number): string {
    const text = untilNul(this.bytes.subarray(o, Math.min(o + size, this.bytes.length)));
    return asciiText(text) ?? ascii.decode(text);
  }
}

const ratio = (dividend: number, divisor: number): number => (divisor ? dividend / divisor : 0);

export function utf8Of(chunk: Chunk | undefined): string {
  return chunk ? (asciiText(chunk.data) ?? utf8.decode(chunk.data)) : "";
}

/** `tdmn`: 40-byte NUL-padded match name. */
export function matchNameOf(chunk: Chunk): string {
  const text = untilNul(chunk.data);
  return asciiText(text) ?? utf8.decode(text);
}

/** Text of the Utf8 child of a container chunk (`tdsn`, `fnam`, `pdnm`). */
export function containerText(chunk: Chunk | undefined): string | undefined {
  const inner = chunk?.children?.find((c) => c.type === "Utf8");
  return inner ? utf8Of(inner) : undefined;
}

/** `cmta`: NUL-terminated UTF-8 comment with CRLF line endings. */
export function commentOf(chunk: Chunk | undefined): string {
  if (!chunk) return "";
  return utf8.decode(chunk.data).split("\0")[0].replace(/\r\n/g, "\n");
}

export interface Idta {
  itemType: number;
  id: number;
  label: number;
  isSolid: boolean;
}

export function decodeIdta(chunk: Chunk): Idta {
  const b = new Bytes(chunk.data);
  return { itemType: b.u16(0), id: b.u32(16), label: b.u8(58), isSolid: b.bit(23, 4) };
}

export interface Cdta {
  resolutionFactor: [number, number];
  internalTimebase: number;
  time: number;
  workAreaStart: number;
  workAreaDuration: number;
  duration: number;
  bgColor: [number, number, number];
  draft3d: boolean;
  preserveNestedResolution: boolean;
  preserveNestedFrameRate: boolean;
  frameBlending: boolean;
  motionBlur: boolean;
  hideShyLayers: boolean;
  width: number;
  height: number;
  pixelAspect: number;
  frameRate: number;
  displayStartTime: number;
  shutterAngle: number;
  shutterPhase: number;
  motionBlurAdaptiveSampleLimit: number;
  motionBlurSamplesPerFrame: number;
}

export function decodeCdta(chunk: Chunk): Cdta {
  const b = new Bytes(chunk.data);
  const duration = ratio(b.u32(44), b.u32(48));
  const workAreaStart = ratio(b.u32(28), b.u32(32));
  const workAreaEndDividend = b.u32(36);
  const workAreaDuration =
    workAreaEndDividend === 0xffffffff
      ? duration - workAreaStart
      : ratio(workAreaEndDividend, b.u32(40)) - workAreaStart;
  return {
    resolutionFactor: [b.u16(0), b.u16(2)],
    internalTimebase: b.u32(8),
    time: ratio(b.s32(20), b.u32(24)),
    workAreaStart,
    workAreaDuration,
    duration,
    bgColor: [b.u8(52) / 255, b.u8(53) / 255, b.u8(54) / 255],
    draft3d: b.bit(138, 7),
    preserveNestedResolution: b.bit(139, 7),
    preserveNestedFrameRate: b.bit(139, 5),
    frameBlending: b.bit(139, 4),
    motionBlur: b.bit(139, 3),
    hideShyLayers: b.bit(139, 0),
    width: b.u16(140),
    height: b.u16(142),
    pixelAspect: ratio(b.u32(144), b.u32(148)) || 1,
    frameRate: b.u16(156) + b.u16(158) / 65536,
    displayStartTime: ratio(b.s32(164), b.u32(168)),
    shutterAngle: b.u16(174),
    shutterPhase: b.s32(180),
    motionBlurAdaptiveSampleLimit: b.s32(196),
    motionBlurSamplesPerFrame: b.s32(200),
  };
}

export interface Ldta {
  id: number;
  quality: number;
  /** Stretch in percent; 100 means none. */
  stretch: number;
  startTime: number;
  /** In/out points in layer time (before start offset and stretch). */
  rawInPoint: number;
  rawOutPoint: number;
  samplingQuality: number;
  environmentLayer: boolean;
  charactersTowardCamera: boolean;
  threeDPerChar: boolean;
  frameBlendingMode: boolean;
  guideLayer: boolean;
  nullLayer: boolean;
  poiAutoOrient: boolean;
  cameraOrPoiAutoOrient: boolean;
  markersLocked: boolean;
  solo: boolean;
  threeDLayer: boolean;
  adjustmentLayer: boolean;
  autoOrientAlongPath: boolean;
  collapseTransformation: boolean;
  shy: boolean;
  locked: boolean;
  frameBlending: boolean;
  motionBlur: boolean;
  effectsActive: boolean;
  audioEnabled: boolean;
  enabled: boolean;
  sourceId: number;
  label: number;
  name: string;
  blendingModeRaw: number;
  preserveTransparency: boolean;
  dancingDissolve: boolean;
  trackMatteTypeRaw: number;
  layerType: number;
  parentId: number;
  lightAndMeshType: number;
  matteLayerId: number | undefined;
}

export function decodeLdta(chunk: Chunk): Ldta {
  const b = new Bytes(chunk.data);
  const stretchDivisor = b.u32(108);
  return {
    id: b.u32(0),
    quality: b.u16(4),
    stretch: stretchDivisor ? (b.s32(8) * 100) / stretchDivisor : 0,
    startTime: ratio(b.s32(12), b.u32(16)),
    rawInPoint: ratio(b.s32(20), b.u32(24)),
    rawOutPoint: ratio(b.s32(28), b.u32(32)),
    samplingQuality: b.bit(37, 6) ? 1 : 0,
    environmentLayer: b.bit(37, 5),
    charactersTowardCamera: b.bit(37, 4),
    threeDPerChar: b.bit(37, 3),
    frameBlendingMode: b.bit(37, 2),
    guideLayer: b.bit(37, 1),
    nullLayer: b.bit(38, 7),
    poiAutoOrient: b.bit(38, 6),
    cameraOrPoiAutoOrient: b.bit(38, 5),
    markersLocked: b.bit(38, 4),
    solo: b.bit(38, 3),
    threeDLayer: b.bit(38, 2),
    adjustmentLayer: b.bit(38, 1),
    autoOrientAlongPath: b.bit(38, 0),
    collapseTransformation: b.bit(39, 7),
    shy: b.bit(39, 6),
    locked: b.bit(39, 5),
    frameBlending: b.bit(39, 4),
    motionBlur: b.bit(39, 3),
    effectsActive: b.bit(39, 2),
    audioEnabled: b.bit(39, 1),
    enabled: b.bit(39, 0),
    sourceId: b.u32(40),
    label: b.u8(61),
    name: b.cstr(64, 32),
    blendingModeRaw: b.u8(99),
    preserveTransparency: b.bit(103, 0),
    dancingDissolve: b.bit(103, 1),
    trackMatteTypeRaw: b.u8(107),
    layerType: b.u8(131),
    parentId: b.u32(132),
    lightAndMeshType: b.u8(139),
    matteLayerId: b.has(160, 4) ? b.u32(160) : undefined,
  };
}

export interface Tdsb {
  rotoBezier: boolean;
  lockedRatio: boolean;
  dimensionsSeparated: boolean;
  enabled: boolean;
}

export function decodeTdsb(chunk: Chunk): Tdsb {
  const b = new Bytes(chunk.data);
  return {
    rotoBezier: b.u8(0) !== 0,
    lockedRatio: b.bit(2, 4),
    dimensionsSeparated: b.bit(2, 3),
    enabled: b.bit(3, 0),
  };
}

export interface Tdb4 {
  dimensions: number;
  isSpatial: boolean;
  isStatic: boolean;
  canVaryOverTime: boolean;
  timeBase: number;
  noValue: boolean;
  vector: boolean;
  integer: boolean;
  color: boolean;
  animated: boolean;
  expressionDisabled: boolean;
}

export function decodeTdb4(chunk: Chunk): Tdb4 {
  const b = new Bytes(chunk.data);
  return {
    dimensions: b.u16(2),
    isSpatial: b.bit(5, 3),
    isStatic: b.bit(5, 0),
    canVaryOverTime: b.bit(11, 1),
    timeBase: b.u32(12),
    noValue: b.bit(57, 0),
    vector: b.bit(59, 3),
    integer: b.bit(59, 2),
    color: b.bit(59, 0),
    animated: b.u8(68) !== 0,
    expressionDisabled: b.bit(119, 0),
  };
}

/** `cdat`: an array of doubles; little-endian inside an `otst` orientation. */
export function decodeCdat(chunk: Chunk, littleEndian = false): number[] {
  const b = new Bytes(chunk.data);
  const values: number[] = [];
  for (let o = 0; o + 8 <= b.length; o += 8) values.push(b.f64(o, littleEndian));
  return values;
}

export function decodeS32(chunk: Chunk): number {
  return new Bytes(chunk.data).s32(0);
}

export function decodeF64List(chunk: Chunk): number[] {
  return decodeCdat(chunk, false);
}

export const LdatKind = {
  unknown: "unknown",
  color: "color",
  threeDSpatial: "threeDSpatial",
  threeD: "threeD",
  twoDSpatial: "twoDSpatial",
  twoD: "twoD",
  oneD: "oneD",
  noValue: "noValue",
  orientation: "orientation",
  shape: "shape",
  marker: "marker",
  guide: "guide",
  renderSettings: "renderSettings",
  outputModule: "outputModule",
} as const;
export type LdatKind = (typeof LdatKind)[keyof typeof LdatKind];

const LDAT_KINDS = new Map<string, LdatKind>([
  ["1:2246", LdatKind.renderSettings],
  ["1:128", LdatKind.outputModule],
  ["2:16", LdatKind.guide],
  ["4:152", LdatKind.color],
  ["4:128", LdatKind.threeD],
  ["4:104", LdatKind.twoDSpatial],
  ["4:88", LdatKind.twoD],
  ["4:80", LdatKind.orientation],
  ["4:64", LdatKind.noValue],
  ["4:48", LdatKind.oneD],
  ["4:16", LdatKind.marker],
  ["4:8", LdatKind.shape],
]);

export interface Lhd3 {
  count: number;
  itemSize: number;
  itemTypeRaw: number;
  kind: LdatKind;
}

export function decodeLhd3(chunk: Chunk): Lhd3 {
  const b = new Bytes(chunk.data);
  const count = b.u16(10);
  const itemSize = b.u16(18);
  const itemTypeRaw = b.u8(23);
  return {
    count,
    itemSize,
    itemTypeRaw,
    kind: LDAT_KINDS.get(`${itemTypeRaw}:${itemSize}`) ?? LdatKind.unknown,
  };
}

export interface RawEase {
  speed: number;
  /** Fraction 0-1 as stored. */
  influence: number;
}

export interface RawKeyframe {
  timeUnits: number;
  /** Binary interpolation: 1 linear, 2 bezier, 3 hold. */
  inInterpolation: number;
  outInterpolation: number;
  label: number;
  roving: boolean;
  temporalAutoBezier: boolean;
  temporalContinuous: boolean;
  spatialAutoBezier: boolean;
  spatialContinuous: boolean;
  /** Stored value components (raw units; color is ARGB 0-255). */
  value: number[] | undefined;
  inEase: RawEase[];
  outEase: RawEase[];
  inSpatialTangent: number[] | undefined;
  outSpatialTangent: number[] | undefined;
}

const DIMENSIONS: Partial<Record<LdatKind, number>> = {
  threeD: 3,
  threeDSpatial: 3,
  twoD: 2,
  twoDSpatial: 2,
  oneD: 1,
};

export function decodeKeyframe(item: Bytes, kind: LdatKind): RawKeyframe {
  const flags = item.u8(7);
  const kf: RawKeyframe = {
    timeUnits: item.s32(0),
    inInterpolation: item.u8(4),
    outInterpolation: item.u8(5),
    label: item.u8(6),
    roving: ((flags >> 5) & 1) === 1,
    temporalAutoBezier: ((flags >> 4) & 1) === 1,
    temporalContinuous: ((flags >> 3) & 1) === 1,
    spatialAutoBezier: false,
    spatialContinuous: false,
    value: undefined,
    inEase: [],
    outEase: [],
    inSpatialTangent: undefined,
    outSpatialTangent: undefined,
  };
  const p = 8;
  const n = DIMENSIONS[kind];
  if (kind === LdatKind.color) {
    kf.inEase = [{ speed: item.f64(p + 16), influence: item.f64(p + 24) }];
    kf.outEase = [{ speed: item.f64(p + 32), influence: item.f64(p + 40) }];
    kf.value = [item.f64(p + 48), item.f64(p + 56), item.f64(p + 64), item.f64(p + 72)];
  } else if (kind === LdatKind.noValue || kind === LdatKind.orientation || kind === LdatKind.shape) {
    if (item.has(p, 48)) {
      kf.inEase = [{ speed: item.f64(p + 16), influence: item.f64(p + 24) }];
      kf.outEase = [{ speed: item.f64(p + 32), influence: item.f64(p + 40) }];
    }
  } else if ((kind === LdatKind.threeDSpatial || kind === LdatKind.twoDSpatial) && n) {
    const spatialFlags = item.u8(p + 3);
    kf.spatialAutoBezier = ((spatialFlags >> 1) & 1) === 1;
    kf.spatialContinuous = (spatialFlags & 1) === 1;
    const d = p + 8;
    kf.inEase = [{ speed: item.f64(d + 8), influence: item.f64(d + 16) }];
    kf.outEase = [{ speed: item.f64(d + 24), influence: item.f64(d + 32) }];
    const v = d + 40;
    kf.value = Array.from({ length: n }, (_, i) => item.f64(v + i * 8));
    kf.inSpatialTangent = Array.from({ length: n }, (_, i) => item.f64(v + (n + i) * 8));
    kf.outSpatialTangent = Array.from({ length: n }, (_, i) => item.f64(v + (2 * n + i) * 8));
  } else if (n) {
    const at = (block: number, i: number) => item.f64(p + (block * n + i) * 8);
    kf.value = Array.from({ length: n }, (_, i) => at(0, i));
    kf.inEase = Array.from({ length: n }, (_, i) => ({ speed: at(1, i), influence: at(2, i) }));
    kf.outEase = Array.from({ length: n }, (_, i) => ({ speed: at(3, i), influence: at(4, i) }));
  }
  return kf;
}

/** Splits an `ldat` body into fixed-size items. */
export function ldatItems(ldat: Chunk, lhd3: Lhd3): Bytes[] {
  const items: Bytes[] = [];
  if (!lhd3.itemSize) return items;
  for (let i = 0; i < lhd3.count; i++) {
    const start = i * lhd3.itemSize;
    if (start + lhd3.itemSize > ldat.data.length) break;
    items.push(new Bytes(ldat.data.subarray(start, start + lhd3.itemSize)));
  }
  return items;
}

export interface Sspc {
  sourceFormatType: string;
  width: number;
  height: number;
  duration: number;
  nativeFrameRate: number;
  invertAlpha: boolean;
  premultiplied: boolean;
  premulColor: [number, number, number];
  alphaModeRaw: number;
  fieldSeparationTypeRaw: number;
  fieldOrder: number;
  footageMissingAtSave: boolean;
  loop: number;
  pixelAspect: number;
  /** 0 = off, 1-10 = the pulldown phase. */
  removePulldownRaw: number;
  conformFrameRate: number;
  displayFrameRate: number;
  highQualityFieldSeparation: boolean;
  /** Hz; 0 without audio. */
  audioSampleRate: number;
  /** Image-sequence frame range; 0xFFFFFFFF when undefined. */
  startFrame: number;
  endFrame: number;
  framePadding: number;
}

export function decodeSspc(chunk: Chunk): Sspc {
  const b = new Bytes(chunk.data);
  return {
    sourceFormatType: b.ascii(22, 4),
    width: b.u16(32),
    height: b.u16(36),
    duration: ratio(b.u32(38), b.u32(42)),
    nativeFrameRate: b.u32(56) + b.u16(60) / 65536,
    invertAlpha: b.bit(69, 1),
    premultiplied: b.bit(69, 0),
    premulColor: [b.u8(70) / 255, b.u8(71) / 255, b.u8(72) / 255],
    alphaModeRaw: b.u8(73),
    fieldSeparationTypeRaw: b.u8(83),
    fieldOrder: b.u8(87),
    footageMissingAtSave: b.u8(115) !== 0,
    loop: b.u32(126),
    pixelAspect: ratio(b.u32(136), b.u32(140)) || 1,
    removePulldownRaw: b.u8(147),
    conformFrameRate: b.u16(148) + b.u16(150) / 65536,
    displayFrameRate: b.u16(152) + b.u16(154) / 65536,
    highQualityFieldSeparation: (b.u8(159) & 1) !== 0,
    audioSampleRate: chunk.data.length >= 168 ? b.f64(160) : 0,
    startFrame: b.u32(172),
    endFrame: b.u32(176),
    framePadding: b.u32(180),
  };
}

export type Opti =
  | { kind: "solid"; color: [number, number, number]; name: string }
  | { kind: "placeholder"; name: string }
  | { kind: "file"; assetType: string; layerName: string };

export function decodeOpti(chunk: Chunk): Opti {
  const b = new Bytes(chunk.data);
  const assetType = b.ascii(0, 4);
  const assetTypeInt = b.u16(4);
  if (!assetType && assetTypeInt === 2) return { kind: "placeholder", name: b.cstr(10, 256) };
  if (assetType.startsWith("Soli")) {
    return { kind: "solid", color: [b.f32(14), b.f32(18), b.f32(22)], name: b.cstr(26, 256) };
  }
  return { kind: "file", assetType, layerName: assetType === "TEXT" ? b.cstr(68, 256) : "" };
}

export interface Mkif {
  inverted: boolean;
  locked: boolean;
  motionBlurRaw: number;
  featherFalloffRaw: number;
  modeRaw: number;
  color: [number, number, number];
}

export function decodeMkif(chunk: Chunk): Mkif {
  const b = new Bytes(chunk.data);
  return {
    inverted: b.u8(0) !== 0,
    locked: b.u8(1) !== 0,
    motionBlurRaw: b.u8(2),
    featherFalloffRaw: b.u8(3),
    modeRaw: b.u16(6),
    color: [b.u8(45) / 255, b.u8(46) / 255, b.u8(47) / 255],
  };
}

export interface Shph {
  open: boolean;
  topLeft: [number, number];
  bottomRight: [number, number];
}

export function decodeShph(chunk: Chunk): Shph {
  const b = new Bytes(chunk.data);
  return {
    open: b.bit(3, 3),
    topLeft: [b.f32(4), b.f32(8)],
    bottomRight: [b.f32(12), b.f32(16)],
  };
}

/** Effect parameter definition (`pard`), the serialized SDK `PF_ParamDef`. */
export interface Pard {
  controlType: number;
  name: string;
  canVaryOverTime: boolean;
  invisible: boolean;
  lastValue?: number | number[];
  defaultValue?: number | number[];
  min?: number;
  max?: number;
  sliderMin?: number;
  sliderMax?: number;
  optionCount?: number;
}

export function decodePard(chunk: Chunk): Pard {
  const b = new Bytes(chunk.data);
  const controlType = b.u8(15);
  const pard: Pard = {
    controlType,
    name: b.cstr(16, 32),
    canVaryOverTime: (b.u8(51) & 0x02) === 0,
    invisible: (b.u8(6) & 0x02) !== 0,
  };
  const body = 56;
  const argbToRgba = (o: number) => [b.u8(o + 1) / 255, b.u8(o + 2) / 255, b.u8(o + 3) / 255, b.u8(o) / 255];
  switch (controlType) {
    case 1:
      pard.lastValue = b.s32(body);
      pard.min = b.s32(body + 68);
      pard.max = b.s32(body + 72);
      if (b.has(body + 76, 12)) {
        pard.sliderMin = b.s32(body + 76);
        pard.sliderMax = b.s32(body + 80);
        pard.defaultValue = b.s32(body + 84);
      }
      break;
    case 2:
      pard.lastValue = b.s32(body) / 65536;
      pard.min = b.s32(body + 68) / 65536;
      pard.max = b.s32(body + 72) / 65536;
      pard.sliderMin = b.s32(body + 76) / 65536;
      pard.sliderMax = b.s32(body + 80) / 65536;
      if (b.has(body + 84, 4)) pard.defaultValue = b.s32(body + 84) / 65536;
      break;
    case 3:
      pard.lastValue = b.s32(body) / 65536;
      if (b.has(body + 4, 4)) pard.defaultValue = b.s32(body + 4) / 65536;
      break;
    case 4:
      pard.lastValue = b.u32(body);
      pard.defaultValue = b.u8(body + 4);
      break;
    case 5:
      pard.lastValue = argbToRgba(body);
      pard.defaultValue = argbToRgba(body + 4);
      break;
    case 6:
      pard.lastValue = [b.s32(body) / 128, b.s32(body + 4) / 128];
      break;
    case 7:
      // PF_PopupDef: value, then A_short num_choices and a 1-based A_short default.
      pard.lastValue = b.u32(body);
      pard.optionCount = b.u16(body + 4);
      pard.defaultValue = b.u16(body + 6);
      break;
    case 10:
      pard.lastValue = b.f64(body);
      pard.min = b.f32(body + 48);
      pard.max = b.f32(body + 52);
      pard.sliderMin = b.f32(body + 56);
      pard.sliderMax = b.f32(body + 60);
      if (b.has(body + 64, 4)) pard.defaultValue = b.f32(body + 64);
      break;
    case 18:
      pard.lastValue = [b.f64(body) * 512, b.f64(body + 8) * 512, b.f64(body + 16) * 512];
      break;
  }
  return pard;
}
