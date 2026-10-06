// Builds a Project from the RIFX chunk tree. Structure and value conventions
// are ported from py-aep (MIT, https://github.com/forticheprod/py-aep).
import autoNames from "./data/match-names.json" with { type: "json" };
import {
  Bytes,
  commentOf,
  containerText,
  decodeCdat,
  decodeCdta,
  decodeF64List,
  decodeIdta,
  decodeKeyframe,
  decodeLdta,
  decodeLhd3,
  decodeMkif,
  decodePard,
  decodeS32,
  decodeShph,
  decodeTdb4,
  decodeTdsb,
  LdatKind,
  ldatItems,
  matchNameOf,
  utf8Of,
  type Ldta,
  type Pard,
  type RawKeyframe,
  type Tdb4,
} from "./decode.ts";
import { parseFootageItem } from "./footage.ts";
import {
  EffectControlType,
  PropertyValueType,
  type CompItem,
  type FolderItem,
  type Gradient,
  type Item,
  type Keyframe,
  type Layer,
  type LayerType,
  type Project,
  type Property,
  type PropertyGroup,
  type PropertyNode,
  type PropertyValue,
  type Shape,
} from "./model.ts";
import { filterLists, findChild, findList, readRifx, type Chunk } from "./riff.ts";
import { SPEC_NAMES, synthesizeLayer } from "./synthesize.ts";

const AUTO_NAMES: Record<string, string> = autoNames;
const UNNAMED = "-_0_/-";
const PERCENT_MATCH_NAMES = new Set(["ADBE Opacity", "ADBE Scale", "ADBE Mask Opacity"]);
const SKIP_RUN_CHUNKS = new Set(["engv", "aRbs"]);

const BLENDING_MODES: Record<number, number> = {
  0: 5212, 2: 5212, 3: 5213, 4: 5220, 5: 5216, 6: 5222, 7: 5226, 8: 5227, 9: 5228,
  10: 5215, 11: 5221, 12: 5234, 13: 5236, 14: 5237, 15: 5238, 16: 5239, 17: 5240,
  18: 5241, 19: 5242, 20: 5243, 21: 5245, 22: 5244, 23: 5225, 24: 5219, 25: 5235,
  26: 5233, 27: 5224, 28: 5218, 29: 5223, 30: 5217, 31: 5229, 32: 5230, 33: 5231,
  34: 5232, 35: 5246, 36: 5247, 37: 5248, 38: 5249,
};
const DANCING_DISSOLVE = 5214;

const LAYER_TYPES: Record<number, [LayerType, string]> = {
  0: ["AVLayer", "ADBE AV Layer"],
  1: ["LightLayer", "ADBE Light Layer"],
  2: ["CameraLayer", "ADBE Camera Layer"],
  3: ["TextLayer", "ADBE Text Layer"],
  4: ["ShapeLayer", "ADBE Vector Layer"],
  5: ["ThreeDModelLayer", "ADBE 3D Model Layer"],
  7: ["ParametricMeshLayer", "ADBE3D ParametricMeshLayer"],
};

const MASK_MOTION_BLUR: Record<number, number> = { 0: 7012, 1: 7014, 2: 7013 };

const EFFECT_VALUE_TYPES: Partial<Record<number, number>> = {
  [EffectControlType.LAYER]: PropertyValueType.LAYER_INDEX,
  [EffectControlType.INTEGER]: PropertyValueType.OneD,
  [EffectControlType.SCALAR]: PropertyValueType.OneD,
  [EffectControlType.ANGLE]: PropertyValueType.OneD,
  [EffectControlType.CHECKBOX]: PropertyValueType.OneD,
  [EffectControlType.COLOR]: PropertyValueType.COLOR,
  [EffectControlType.POINT]: PropertyValueType.TwoD_SPATIAL,
  [EffectControlType.POPUP]: PropertyValueType.OneD,
  [EffectControlType.NO_DATA]: PropertyValueType.NO_VALUE,
  [EffectControlType.FLOAT_SLIDER]: PropertyValueType.OneD,
  [EffectControlType.ARBITRARY]: PropertyValueType.CUSTOM_VALUE,
  [EffectControlType.PATH]: PropertyValueType.MASK_INDEX,
  [EffectControlType.GROUP_START]: PropertyValueType.NO_VALUE,
  [EffectControlType.GROUP_END]: PropertyValueType.NO_VALUE,
  [EffectControlType.BUTTON]: PropertyValueType.NO_VALUE,
  [EffectControlType.POINT_3D]: PropertyValueType.ThreeD_SPATIAL,
};

interface ParamDef {
  matchName: string;
  pard: Pard;
  name: string;
  options?: string[];
}

interface LayerContext {
  comp: CompItem;
  internalTimebase: number;
  ldta: Ldta;
  stretchFactor: number;
  hasSource: boolean;
  width: number;
  height: number;
  is3D: boolean;
  layerIndexById: Map<number, number>;
  /** Effect param definitions by effect match name (project EfdG plus cache). */
  effectDefs: Map<string, ParamDef[]>;
  warnings: string[];
}

interface LeafOptions {
  inEffect?: boolean;
  /** The enclosing effect's parameter definitions, by match name (nested parameters included). */
  paramDefs?: ReadonlyMap<string, ParamDef>;
}

interface ResolvedOptions {
  inEffect?: boolean;
  controlType?: number;
  /** Name to use when the file stores none (an effect parameter's definition name). */
  fallbackName?: string;
}

function resolveOptions(options: LeafOptions, matchName: string): ResolvedOptions {
  const def = options.paramDefs?.get(matchName);
  return { inEffect: options.inEffect, controlType: def?.pard.controlType, fallbackName: def?.name || undefined };
}

type Run = { matchName: string; chunks: Chunk[] };

