// Reading effect parameters at a time, for effect renderers.
import { currentValue } from "../aep/evaluate.ts";
import type { Layer, Property, PropertyGroup, PropertyValue } from "../aep/model.ts";

/**
 * The property of an effect parameter, by 1-based parameter index (match name
 * "<effect match name>-0001"...) or by full match name.
 */
export function effectProperty(effect: PropertyGroup, param: number | string): Property | undefined {
  const matchName = typeof param === "number" ? `${effect.matchName}-${String(param).padStart(4, "0")}` : param;
  const node = effect.children.find((n) => n.matchName === matchName);
  return node?.kind === "property" ? node : undefined;
}

/** The post-expression value of an effect parameter at comp time `time`, or `fallback` when absent. */
export function effectParam<T extends PropertyValue>(effect: PropertyGroup, param: number | string, layer: Layer, time: number, fallback: T): PropertyValue | T {
  const prop = effectProperty(effect, param);
  if (!prop) return fallback;
  return currentValue(prop, time, layer, effect.children) ?? fallback;
}

export function effectNumber(effect: PropertyGroup, param: number | string, layer: Layer, time: number, fallback = 0): number {
  const value = effectParam(effect, param, layer, time, fallback);
  return typeof value === "number" ? value : Array.isArray(value) && typeof value[0] === "number" ? value[0] : fallback;
}

export function effectVector(effect: PropertyGroup, param: number | string, layer: Layer, time: number, fallback: number[]): number[] {
  const value = effectParam(effect, param, layer, time, fallback);
  return Array.isArray(value) ? value : typeof value === "number" ? [value] : fallback;
}
