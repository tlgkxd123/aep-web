import {
  EffectControlType,
  type EffectParamDef,
  type Item,
  type Layer,
  type Project,
  type Property,
  type PropertyGroup,
  type PropertyNode,
} from "../aep/model.ts";
import { SOUND_KEYS_COMMANDS } from "../media/soundKeys.ts";

export type GroupRole = "effect" | "mask" | "transform" | "contents" | "text" | "plain";

/** A row of the property outline as AE shows it, after hiding what AE hides and nesting effect param groups. */
export type DisplayNode =
  | { kind: "group"; key: string; name: string; group: PropertyGroup; role: GroupRole }
  | { kind: "paramGroup"; key: string; name: string; prop: Property; children: DisplayNode[] }
  | { kind: "property"; key: string; name: string; prop: Property };

export interface OutlineContext {
  project: Project;
  layer: Layer;
}

export type OutlineMode = "timeline" | "effect-controls";

export const findNode = (nodes: PropertyNode[], matchName: string) => nodes.find((n) => n.matchName === matchName);

export function findProperty(nodes: PropertyNode[], matchName: string): Property | undefined {
  const node = findNode(nodes, matchName);
  return node?.kind === "property" ? node : undefined;
}

export function findGroup(nodes: PropertyNode[], matchName: string): PropertyGroup | undefined {
  const node = findNode(nodes, matchName);
  return node?.kind === "group" ? node : undefined;
}

export const isPluginEffect = (matchName: string) => !matchName.startsWith("ADBE ");

export const isCameraOrLight = (layer: Layer) => layer.layerType === "CameraLayer" || layer.layerType === "LightLayer";

export const is3D = (layer: Layer) => layer.threeDLayer || isCameraOrLight(layer);

export function hasStoredContent(node: PropertyNode): boolean {
  if (node.kind === "property") return !node.synthesized;
  return !node.synthesized || node.children.some(hasStoredContent);
}

export const sourceItem = (layer: Layer, project: Project): Item | undefined =>
  layer.sourceId ? project.items.get(layer.sourceId) : undefined;

const AUDIO_FILE = /\.(wav|wave|aif|aiff|mp3|m4a|aac|mov|mp4|m4v|avi|mxf)$/i;

export function layerHasAudio(layer: Layer, project: Project, depth = 0): boolean {
  if (layer.layerType !== "AVLayer" || depth > 8) return false;
  const source = sourceItem(layer, project);
  if (source?.kind === "footage") {
    if (source.mainSource.sourceType !== "FileSource") return false;
    return source.width === 0 || AUDIO_FILE.test(source.mainSource.file);
  }
  if (source?.kind === "comp") return source.layers.some((l) => layerHasAudio(l, project, depth + 1));
  return false;
}

export function layerHasVideo(layer: Layer, project: Project): boolean {
  if (layer.layerType !== "AVLayer") return true;
  const source = sourceItem(layer, project);
  return !(source?.kind === "footage" && source.width === 0);
}

export function layerEffects(layer: Layer): PropertyGroup[] {
  const parade = findGroup(layer.properties, "ADBE Effect Parade");
  return parade ? parade.children.filter((c): c is PropertyGroup => c.kind === "group") : [];
}

export const isAnimated = (prop: Property) => prop.keyframes.length > 0;

const ROLE_BY_MATCH_NAME: Record<string, GroupRole> = {
  "ADBE Transform Group": "transform",
  "ADBE Root Vectors Group": "contents",
  "ADBE Text Properties": "text",
};

function groupNode(group: PropertyGroup, key: string, name = group.name || group.matchName): DisplayNode {
  const role: GroupRole = group.isEffect ? "effect" : group.mask ? "mask" : (ROLE_BY_MATCH_NAME[group.matchName] ?? "plain");
  return { kind: "group", key, name, group, role };
}

const keyOf = (node: PropertyNode, index: number) => `${node.matchName}#${index}`;