function matchNameRuns(group: Chunk | undefined): Run[] {
  const runs: Run[] = [];
  let skipping = true;
  for (const chunk of group?.children ?? []) {
    if (chunk.type === "tdmn") {
      const matchName = matchNameOf(chunk);
      if (matchName === "ADBE Group End") {
        skipping = true;
        continue;
      }
      skipping = false;
      if (!runs.length || runs[runs.length - 1].matchName !== matchName) runs.push({ matchName, chunks: [] });
      runs[runs.length - 1].chunks.push(chunk);
    } else if (!skipping && !SKIP_RUN_CHUNKS.has(chunk.type)) {
      runs[runs.length - 1].chunks.push(chunk);
    }
  }
  return runs;
}

/** Names AE reports for Puppet tool groups that neither the file nor the py-aep tables carry. */
const EXTRA_NAMES: Record<string, string> = {
  "ADBE FreePin3 Mesh Group": "Mesh",
  "ADBE FreePin3 PosPins": "Deform",
  "ADBE FreePin3 PosPin Position": "Position",
  "ADBE FreePin3 PosPin Scale": "Scale",
  "ADBE FreePin3 PosPin Rotation": "Rotation",
};

function autoName(matchName: string): string | undefined {
  return AUTO_NAMES[matchName] ?? SPEC_NAMES.get(matchName) ?? EXTRA_NAMES[matchName];
}

function displayName(tdsn: Chunk | undefined, matchName: string, fallback?: string): string {
  const text = containerText(tdsn);
  if (text && text !== UNNAMED) return text;
  return fallback || autoName(matchName) || matchName;
}

function isStoredName(tdsn: Chunk | undefined): boolean {
  const text = containerText(tdsn);
  return !!text && text !== UNNAMED;
}

function interpolationType(raw: number): number {
  return raw >= 1 && raw <= 3 ? raw + 6611 : 6612;
}

function valueTypeFromFlags(tdb4: Tdb4): number {
  if (tdb4.color) return PropertyValueType.COLOR;
  if (tdb4.integer && tdb4.dimensions <= 1) return PropertyValueType.OneD;
  if (tdb4.vector || (tdb4.integer && tdb4.dimensions > 1)) {
    if (tdb4.dimensions === 2) return tdb4.isSpatial ? PropertyValueType.TwoD_SPATIAL : PropertyValueType.TwoD;
    if (tdb4.dimensions === 3) return tdb4.isSpatial ? PropertyValueType.ThreeD_SPATIAL : PropertyValueType.ThreeD;
    return PropertyValueType.OneD;
  }
  if (tdb4.noValue) return PropertyValueType.NO_VALUE;
  if (tdb4.dimensions === 1) return PropertyValueType.OneD;
  return PropertyValueType.NO_VALUE;
}

/** Converts stored units to the units ExtendScript reports. */
class ValueResolver {
  readonly percent: boolean;
  readonly color: boolean;
  readonly dimensions: number;
  readonly scale: number[] | undefined;
  readonly flattenScaleZ: boolean;
  /** Ease speeds of effect points are stored against the layer height. */
  speedFactor = 1;

  constructor(matchName: string, tdb4: Tdb4 | undefined, ctx: LayerContext, options: ResolvedOptions) {
    this.percent = PERCENT_MATCH_NAMES.has(matchName);
    this.color = options.controlType === EffectControlType.COLOR || (tdb4?.color ?? false);
    this.dimensions = tdb4?.dimensions ?? 1;
    this.flattenScaleZ = matchName === "ADBE Scale" && !ctx.is3D;
    // Values an effect creates without declaring them (a puppet pin) count as points by their flags.
    const flaggedPoint =
      options.controlType === undefined && !!tdb4 && tdb4.vector && (tdb4.dimensions === 2 || tdb4.dimensions === 3);
    const point =
      options.controlType === EffectControlType.POINT || options.controlType === EffectControlType.POINT_3D || flaggedPoint;
    if (matchName === "ADBE Anchor Point" && ctx.hasSource) {
      if (ctx.width && ctx.height) this.scale = [ctx.width, ctx.height, 1];
    } else if (options.inEffect && ctx.width && ctx.height && point) {
      // Effect points are stored as fractions of the layer; Z shares the height divisor.
      this.scale = [ctx.width, ctx.height, ctx.height];
      this.speedFactor = ctx.height;
    }
  }

  value(raw: number[] | undefined): PropertyValue {
    if (!raw || !raw.length) return null;
    let v = raw.slice(0, Math.max(this.dimensions, this.color ? 4 : 1));
    if (this.percent) v = v.map((x) => x * 100);
    if (this.flattenScaleZ && v.length >= 3) v[2] = 100;
    if (this.color && v.length === 4) {
      const [a, r, g, b] = v;
      v = [r / 255, g / 255, b / 255, a / 255];
    }
    if (this.scale) v = this.scaled(v);
    return v.length === 1 && !this.color ? v[0] : v;
  }

  scaled(v: number[]): number[] {
    const scale = this.scale;
    return scale ? v.map((x, i) => (i < scale.length ? x * scale[i] : x)) : v;
  }

  speed(raw: number): number {
    return (this.percent ? raw * 100 : raw) * this.speedFactor;
  }
}

class Parser {
  readonly warnings: string[] = [];
  readonly items = new Map<number, Item>();
  readonly effectTypes = new Map<string, string>();
  readonly effectDefs = new Map<string, ParamDef[]>();
  private readonly compChunks: [CompItem, Chunk][] = [];

