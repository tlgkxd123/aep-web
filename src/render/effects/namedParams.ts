// Reading an effect's parameters by their display names, for plug-ins whose parameter indices are not known
// from any project here (their names are stored in every project that uses them). Names are matched ignoring
// case, punctuation and "&" against "and"; a parameter can be looked for inside its topic (a parameter group,
// at any depth), so names that repeat in several topics are told apart.
import type { Layer, Property, PropertyGroup } from "../../aep/model.ts";
import { effectParam } from "../effectParams.ts";

/** SDK PF_ParamType of a topic's start and end markers. */
const GROUP_START = 13;
const GROUP_END = 14;

export const normalizeName = (name: string): string => name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

interface Entry {
  name: string;
  topics: string[];
  prop: Property;
}

const indexes = new WeakMap<PropertyGroup, Entry[]>();

function index(effect: PropertyGroup): Entry[] {
  let entries = indexes.get(effect);
  if (entries) return entries;
  entries = [];
  const topics: string[] = [];
  for (const node of effect.children) {
    if (node.kind !== "property") continue;
    if (node.controlType === GROUP_START) topics.push(normalizeName(node.name));
    else if (node.controlType === GROUP_END) topics.pop();
    else entries.push({ name: normalizeName(node.name), topics: [...topics], prop: node });
  }
  indexes.set(effect, entries);
  return entries;
}

export interface NamedParams {
  /** The first parameter named one of `names`, inside one of `topics` when given. */
  prop(topics: readonly string[] | null, names: readonly string[]): Property | undefined;
  num(topics: readonly string[] | null, names: readonly string[], fallback: number): number;
  vec(topics: readonly string[] | null, names: readonly string[], fallback: number[]): number[];
  /** The label of a popup's chosen option, normalized (normalizeName); undefined when absent or unlabelled. */
  option(topics: readonly string[] | null, names: readonly string[]): string | undefined;
}

export function namedParams(effect: PropertyGroup, layer: Layer, time: number): NamedParams {
  const entries = index(effect);
  const prop = (topics: readonly string[] | null, names: readonly string[]) => {
    const wanted = names.map(normalizeName);
    const within = topics?.map(normalizeName);
    for (const name of wanted) {
      const found = entries.find((e) => e.name === name && (!within || e.topics.some((t) => within.includes(t))));
      if (found) return found.prop;
    }
    return undefined;
  };
  const value = (topics: readonly string[] | null, names: readonly string[]) => {
    const p = prop(topics, names);
    return p ? effectParam(effect, p.matchName, layer, time, null) : null;
  };
  const num = (topics: readonly string[] | null, names: readonly string[], fallback: number) => {
    const v = value(topics, names);
    const n = typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : NaN;
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    prop,
    num,
    vec(topics, names, fallback) {
      const v = value(topics, names);
      return Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : typeof v === "number" ? [v] : fallback;
    },
    option(topics, names) {
      const p = prop(topics, names);
      const label = p?.options?.[Math.round(num(topics, names, 0)) - 1];
      return label === undefined ? undefined : normalizeName(label);
    },
  };
}