const ALWAYS_SHOWN = new Set([
  "ADBE Transform Group",
  "ADBE Text Properties",
  "ADBE Root Vectors Group",
  "ADBE Camera Options Group",
  "ADBE Light Options Group",
]);

const NEVER_SHOWN = new Set([
  "ADBE Marker",
  "ADBE Data Group",
  "ADBE Layer Sets",
  "ADBE Source Options Group",
  "ADBE Plane Options Group",
  "ADBE Extrsn Options Group",
]);

function topLevelVisible(node: PropertyNode, ctx: OutlineContext): boolean {
  const { layer, project } = ctx;
  if (ALWAYS_SHOWN.has(node.matchName)) return true;
  if (NEVER_SHOWN.has(node.matchName)) return false;
  switch (node.matchName) {
    case "ADBE Time Remapping":
      return layer.timeRemapEnabled;
    case "ADBE MTrackers":
    case "ADBE Mask Parade":
    case "ADBE Effect Parade":
    case "ADBE Layer Overrides":
      return node.kind === "group" && node.children.length > 0;
    case "ADBE Layer Styles":
      return node.kind === "group" && node.children.some((c) => c.matchName !== "ADBE Blend Options Group" && c.enabled);
    case "ADBE Material Options Group":
      return layer.threeDLayer;
    case "ADBE Audio Group":
      return layerHasAudio(layer, project);
  }
  return hasStoredContent(node);
}

/** The properties AE lists when a layer is twirled open, in AE's order. */
export function layerOutline(ctx: OutlineContext): DisplayNode[] {
  return ctx.layer.properties.flatMap((node, i) => {
    if (!topLevelVisible(node, ctx)) return [];
    const key = keyOf(node, i);
    return node.kind === "group" ? [groupNode(node, key)] : [{ kind: "property", key, name: node.name, prop: node }];
  });
}

function transformChildVisible(prop: PropertyNode, layer: Layer, separated: boolean): boolean {
  const threeD = is3D(layer);
  const lightOrCamera = isCameraOrLight(layer);
  switch (prop.matchName) {
    case "ADBE Position":
      return !separated;
    case "ADBE Position_0":
    case "ADBE Position_1":
      return separated;
    case "ADBE Position_2":
      return separated && threeD;
    case "ADBE Scale":
    case "ADBE Opacity":
      return !lightOrCamera;
    case "ADBE Orientation":
    case "ADBE Rotate X":
    case "ADBE Rotate Y":
      return threeD;
    case "ADBE Envir Appear in Reflect":
      return false;
  }
  return true;
}

const paramDefCache = new WeakMap<Project, Map<string, Map<string, EffectParamDef>>>();

function paramDefs(project: Project, effectMatchName: string): Map<string, EffectParamDef> {
  let byEffect = paramDefCache.get(project);
  if (!byEffect) paramDefCache.set(project, (byEffect = new Map()));
  let defs = byEffect.get(effectMatchName);
  if (!defs) {
    defs = new Map((project.effectParams.get(effectMatchName) ?? []).map((d) => [d.matchName, d]));
    byEffect.set(effectMatchName, defs);
  }
  return defs;
}

export const paramDef = (project: Project, effectMatchName: string, paramMatchName: string) =>
  paramDefs(project, effectMatchName).get(paramMatchName);