  parseItemList(list: Chunk, parentFolderId: number): Item | undefined {
    const idtaChunk = findChild(list, "idta");
    if (!idtaChunk) {
      this.warnings.push(`item list at ${list.offset} has no idta chunk`);
      return undefined;
    }
    const idta = decodeIdta(idtaChunk);
    const base = {
      id: idta.id,
      name: utf8Of(findChild(list, "Utf8")),
      comment: commentOf(findChild(list, "cmta")),
      label: idta.label,
      parentFolderId,
      chunk: list,
    };
    let item: Item;
    if (idta.itemType === 1) {
      const folder: FolderItem = { ...base, kind: "folder", typeName: "Folder", items: [] };
      for (const child of filterLists(findList(list, "Sfdr"), "Item")) {
        const parsed = this.parseItemList(child, folder.id);
        if (parsed) folder.items.push(parsed);
      }
      item = folder;
    } else if (idta.itemType === 4) {
      const cdtaChunk = findChild(list, "cdta");
      if (!cdtaChunk) throw new Error(`composition "${base.name}" has no cdta chunk`);
      const cdta = decodeCdta(cdtaChunk);
      const comp: CompItem = {
        ...base,
        kind: "comp",
        typeName: "Composition",
        width: cdta.width,
        height: cdta.height,
        duration: cdta.duration,
        frameRate: cdta.frameRate,
        frameDuration: cdta.frameRate ? 1 / cdta.frameRate : 0,
        pixelAspect: cdta.pixelAspect,
        bgColor: cdta.bgColor,
        displayStartTime: cdta.displayStartTime,
        workAreaStart: cdta.workAreaStart,
        workAreaDuration: cdta.workAreaDuration,
        shutterAngle: cdta.shutterAngle,
        shutterPhase: cdta.shutterPhase,
        motionBlur: cdta.motionBlur,
        frameBlending: cdta.frameBlending,
        hideShyLayers: cdta.hideShyLayers,
        draft3d: cdta.draft3d,
        resolutionFactor: cdta.resolutionFactor,
        layers: [],
      };
      this.compChunks.push([comp, list]);
      item = comp;
    } else if (idta.itemType === 7) {
      item = parseFootageItem(list, base, this.warnings);
    } else {
      this.warnings.push(`unknown item type ${idta.itemType} for "${base.name}"`);
      return undefined;
    }
    this.items.set(item.id, item);
    return item;
  }

  parseEffectDefinitions(root: Chunk): void {
    for (const efdf of filterLists(findList(root, "EfdG"), "EfDf")) {
      const tdmn = findChild(efdf, "tdmn");
      const sspc = findList(efdf, "sspc");
      if (!tdmn || !sspc) continue;
      const matchName = matchNameOf(tdmn);
      const defs = this.paramDefs(sspc);
      if (defs.length) this.effectDefs.set(matchName, defs);
      const display = containerText(findChild(sspc, "fnam"));
      if (display) this.effectTypes.set(matchName, display);
    }
  }

  paramDefs(sspc: Chunk): ParamDef[] {
    const part = findList(sspc, "parT");
    if (!part) return [];
    const merged = new Map<string, Chunk[]>();
    for (const run of matchNameRuns(part)) {
      const existing = merged.get(run.matchName);
      if (existing) existing.push(...run.chunks);
      else merged.set(run.matchName, [...run.chunks]);
    }
    const defs: ParamDef[] = [];
    let index = 0;
    for (const [matchName, chunks] of merged) {
      if (index++ === 0) continue;
      const pardChunk = chunks.find((c) => c.type === "pard");
      if (!pardChunk) continue;
      const pard = decodePard(pardChunk);
      const def: ParamDef = { matchName, pard, name: pard.name };
      const pdnm = containerText(chunks.find((c) => c.type === "pdnm"));
      if (pdnm !== undefined) {
        if (pard.controlType === EffectControlType.POPUP) def.options = pdnm.split("|");
        // A button's pdnm is the label drawn on the button, not the parameter name.
        else if (pdnm && pard.controlType !== EffectControlType.BUTTON) def.name = pdnm;
      }
      defs.push(def);
    }
    return defs;
  }

  parseLayers(): void {
    for (const [comp, list] of this.compChunks) {
      const layerLists = filterLists(list, "Layr");
      const ldtas = layerLists.map((l) => {
        const chunk = findChild(l, "ldta");
        if (!chunk) throw new Error(`a layer in "${comp.name}" has no ldta chunk`);
        return decodeLdta(chunk);
      });
      const layerIndexById = new Map(ldtas.map((ldta, i) => [ldta.id, i + 1]));
      const internalTimebase = decodeCdta(findChild(list, "cdta")!).internalTimebase;
      comp.layers = layerLists.map((layerList, i) =>
        this.parseLayer(layerList, ldtas[i], i + 1, comp, internalTimebase, layerIndexById),
      );
    }
  }

