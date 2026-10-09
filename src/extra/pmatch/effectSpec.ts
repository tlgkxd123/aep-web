// The Particle Match effect as stored in a project: its match name, its parameters
// in order, and where its model lives (arbitrary data after the Model parameter).
import type { PropertyGroup } from "../../aep/model.ts";
import type { Chunk } from "../../aep/riff.ts";

export const PARTICLE_MATCH = "AEPW Particle Match";
export const PARTICLE_MATCH_NAME = "Particle Match";
export const PARTICLE_MATCH_CATEGORY = "Extra";

/** 1-based parameter indices. */
export const PM = {
  model: 1,
  audioLayer: 2,
  reactivity: 3,
  density: 4,
  speed: 5,
  size: 6,
  brightness: 7,
  color: 8,
  emitter: 9,
  scale: 10,
  seed: 11,
} as const;

export type ParamKind = "arbitrary" | "layer" | "slider" | "color" | "point";

export interface ParamSpec {
  name: string;
  kind: ParamKind;
  /** Slider: value, valid range and slider range. */
  value?: number;
  min?: number;
  max?: number;
  sliderMin?: number;
  sliderMax?: number;
}

export const PM_PARAMS: ParamSpec[] = [
  { name: "Model", kind: "arbitrary" },
  { name: "Audio Layer", kind: "layer" },
  { name: "Reactivity", kind: "slider", value: 100, min: 0, max: 1000, sliderMin: 0, sliderMax: 300 },
  { name: "Density", kind: "slider", value: 100, min: 0, max: 1000, sliderMin: 0, sliderMax: 400 },
  { name: "Speed", kind: "slider", value: 100, min: 0, max: 1000, sliderMin: 0, sliderMax: 400 },
  { name: "Size", kind: "slider", value: 100, min: 0, max: 1000, sliderMin: 0, sliderMax: 400 },
  { name: "Brightness", kind: "slider", value: 100, min: 0, max: 1000, sliderMin: 0, sliderMax: 400 },
  { name: "Color", kind: "color" },
  { name: "Emitter Position", kind: "point" },
  { name: "Scale", kind: "slider", value: 100, min: 1, max: 1000, sliderMin: 10, sliderMax: 400 },
  { name: "Random Seed", kind: "slider", value: 1, min: 0, max: 100000, sliderMin: 0, sliderMax: 1000 },
];

export function paramMatchName(index: number): string {
  return `${PARTICLE_MATCH}-${String(index).padStart(4, "0")}`;
}

const tdmnText = (c: Chunk) => new TextDecoder().decode(c.data).replace(/\0[\s\S]*$/, "");

/** The aRbp chunk holding the model of a Particle Match instance (in its tdgp, after the Model parameter's tdmn). */
export function modelChunk(effect: PropertyGroup | Chunk): Chunk | undefined {
  const root = "kind" in effect ? effect.chunk : effect;
  if (!root) return undefined;
  const model = paramMatchName(PM.model);
  let found: Chunk | undefined;
  const visit = (children: Chunk[]) => {
    let current = "";
    for (const c of children) {
      if (found) return;
      if (c.type === "tdmn") current = tdmnText(c);
      else if (c.type === "LIST" && c.listType === "aRbs" && current === model) found = c.children?.find((x) => x.type === "aRbp");
      else if (c.type === "LIST" && c.listType !== "parT" && c.children) visit(c.children);
    }
  };
  visit(root.children ?? []);
  return found;
}