/** Effect parameters arrive flat with group-start / group-end markers; AE shows them as twirl-down groups. */
function effectParams(effect: PropertyGroup, ctx: OutlineContext, mode: OutlineMode, keyPrefix: string): DisplayNode[] {
  const defs = paramDefs(ctx.project, effect.matchName);
  const root: DisplayNode[] = [];
  const stack: DisplayNode[][] = [root];
  effect.children.forEach((node, i) => {
    const current = stack[stack.length - 1];
    const key = `${keyPrefix}${keyOf(node, i)}`;
    if (node.kind === "group") {
      if (mode === "timeline" && node.matchName === "ADBE Effect Built In Params") current.push(groupNode(node, key));
      return;
    }
    const type = node.controlType;
    if (type === EffectControlType.GROUP_START) {
      const group: DisplayNode = { kind: "paramGroup", key, name: node.name, prop: node, children: [] };
      if (!defs.get(node.matchName)?.invisible) current.push(group);
      stack.push(group.children);
      return;
    }
    if (type === EffectControlType.GROUP_END) {
      if (stack.length > 1) stack.pop();
      return;
    }
    const command = mode === "effect-controls" && node.matchName === SOUND_KEYS_COMMANDS;
    if ((type === EffectControlType.NO_DATA && !command) || defs.get(node.matchName)?.invisible) return;
    if (mode === "timeline") {
      if (!node.name || type === EffectControlType.BUTTON || type === EffectControlType.ARBITRARY) return;
      if (!node.canVaryOverTime && !node.keyframes.length) return;
    } else if (!node.name) {
      return;
    }
    current.push({ kind: "property", key, name: node.name, prop: node });
  });
  if (mode === "timeline") return pruneEmptyParamGroups(root);
  return root;
}

function pruneEmptyParamGroups(nodes: DisplayNode[]): DisplayNode[] {
  return nodes.flatMap<DisplayNode>((n) => {
    if (n.kind !== "paramGroup") return [n];
    const children = pruneEmptyParamGroups(n.children);
    return children.length ? [{ ...n, children }] : [];
  });
}

/** Children of an outline row, applying AE's per-group visibility rules. */
export function outlineChildren(node: DisplayNode, ctx: OutlineContext, mode: OutlineMode = "timeline"): DisplayNode[] {
  if (node.kind === "paramGroup") return node.children;
  if (node.kind === "property") return [];
  const { group } = node;
  const prefix = `${node.key}/`;
  if (group.isEffect) return effectParams(group, ctx, mode, "");
  const { layer } = ctx;
  const out: DisplayNode[] = [];
  const push = (child: PropertyNode, i: number, name = child.name || child.matchName) => {
    const key = keyOf(child, i);
    out.push(child.kind === "group" ? groupNode(child, key, name) : { kind: "property", key, name, prop: child });
  };
  if (group.matchName === "ADBE Transform Group") {
    const position = findProperty(group.children, "ADBE Position");
    const separated = !!position?.dimensionsSeparated;
    group.children.forEach((child, i) => {
      if (!transformChildVisible(child, layer, separated)) return;
      const rename = child.matchName === "ADBE Rotate Z" && is3D(layer) ? "Z Rotation" : undefined;
      push(child, i, rename);
    });
    return out;
  }
  if (group.matchName === "ADBE Layer Styles") {
    group.children.forEach((child, i) => {
      if (child.matchName === "ADBE Blend Options Group" || child.enabled) push(child, i);
    });
    return out;
  }
  group.children.forEach((child, i) => {
    if (child.kind === "property") {
      if (child.matchName === "ADBE Force CPU GPU") return;
      push(child, i);
      return;
    }
    if (child.matchName === "ADBE Vector Materials Group" && !layer.threeDLayer) return;
    if (child.matchName === "ADBE Text Animators") {
      child.children.forEach((animator, j) => {
        if (animator.kind === "group") out.push(groupNode(animator, `${prefix}${keyOf(animator, j)}`));
      });
      return;
    }
    if (!child.children.length && child.matchName !== "ADBE Vectors Group") return;
    push(child, i);
  });
  return out;
}

export function nodeAnimated(node: DisplayNode): boolean {
  return node.kind === "property" && isAnimated(node.prop);
}

/** Every keyframe time on a layer's visible outline, for keyframe navigation. */
export function collectKeyframeTimes(props: PropertyNode[], into: number[] = []): number[] {
  for (const node of props) {
    if (node.kind === "property") {
      if (node.matchName !== "ADBE Marker") for (const k of node.keyframes) into.push(k.time);
    } else {
      collectKeyframeTimes(node.children, into);
    }
  }
  return into;
}