  parseLayer(
    list: Chunk,
    ldta: Ldta,
    index: number,
    comp: CompItem,
    internalTimebase: number,
    layerIndexById: Map<number, number>,
  ): Layer {
    const [layerType, matchName] = LAYER_TYPES[ldta.layerType] ?? ["AVLayer", "ADBE AV Layer"];
    if (!LAYER_TYPES[ldta.layerType]) this.warnings.push(`layer "${ldta.name}" has unknown type ${ldta.layerType}`);
    const source = ldta.sourceId ? this.items.get(ldta.sourceId) : undefined;
    const sized = source && source.kind !== "folder" ? source : undefined;
    const width = sized ? sized.width : comp.width;
    const height = sized ? sized.height : comp.height;
    const stretchFactor = ldta.stretch !== 0 ? ldta.stretch / 100 : 1;
    const is3D = ldta.threeDLayer || layerType === "CameraLayer" || layerType === "LightLayer";
    const ctx: LayerContext = {
      comp,
      internalTimebase,
      ldta,
      stretchFactor,
      hasSource: !!sized,
      width,
      height,
      is3D,
      layerIndexById,
      effectDefs: this.effectDefs,
      warnings: this.warnings,
    };
    const rootGroup = findList(list, "tdgp");
    const properties = this.parseRuns(matchNameRuns(rootGroup), ctx, {});
    composeSeparatedPosition(properties);

    const timeRemap = findNode(properties, ["ADBE Time Remapping"]);
    const timeRemapEnabled = timeRemap?.kind === "property" && timeRemap.keyframes.length > 0;

    let inPoint = ldta.startTime + ldta.rawInPoint * stretchFactor;
    let outPoint = ldta.startTime + ldta.rawOutPoint * stretchFactor;
    const sourceDuration = sized ? sized.duration : 0;
    if (layerType === "AVLayer" && !timeRemapEnabled && sourceDuration > 0 && ldta.stretch >= 0) {
      inPoint = Math.max(inPoint, ldta.startTime);
      outPoint = Math.min(outPoint, ldta.startTime + sourceDuration * stretchFactor);
    }

    let autoOrient = 0;
    if (ldta.autoOrientAlongPath) autoOrient = 1;
    else if ((ldta.cameraOrPoiAutoOrient || ldta.poiAutoOrient) && ldta.threeDLayer) autoOrient = 2;
    else if (ldta.charactersTowardCamera && ldta.threeDPerChar) autoOrient = 3;

    let blendingMode = BLENDING_MODES[ldta.blendingModeRaw] ?? 5212;
    if (blendingMode === 5213 && ldta.dancingDissolve) blendingMode = DANCING_DISSOLVE;

    const layer: Layer = {
      id: ldta.id,
      index,
      name: utf8Of(findChild(list, "Utf8")) || source?.name || ldta.name,
      matchName,
      layerType,
      comment: commentOf(findChild(list, "cmta")),
      sourceId: ldta.sourceId,
      startTime: ldta.startTime,
      inPoint,
      outPoint,
      stretch: ldta.stretch,
      enabled: ldta.enabled,
      solo: ldta.solo,
      shy: ldta.shy,
      locked: ldta.locked,
      threeDLayer: ldta.threeDLayer,
      threeDPerChar: ldta.threeDPerChar,
      adjustmentLayer: ldta.adjustmentLayer,
      nullLayer: ldta.nullLayer,
      guideLayer: ldta.guideLayer,
      environmentLayer: ldta.environmentLayer,
      collapseTransformation: ldta.collapseTransformation,
      effectsActive: ldta.effectsActive,
      audioEnabled: ldta.audioEnabled,
      motionBlur: ldta.motionBlur,
      preserveTransparency: ldta.preserveTransparency,
      blendingMode,
      trackMatteType: ldta.trackMatteTypeRaw <= 4 ? ldta.trackMatteTypeRaw + 5012 : 5012,
      trackMatteLayerId: ldta.matteLayerId ?? 0,
      parentId: ldta.parentId,
      label: ldta.label,
      quality: ldta.quality <= 2 ? ldta.quality + 4612 : 4614,
      samplingQuality: 4812 + ldta.samplingQuality,
      autoOrient: 4212 + autoOrient,
      frameBlendingType: 4012 + (ldta.frameBlending ? (ldta.frameBlendingMode ? 2 : 1) : 0),
      timeRemapEnabled,
      width,
      height,
      properties,
      chunk: list,
    };
    synthesizeLayer(layer, comp);
    nameRotation(layer.properties, is3D);
    const transform = findNode(layer.properties, ["ADBE Transform Group"]);
    if (transform?.kind === "group") composeSeparatedPosition(transform.children);
    return layer;
  }

  parseRuns(runs: Run[], ctx: LayerContext, options: LeafOptions): PropertyNode[] {
    const nodes: PropertyNode[] = [];
    for (const run of runs) {
      try {
        this.parseRun(run, ctx, options, nodes);
      } catch (error) {
        ctx.warnings.push(`layer "${ctx.ldta.name}": skipped ${run.matchName}: ${(error as Error).message}`);
      }
    }
    return nodes;
  }

  parseRun(run: Run, ctx: LayerContext, options: LeafOptions, nodes: PropertyNode[]): void {
    const first = run.chunks.find((c) => c.type === "LIST");
    if (!first) return;
    const lists = (type: string) => run.chunks.filter((c) => c.type === "LIST" && c.listType === type);
    switch (first.listType) {
      case "sspc":
        for (const sspc of lists("sspc")) nodes.push(this.parseEffect(sspc, run.matchName, ctx));
        break;
      case "tdgp":
        if (run.matchName === "ADBE Mask Atom") {
          const mkifs = run.chunks.filter((c) => c.type === "mkif");
          lists("tdgp").forEach((tdgp, i) => nodes.push(this.parseMask(tdgp, mkifs[i], ctx, nodes.length + 1)));
        } else {
          for (const tdgp of lists("tdgp")) nodes.push(this.parseGroup(tdgp, run.matchName, ctx, options));
        }
        break;
      case "tdbs":
        nodes.push(this.parseLeaf(first, run.matchName, ctx, options));
        break;
      case "otst":
        nodes.push(this.parseOrientation(first, run.matchName, ctx));
        break;
      case "om-s":
        nodes.push(this.parseShape(first, run.matchName, ctx, run.matchName === "ADBE Mask Shape"));
        break;
      case "btds":
        nodes.push(this.parseWrapped(first, run.matchName, ctx, PropertyValueType.TEXT_DOCUMENT));
        break;
        case "GCst":
          nodes.push(this.parseGradient(first, run.matchName, ctx));
          break;
      case "mrst":
        nodes.push(this.parseWrapped(first, run.matchName, ctx, PropertyValueType.MARKER, false));
        break;
      case "OvG2": {
        const tdgp = lists("tdgp")[0];
        if (tdgp) nodes.push(this.parseGroup(tdgp, run.matchName, ctx, options));
        break;
      }
      default:
        ctx.warnings.push(`unsupported property container ${first.listType} for ${run.matchName}`);
    }
  }

