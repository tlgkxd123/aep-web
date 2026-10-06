// Project model. Field names and enum values follow the After Effects
// ExtendScript API so parsed projects can be diffed against AE's own exports.
import type { Chunk, RifxFile } from "./riff.ts";

export const PropertyValueType = {
  NO_VALUE: 6412,
  ThreeD_SPATIAL: 6413,
  ThreeD: 6414,
  TwoD_SPATIAL: 6415,
  TwoD: 6416,
  OneD: 6417,
  COLOR: 6418,
  CUSTOM_VALUE: 6419,
  MARKER: 6420,
  LAYER_INDEX: 6421,
  MASK_INDEX: 6422,
  SHAPE: 6423,
  TEXT_DOCUMENT: 6424,
} as const;

export const KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 } as const;

export const EffectControlType = {
  LAYER: 0,
  INTEGER: 1,
  SCALAR: 2,
  ANGLE: 3,
  CHECKBOX: 4,
  COLOR: 5,
  POINT: 6,
  POPUP: 7,
  NO_DATA: 9,
  FLOAT_SLIDER: 10,
  ARBITRARY: 11,
  PATH: 12,
  GROUP_START: 13,
  GROUP_END: 14,
  BUTTON: 15,
  POINT_3D: 18,
} as const;

export interface Shape {
  closed: boolean;
  vertices: number[][];
  inTangents: number[][];
  outTangents: number[][];
}

export type PropertyValue = number | number[] | Shape | null;

export interface TemporalEase {
  speed: number;
  /** Percent, 0-100. */
  influence: number;
}

export interface Keyframe {
  /** Composition time in seconds. */
  time: number;
  value: PropertyValue;
  inInterpolationType: number;
  outInterpolationType: number;
  inTemporalEase: TemporalEase[];
  outTemporalEase: TemporalEase[];
  inSpatialTangent?: number[];
  outSpatialTangent?: number[];
  spatialAutoBezier: boolean;
  spatialContinuous: boolean;
  temporalAutoBezier: boolean;
  temporalContinuous: boolean;
  roving: boolean;
  label: number;
}

export interface Property {
  kind: "property";
  matchName: string;
  name: string;
  propertyValueType: number;
  /** Effect parameter control type (SDK PF_ParamType), when known. */
  controlType?: number;
  value: PropertyValue;
  keyframes: Keyframe[];
  expression: string;
  expressionEnabled: boolean;
  enabled: boolean;
  dimensionsSeparated: boolean;
  isSpatial: boolean;
  canVaryOverTime: boolean;
  /** Built from an effect parameter definition or default table because AE did not store it. */
  synthesized?: boolean;
  /** The name is derived from the match name rather than stored in the file. */
  autoNamed?: boolean;
  /** Popup option labels for effect dropdowns. */
  options?: string[];
  min?: number;
  max?: number;
  chunk?: Chunk;
}

export interface MaskInfo {
  inverted: boolean;
  locked: boolean;
  /** ExtendScript MaskMode. */
  maskMode: number;
  maskFeatherFalloff: number;
  maskMotionBlur: number;
  color: [number, number, number];
  rotoBezier: boolean;
}

export interface PropertyGroup {
  kind: "group";
  matchName: string;
  name: string;
  enabled: boolean;
  children: PropertyNode[];
  isEffect?: boolean;
  /** Display name of the effect type (for effects). */
  effectName?: string;
  mask?: MaskInfo;
  /** Created because AE did not store this (empty) group. */
  synthesized?: boolean;
  /** The name is derived from the match name rather than stored in the file. */
  autoNamed?: boolean;
  chunk?: Chunk;
}

export type PropertyNode = Property | PropertyGroup;

export type LayerType =
  | "AVLayer"
  | "LightLayer"
  | "CameraLayer"
  | "TextLayer"
  | "ShapeLayer"
  | "ThreeDModelLayer"
  | "ParametricMeshLayer";

export interface Layer {
  id: number;
  index: number;
  name: string;
  matchName: string;
  layerType: LayerType;
  comment: string;
  sourceId: number;
  startTime: number;
  inPoint: number;
  outPoint: number;
  stretch: number;
  enabled: boolean;
  solo: boolean;
  shy: boolean;
  locked: boolean;
  threeDLayer: boolean;
  threeDPerChar: boolean;
  adjustmentLayer: boolean;
  nullLayer: boolean;
  guideLayer: boolean;
  environmentLayer: boolean;
  collapseTransformation: boolean;
  effectsActive: boolean;
  audioEnabled: boolean;
  motionBlur: boolean;
  preserveTransparency: boolean;
  blendingMode: number;
  trackMatteType: number;
  trackMatteLayerId: number;
  parentId: number;
  label: number;
  quality: number;
  samplingQuality: number;
  autoOrient: number;
  frameBlendingType: number;
  timeRemapEnabled: boolean;
  width: number;
  height: number;
  properties: PropertyNode[];
  chunk: Chunk;
}

interface ItemBase {
  id: number;
  name: string;
  comment: string;
  label: number;
  parentFolderId: number;
  chunk?: Chunk;
}

export interface FolderItem extends ItemBase {
  kind: "folder";
  typeName: "Folder";
  items: Item[];
}

export type FootageSource =
  | { sourceType: "SolidSource"; color: [number, number, number] }
  | { sourceType: "PlaceholderSource" }
  | { sourceType: "FileSource"; file: string; assetType: string; isStill: boolean };

export interface FootageItem extends ItemBase {
  kind: "footage";
  typeName: "Footage";
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  pixelAspect: number;
  mainSource: FootageSource;
}

export interface CompItem extends ItemBase {
  kind: "comp";
  typeName: "Composition";
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  frameDuration: number;
  pixelAspect: number;
  bgColor: [number, number, number];
  displayStartTime: number;
  workAreaStart: number;
  workAreaDuration: number;
  shutterAngle: number;
  shutterPhase: number;
  motionBlur: boolean;
  frameBlending: boolean;
  hideShyLayers: boolean;
  draft3d: boolean;
  resolutionFactor: [number, number];
  layers: Layer[];
}

export type Item = FolderItem | FootageItem | CompItem;

/** An effect parameter as declared by the effect (built-in or plugin), from its `pard` record. */
export interface EffectParamDef {
  matchName: string;
  name: string;
  controlType: number;
  canVaryOverTime: boolean;
  invisible: boolean;
  lastValue?: number | number[];
  defaultValue?: number | number[];
  min?: number;
  max?: number;
  sliderMin?: number;
  sliderMax?: number;
  options?: string[];
}

export interface Project {
  version: string;
  expressionEngine: string;
  bitsPerChannel: number;
  rootFolder: FolderItem;
  /** All items keyed by id, excluding the root folder (id 0). */
  items: Map<number, Item>;
  /** Effect match name to display name, for every effect type the project uses. */
  effectTypes: Map<string, string>;
  /** Parameter definitions per effect match name. */
  effectParams: Map<string, EffectParamDef[]>;
  warnings: string[];
  file: RifxFile;
}