  parseGroup(tdgp: Chunk, matchName: string, ctx: LayerContext, options: LeafOptions): PropertyGroup {
    const tdsb = findChild(tdgp, "tdsb");
    const children = this.parseRuns(matchNameRuns(tdgp), ctx, options);
    composeSeparatedPosition(children);
    return {
      kind: "group",
      matchName,
      name: displayName(findChild(tdgp, "tdsn"), matchName),
      autoNamed: !isStoredName(findChild(tdgp, "tdsn")),
      enabled: tdsb ? decodeTdsb(tdsb).enabled : true,
      children,
      chunk: tdgp,
    };
  }

  parseMask(tdgp: Chunk, mkif: Chunk | undefined, ctx: LayerContext, ordinal: number): PropertyGroup {
    const group = this.parseGroup(tdgp, "ADBE Mask Atom", ctx, {});
    if (!containerText(findChild(tdgp, "tdsn")) || containerText(findChild(tdgp, "tdsn")) === UNNAMED) {
      group.name = `Mask ${ordinal}`;
    }
    const shapeRun = matchNameRuns(tdgp).find((r) => r.matchName === "ADBE Mask Shape");
    const oms = shapeRun?.chunks.find((c) => c.type === "LIST" && c.listType === "om-s");
    const shapeTdsb = findChild(findList(oms, "tdbs"), "tdsb");
    if (mkif) {
      const info = decodeMkif(mkif);
      group.mask = {
        inverted: info.inverted,
        locked: info.locked,
        maskMode: info.modeRaw <= 6 ? info.modeRaw + 6812 : 6812,
        maskFeatherFalloff: info.featherFalloffRaw <= 1 ? info.featherFalloffRaw + 7212 : 7212,
        maskMotionBlur: MASK_MOTION_BLUR[info.motionBlurRaw] ?? 7012,
        color: info.color,
        rotoBezier: shapeTdsb ? decodeTdsb(shapeTdsb).rotoBezier : false,
      };
    }
    return group;
  }

  parseEffect(sspc: Chunk, matchName: string, ctx: LayerContext): PropertyGroup {
    const effectName = containerText(findChild(sspc, "fnam")) ?? this.effectTypes.get(matchName) ?? matchName;
    if (!this.effectTypes.has(matchName)) this.effectTypes.set(matchName, effectName);
    let defs = this.paramDefs(sspc);
    if (!defs.length) defs = ctx.effectDefs.get(matchName) ?? [];
    else if (!ctx.effectDefs.has(matchName)) ctx.effectDefs.set(matchName, defs);

    const tdgp = findList(sspc, "tdgp");
    const tdsb = findChild(tdgp, "tdsb");
    const defsByName = new Map(defs.map((d) => [d.matchName, d]));
    const parsed: PropertyNode[] = [];
    for (const run of matchNameRuns(tdgp)) {
      if (run.matchName.endsWith("-0000")) continue;
      const def = defsByName.get(run.matchName);
      const nodes = this.parseRuns([run], ctx, { inEffect: true, paramDefs: defsByName });
      for (const node of nodes) {
        if (def && node.kind === "property") applyParamDef(node, def);
        parsed.push(node);
      }
    }
    const parsedByName = new Map(parsed.map((p) => [p.matchName, p]));
    const children: PropertyNode[] = [];
    for (const def of defs) {
      if (def.matchName === "ADBE Force CPU GPU") continue;
      children.push(parsedByName.get(def.matchName) ?? synthesizeParam(def, ctx));
    }
    for (const node of parsed) if (!defsByName.has(node.matchName)) children.push(node);
    if (!children.some((c) => c.matchName === "ADBE Effect Built In Params")) {
      children.push({
        kind: "group",
        matchName: "ADBE Effect Built In Params",
        name: "Compositing Options",
        enabled: true,
        children: [],
        synthesized: true,
      });
    }

    return {
      kind: "group",
      matchName,
      name: displayName(findChild(tdgp, "tdsn"), matchName, effectName),
      enabled: tdsb ? decodeTdsb(tdsb).enabled : true,
      children,
      isEffect: true,
      effectName,
      chunk: sspc,
    };
  }

  parseLeaf(tdbs: Chunk, matchName: string, ctx: LayerContext, leafOptions: LeafOptions, littleEndianValue = false): Property {
    const options = resolveOptions(leafOptions, matchName);
    const tdsbChunk = findChild(tdbs, "tdsb");
    const tdb4Chunk = findChild(tdbs, "tdb4");
    const tdsb = tdsbChunk ? decodeTdsb(tdsbChunk) : undefined;
    const tdb4 = tdb4Chunk ? decodeTdb4(tdb4Chunk) : undefined;
    const resolver = new ValueResolver(matchName, tdb4, ctx, options);
    const expressionChunk = findChild(tdbs, "Utf8");
    const expression = expressionChunk ? utf8Of(expressionChunk) : "";

    let propertyValueType = tdb4 ? valueTypeFromFlags(tdb4) : PropertyValueType.NO_VALUE;
    if (options.controlType !== undefined) {
      propertyValueType = EFFECT_VALUE_TYPES[options.controlType] ?? propertyValueType;
    } else if (options.inEffect && tdb4?.noValue) {
      // An undeclared effect-internal slot flagged value-less holds scratch bytes, not a number.
      propertyValueType = PropertyValueType.NO_VALUE;
    }

    let value: PropertyValue = null;
    const tdpi = findChild(tdbs, "tdpi");
    const tdli = findChild(tdbs, "tdli");
    const cdat = findChild(tdbs, "cdat");
    if (tdpi) {
      const id = decodeS32(tdpi);
      value = id === 0 ? 0 : (ctx.layerIndexById.get(id) ?? 0);
      propertyValueType = PropertyValueType.LAYER_INDEX;
    } else if (tdli) {
      value = decodeS32(tdli);
      propertyValueType = PropertyValueType.MASK_INDEX;
    } else if (cdat && propertyValueType !== PropertyValueType.NO_VALUE) {
      value = resolver.value(decodeCdat(cdat, littleEndianValue));
    }

    let name = displayName(findChild(tdbs, "tdsn"), matchName, options.fallbackName);
    if (options.inEffect && propertyValueType === PropertyValueType.NO_VALUE && name === matchName) name = "";

    return {
      kind: "property",
      matchName,
      name,
      autoNamed: !options.inEffect && !isStoredName(findChild(tdbs, "tdsn")),
      propertyValueType,
      controlType: options.controlType,
      value,
      keyframes: this.parseKeyframes(tdbs, tdb4, resolver, ctx),
      expression,
      expressionEnabled: !!expression && !(tdb4?.expressionDisabled ?? false),
      enabled: tdsb?.enabled ?? true,
      dimensionsSeparated: tdsb?.dimensionsSeparated ?? false,
      isSpatial: tdb4?.isSpatial ?? false,
      canVaryOverTime: tdb4?.canVaryOverTime ?? true,
      chunk: tdbs,
    };
  }

  parseKeyframes(tdbs: Chunk, tdb4: Tdb4 | undefined, resolver: ValueResolver, ctx: LayerContext): Keyframe[] {
    const list = findList(tdbs, "list");
    const lhd3Chunk = findChild(list, "lhd3");
    const ldat = findChild(list, "ldat");
    if (!lhd3Chunk || !ldat) return [];
    const lhd3 = decodeLhd3(lhd3Chunk);
    let kind = lhd3.kind;
    if (kind === LdatKind.threeD && tdb4?.isSpatial) kind = LdatKind.threeDSpatial;
    const base = Math.floor(ctx.internalTimebase * Math.max(1, Math.abs(ctx.stretchFactor))) || 1;
    const offset = ctx.stretchFactor >= 0 ? ctx.ldta.startTime : ctx.ldta.startTime - Math.abs(ctx.stretchFactor) / 3000;
    const keyframes = ldatItems(ldat, lhd3).map((item) => {
      const raw: RawKeyframe = decodeKeyframe(item, kind);
      const ease = (e: { speed: number; influence: number }) => ({
        speed: resolver.speed(e.speed),
        influence: e.influence * 100,
      });
      return {
        time: (raw.timeUnits / base) * ctx.stretchFactor + offset,
        layerTime: raw.timeUnits / base,
        value: resolver.value(raw.value),
        inInterpolationType: interpolationType(raw.inInterpolation),
        outInterpolationType: interpolationType(raw.outInterpolation),
        inTemporalEase: raw.inEase.map(ease),
        outTemporalEase: raw.outEase.map(ease),
        inSpatialTangent: raw.inSpatialTangent && resolver.scaled(raw.inSpatialTangent),
        outSpatialTangent: raw.outSpatialTangent && resolver.scaled(raw.outSpatialTangent),
        spatialAutoBezier: raw.spatialAutoBezier,
        spatialContinuous: raw.spatialContinuous,
        temporalAutoBezier: raw.temporalAutoBezier,
        temporalContinuous: raw.temporalContinuous,
        roving: raw.roving,
        label: raw.label,
      };
    });
    applyAutoSpatialTangents(keyframes);
    return keyframes;
  }

  parseOrientation(otst: Chunk, matchName: string, ctx: LayerContext): Property {
    const tdbs = findList(otst, "tdbs");
    if (!tdbs) throw new Error(`orientation ${matchName} has no tdbs`);
    const prop = this.parseLeaf(tdbs, matchName, ctx, {}, true);
    prop.propertyValueType = PropertyValueType.ThreeD_SPATIAL;
    const cdat = findChild(tdbs, "cdat");
    if (cdat) {
      const v = decodeCdat(cdat, true);
      while (v.length < 3) v.push(0);
      prop.value = v.slice(0, 3);
    }
    const otdas = (findList(otst, "otky")?.children ?? []).filter((c) => c.type === "otda");
    prop.keyframes.forEach((kf, i) => {
      if (otdas[i]) kf.value = decodeF64List(otdas[i]).slice(0, 3);
    });
    return prop;
  }

  parseShape(oms: Chunk, matchName: string, ctx: LayerContext, isMask: boolean): Property {
    const tdbs = findList(oms, "tdbs");
    if (!tdbs) throw new Error(`shape ${matchName} has no tdbs`);
    const prop = this.parseLeaf(tdbs, matchName, ctx, {});
    prop.propertyValueType = PropertyValueType.SHAPE;
    // Masks on layers with a source are stored as fractions of the source size;
    // on sourceless layers (shape layers) AE reads them as layer pixels.
    const maskScale: [number, number] | undefined = isMask ? (ctx.hasSource ? [ctx.width, ctx.height] : [1, 1]) : undefined;
    const shapes = filterLists(findList(oms, "omks"), "shap").map((shap) => decodeShape(shap, maskScale));
    prop.value = shapes[0] ?? null;
    prop.keyframes.forEach((kf, i) => {
      kf.value = shapes[i] ?? null;
    });
    return prop;
  }

  /** Gradient ramps: `GCst` holds the tdbs plus one XML document per keyframe (or one static) in `GCky`. */
  parseGradient(gcst: Chunk, matchName: string, ctx: LayerContext): Property {
    const prop = this.parseWrapped(gcst, matchName, ctx, PropertyValueType.CUSTOM_VALUE);
    const ramps = (findList(gcst, "GCky")?.children ?? []).filter((c) => c.type === "Utf8").map((c) => parseGradientXml(utf8Of(c)));
    prop.value = ramps[0] ?? null;
    prop.keyframes.forEach((kf, i) => {
      kf.value = ramps[i] ?? null;
    });
    return prop;
  }

  parseWrapped(wrapper: Chunk, matchName: string, ctx: LayerContext, valueType: number, withKeys = true): Property {
    const tdbs = findList(wrapper, "tdbs");
    if (!tdbs) throw new Error(`${wrapper.listType} ${matchName} has no tdbs`);
    const prop = this.parseLeaf(tdbs, matchName, ctx, {});
    prop.propertyValueType = valueType;
    prop.value = null;
    if (!withKeys) prop.keyframes = [];
    else for (const kf of prop.keyframes) kf.value = null;
    return prop;
  }
}

/** Reads AE's gradient `prop.map` XML: an alpha-stop list and a color-stop list, each sized by "Stops Size". */
function parseGradientXml(xml: string): Gradient | null {
  const section = (key: string): string => {
    const start = xml.indexOf(`<key>${key}</key>`);
    if (start < 0) return "";
    const nextKey = key === "Alpha Stops" ? "<key>Color Stops</key>" : "<key>Alpha Stops</key>";
    const end = xml.indexOf(nextKey, start);
    return xml.slice(start, end > start ? end : undefined);
  };
  const stops = (text: string, kind: "Alpha" | "Color"): number[][] => {
    const size = Number(/<key>Stops Size<\/key>\s*<int[^>]*>(\d+)<\/int>/.exec(text)?.[1] ?? Infinity);
    const found: [number, number[]][] = [];
    const re = new RegExp(`<key>Stop-(\\d+)</key>\\s*<prop\\.list>\\s*<prop\\.pair>\\s*<key>Stops ${kind}</key>\\s*<array>([\\s\\S]*?)</array>`, "g");
    for (const m of text.matchAll(re)) {
      found.push([Number(m[1]), [...m[2].matchAll(/<float>([^<]*)<\/float>/g)].map((f) => Number(f[1]))]);
    }
    return found.sort((a, b) => a[0] - b[0]).slice(0, size).map((f) => f[1]);
  };
  const colorStops = stops(section("Color Stops"), "Color")
    .filter((f) => f.length >= 5)
    .map((f) => ({ offset: f[0], midpoint: f[1], color: [f[2], f[3], f[4]] as [number, number, number] }));
  const alphaStops = stops(section("Alpha Stops"), "Alpha")
    .filter((f) => f.length >= 3)
    .map((f) => ({ offset: f[0], midpoint: f[1], alpha: f[2] }));
  return colorStops.length ? { colorStops, alphaStops } : null;
}

function decodeShape(shap: Chunk, maskSize: [number, number] | undefined): Shape {
  const shphChunk = findChild(shap, "shph");
  const shph = shphChunk ? decodeShph(shphChunk) : { open: false, topLeft: [0, 0], bottomRight: [0, 0] };
  const list = findList(shap, "list");
  const lhd3Chunk = findChild(list, "lhd3");
  const ldat = findChild(list, "ldat");
  const points: [number, number][] = [];
  if (lhd3Chunk && ldat) {
    for (const item of ldatItems(ldat, decodeLhd3(lhd3Chunk))) points.push([item.f32(0), item.f32(4)]);
  }
  const [tlx, tly] = shph.topLeft;
  const [brx, bry] = shph.bottomRight;
  const sx = maskSize ? maskSize[0] : 1;
  const sy = maskSize ? maskSize[1] : 1;
  const at = (i: number) => {
    const [px, py] = points[((i % points.length) + points.length) % points.length];
    return [(tlx * (1 - px) + brx * px) * sx, (tly * (1 - py) + bry * py) * sy];
  };
  const shape: Shape = { closed: !shph.open, vertices: [], inTangents: [], outTangents: [] };
  for (let i = 0; i < points.length; i += 3) {
    const v = at(i);
    const out = at(i + 1);
    const inn = at(i - 1);
    shape.vertices.push(v);
    shape.outTangents.push([out[0] - v[0], out[1] - v[1]]);
    shape.inTangents.push([inn[0] - v[0], inn[1] - v[1]]);
  }
  return shape;
}

function applyParamDef(prop: Property, def: ParamDef): void {
  prop.controlType = def.pard.controlType;
  prop.propertyValueType = EFFECT_VALUE_TYPES[def.pard.controlType] ?? prop.propertyValueType;
  prop.canVaryOverTime = def.pard.canVaryOverTime;
  if (def.options) prop.options = def.options;
  if (def.pard.min !== undefined) prop.min = def.pard.min;
  if (def.pard.max !== undefined) prop.max = def.pard.max;
}

function synthesizeParam(def: ParamDef, ctx: LayerContext): Property {
  const { pard } = def;
  const type = pard.controlType;
  // AE leaves a parameter out of the file while it sits at its default, so the
  // declared default wins over `lastValue`, which some plugins leave stale.
  let value: PropertyValue = null;
  if (type === EffectControlType.POPUP || type === EffectControlType.CHECKBOX) {
    value = (pard.defaultValue as number | undefined) || (pard.lastValue as number | undefined) || (type === EffectControlType.POPUP ? 1 : 0);
  } else if (type === EffectControlType.POINT || type === EffectControlType.POINT_3D) {
    const raw = pard.lastValue as number[] | undefined;
    const scale = ctx.width && ctx.height ? [ctx.width, ctx.height, ctx.height] : [512, 512, 512];
    value = raw ? raw.map((v, i) => (v / 512) * scale[i]) : null;
  } else if (type === EffectControlType.LAYER || type === EffectControlType.PATH) {
    value = 0;
  } else if (EFFECT_VALUE_TYPES[type] === PropertyValueType.NO_VALUE || type === EffectControlType.ARBITRARY) {
    value = null;
  } else {
    value = pard.defaultValue ?? pard.lastValue ?? null;
  }
  const propertyValueType = EFFECT_VALUE_TYPES[type] ?? PropertyValueType.OneD;
  const prop: Property = {
    kind: "property",
    matchName: def.matchName,
    name: def.name || autoName(def.matchName) || (propertyValueType === PropertyValueType.NO_VALUE ? "" : def.matchName),
    propertyValueType,
    controlType: type,
    value,
    keyframes: [],
    expression: "",
    expressionEnabled: false,
    enabled: true,
    dimensionsSeparated: false,
    isSpatial: type === EffectControlType.POINT || type === EffectControlType.POINT_3D,
    canVaryOverTime: pard.canVaryOverTime,
    synthesized: true,
  };
  applyParamDef(prop, def);
  return prop;
}

/**
 * AE ignores the stored tangents of a spatial auto-bezier keyframe and derives
 * them: one sixth of the chord between its neighbours, mirrored for the in side.
 */
function applyAutoSpatialTangents(keyframes: Keyframe[]): void {
  keyframes.forEach((kf, i) => {
    if (!kf.spatialAutoBezier || !kf.outSpatialTangent || !Array.isArray(kf.value)) return;
    const here = kf.value;
    const prev = keyframes[i - 1]?.value;
    const next = keyframes[i + 1]?.value;
    const low = Array.isArray(prev) ? prev : here;
    const high = Array.isArray(next) ? next : here;
    if (keyframes.length < 2) {
      kf.outSpatialTangent = here.map(() => 0);
      kf.inSpatialTangent = here.map(() => 0);
      return;
    }
    kf.outSpatialTangent = here.map((_, d) => (high[d] - low[d]) / 6);
    kf.inSpatialTangent = kf.outSpatialTangent.map((v) => -v);
  });
}

function composeSeparatedPosition(nodes: PropertyNode[]): void {
  const position = nodes.find((n): n is Property => n.kind === "property" && n.matchName === "ADBE Position");
  if (!position?.dimensionsSeparated) return;
  const followers = ["ADBE Position_0", "ADBE Position_1", "ADBE Position_2"].map((mn) =>
    nodes.find((n): n is Property => n.kind === "property" && n.matchName === mn),
  );
  const valueOf = (f: Property | undefined) => (f?.keyframes.length ? f.keyframes[0].value : f?.value);
  if (followers.some((f) => typeof valueOf(f) !== "number")) return;
  position.value = followers.map((f) => valueOf(f) as number);
}

/** AE calls Z Rotation "Rotation" on 2D layers. */
function nameRotation(nodes: PropertyNode[], is3D: boolean): void {
  const transform = nodes.find((n) => n.kind === "group" && n.matchName === "ADBE Transform Group");
  if (transform?.kind !== "group") return;
  const rotation = transform.children.find((n) => n.matchName === "ADBE Rotate Z");
  if (rotation) rotation.name = is3D ? "Z Rotation" : "Rotation";
}

export function findNode(nodes: PropertyNode[], path: string[]): PropertyNode | undefined {
  let current: PropertyNode | undefined;
  let level = nodes;
  for (const matchName of path) {
    current = level.find((n) => n.matchName === matchName);
    if (!current) return undefined;
    level = current.kind === "group" ? current.children : [];
  }
  return current;
}

export function parseProject(bytes: Uint8Array): Project {
  const file = readRifx(bytes);
  const root = file.root;
  const parser = new Parser();
  if (root.error) parser.warnings.push(root.error);

  const head = findChild(root, "head");
  let version = "";
  if (head) {
    const word = new Bytes(head.data).u32(4);
    const major = ((word >>> 26) & 0x1f) * 8 + ((word >>> 19) & 0x07);
    version = `${major}.${(word >>> 15) & 0x0f}x${word & 0xff}`;
  }
  const nnhd = findChild(root, "nnhd");
  // Projects without an ExEn chunk predate the JavaScript engine and use the legacy one.
  const expressionEngine = utf8Of(findChild(findList(root, "ExEn"), "Utf8")) || "extendscript";

  parser.parseEffectDefinitions(root);
  const rootList = findList(root, "Fold");
  if (!rootList) throw new Error("project has no root folder (LIST:Fold)");
  const rootFolder: FolderItem = {
    id: 0,
    name: "root",
    comment: "",
    label: 0,
    parentFolderId: 0,
    kind: "folder",
    typeName: "Folder",
    items: [],
    chunk: rootList,
  };
  for (const itemList of filterLists(rootList, "Item")) {
    const item = parser.parseItemList(itemList, 0);
    if (item) rootFolder.items.push(item);
  }
  parser.parseLayers();

  return {
    version,
    expressionEngine,
    // nnhd stores the depth as 0 / 1 / 2.
    bitsPerChannel: ({ 0: 8, 1: 16, 2: 32 } as Record<number, number>)[nnhd ? new Bytes(nnhd.data).u8(24) : 0] ?? 8,
    rootFolder,
    items: parser.items,
    effectTypes: parser.effectTypes,
    effectParams: new Map(
      [...parser.effectDefs].map(([matchName, defs]) => [
        matchName,
        defs.map((d) => ({
          matchName: d.matchName,
          name: d.name,
          controlType: d.pard.controlType,
          canVaryOverTime: d.pard.canVaryOverTime,
          invisible: d.pard.invisible,
          lastValue: d.pard.lastValue,
          defaultValue: d.pard.defaultValue,
          min: d.pard.min,
          max: d.pard.max,
          sliderMin: d.pard.sliderMin,
          sliderMax: d.pard.sliderMax,
          options: d.options,
        })),
      ]),
    ),
    warnings: parser.warnings,
    file,
  };
}
