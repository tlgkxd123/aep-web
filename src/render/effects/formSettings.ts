// Trapcode Form's settings as its look-alike (form.ts) draws them, read by parameter name (namedParams.ts): no
// project here defines Form, so its parameter indices are not known. Free of WebGL.
import type { NamedParams } from "./namedParams.ts";

export const FormBase = { GRID: 1, STRINGS: 2, SPHERE: 3 } as const;
export const FormBlend = { NORMAL: 1, ADD: 2, SCREEN: 3, LIGHTEN: 4 } as const;

/** Most particles drawn: larger forms are drawn with every n-th particle. */
export const MAX_FORM_PARTICLES = 1 << 21;
/** Most particles along a string of the Box - Strings base form. */
const MAX_STRING_PARTICLES = 4096;

type Vec3 = [number, number, number];

const TOPIC = {
  base: ["Base Form"],
  particle: ["Particle"],
  disperse: ["Disperse & Twist"],
  fractal: ["Fractal Field"],
  world: ["World Transform", "Transform"],
  visibility: ["Visibility"],
} as const;

export interface FormSettings {
  base: number;
  /** Size X, Y, Z (pixels). */
  size: Vec3;
  /** Particles in X, Y, Z; for the sphere, around, from pole to pole and Sphere Layers. */
  count: Vec3;
  center: Vec3;
  /** Base form rotation X, Y, Z (degrees). */
  rotation: Vec3;
  particleSize: number;
  /** 0..1 */
  sizeRandom: number;
  opacity: number;
  opacityRandom: number;
  feather: number;
  color: Vec3;
  /** Particle types with a glow draw a halo around the sphere. */
  glow: boolean;
  blend: number;
  disperse: number;
  twist: number;
  fractal: {
    /** Size and opacity change by up to this share (1 = 100%) with the field. */
    affectSize: number;
    affectOpacity: number;
    displace: Vec3;
    flow: Vec3;
    evolution: number;
    offsetEvolution: number;
    /** Field cycles per pixel. */
    frequency: number;
    octaves: number;
    octaveMultiplier: number;
    octaveScale: number;
  };
  world: { rotation: Vec3; offset: Vec3 };
  visibility: { nearVanish: number; nearFade: number; farFade: number; farVanish: number };
  /** Settings drawn otherwise than Form draws them, for the render notes. */
  unsupported: string[];
}

/** Form's settings at a time, for a comp of `compSize`. */
export function formSettings(p: NamedParams, compSize: [number, number]): FormSettings {
  const unsupported: string[] = [];
  const baseLabel = p.option(TOPIC.base, ["Base Form"]);
  let base: number = FormBase.GRID;
  if (baseLabel?.includes("sphere")) base = FormBase.SPHERE;
  else if (baseLabel?.includes("string")) base = FormBase.STRINGS;
  else if (baseLabel && !baseLabel.includes("grid")) unsupported.push(`the base form is drawn as a grid`);
  const center2 = p.vec(TOPIC.base, ["Center XY", "Position XY", "Position", "Center"], [compSize[0] / 2, compSize[1] / 2]);
  const centerZ = p.num(TOPIC.base, ["Center Z", "Position Z"], center2[2] ?? 0);
  const rot = (topic: readonly string[], axis: string) => p.num(topic, [`${axis} Rotation`, `Rotate ${axis}`, `${axis} Rotate`], 0);
  const count = (axis: string, fallback: number) => Math.max(1, Math.round(p.num(TOPIC.base, [`Particles in ${axis}`], fallback)));
  const counts: Vec3 = [count("X", 100), count("Y", 100), count("Z", 1)];
  if (base === FormBase.SPHERE) counts[2] = Math.max(1, Math.round(p.num(TOPIC.base, ["Sphere Layers"], 1)));
  const particleType = p.option(TOPIC.particle, ["Particle Type"]);
  const transfer = p.option(TOPIC.particle, ["Transfer Mode"]);
  const blend = transfer === "add" ? FormBlend.ADD : transfer === "screen" ? FormBlend.SCREEN : transfer === "lighten" ? FormBlend.LIGHTEN : FormBlend.NORMAL;
  if (transfer && blend === FormBlend.NORMAL && transfer !== "normal") unsupported.push(`the ${transfer} transfer mode is drawn as Normal`);
  const color = p.vec(TOPIC.particle, ["Color"], [1, 1, 1]);
  const displace = p.num(TOPIC.fractal, ["Displace", "X Displace"], 0);
  const individual = !!p.option(TOPIC.fractal, ["Displacement Mode"])?.includes("individual");
  const flowAxis = (axis: string) => p.num(TOPIC.fractal, [`Flow ${axis}`], 0);
  const percent = (topic: readonly string[], names: string[], fallback: number) => Math.min(1, Math.max(0, p.num(topic, names, fallback) / 100));
  return {
    base,
    size: [p.num(TOPIC.base, ["Size X"], 800), p.num(TOPIC.base, ["Size Y"], 800), p.num(TOPIC.base, ["Size Z"], 50)],
    count: counts,
    center: [center2[0] ?? compSize[0] / 2, center2[1] ?? compSize[1] / 2, centerZ],
    rotation: [rot(TOPIC.base, "X"), rot(TOPIC.base, "Y"), rot(TOPIC.base, "Z")],
    particleSize: Math.max(0, p.num(TOPIC.particle, ["Size"], 4)),
    sizeRandom: percent(TOPIC.particle, ["Size Random"], 0),
    opacity: percent(TOPIC.particle, ["Opacity"], 100),
    opacityRandom: percent(TOPIC.particle, ["Opacity Random"], 0),
    feather: percent(TOPIC.particle, ["Sphere Feather", "Feather"], 50),
    color: [color[0] ?? 1, color[1] ?? 1, color[2] ?? 1],
    glow: !!particleType?.includes("glow"),
    blend,
    disperse: Math.max(0, p.num(TOPIC.disperse, ["Disperse"], 0)),
    twist: p.num(TOPIC.disperse, ["Twist"], 0),
    fractal: {
      affectSize: p.num(TOPIC.fractal, ["Affect Size"], 0) / 10,
      affectOpacity: p.num(TOPIC.fractal, ["Affect Opacity"], 0) / 10,
      displace: individual ? [displace, p.num(TOPIC.fractal, ["Y Displace"], 0), p.num(TOPIC.fractal, ["Z Displace"], 0)] : [displace, displace, displace],
      flow: [flowAxis("X"), flowAxis("Y"), flowAxis("Z")],
      evolution: p.num(TOPIC.fractal, ["Flow Evolution"], 0),
      offsetEvolution: p.num(TOPIC.fractal, ["Offset Evolution"], 0),
      frequency: Math.max(0, p.num(TOPIC.fractal, ["F Scale"], 10)) / 1000,
      octaves: Math.min(8, Math.max(1, Math.round(p.num(TOPIC.fractal, ["Complexity"], 3)))),
      octaveMultiplier: p.num(TOPIC.fractal, ["Octave Multiplier"], 0.5),
      octaveScale: p.num(TOPIC.fractal, ["Octave Scale"], 1.5),
    },
    world: {
      rotation: [rot(TOPIC.world, "X"), rot(TOPIC.world, "Y"), rot(TOPIC.world, "Z")],
      offset: ["X", "Y", "Z"].map((a) => p.num(TOPIC.world, [`${a} Offset`, `Offset ${a}`], 0)) as Vec3,
    },
    visibility: {
      nearVanish: p.num(TOPIC.visibility, ["Near Vanish"], 1),
      nearFade: p.num(TOPIC.visibility, ["Near Start Fade"], 10),
      farFade: p.num(TOPIC.visibility, ["Far Start Fade"], 19000),
      farVanish: p.num(TOPIC.visibility, ["Far Vanish"], 20000),
    },
    unsupported,
  };
}

export interface FormLayout {
  /** Particles along each axis of the base form, as drawn. */
  count: Vec3;
  total: number;
  /** Every `stride`-th particle is drawn. */
  stride: number;
  drawn: number;
}

/** How many particles the look-alike draws for `s`. */
export function formLayout(s: FormSettings): FormLayout {
  const count: Vec3 = [...s.count];
  // Strings are lines of particles along X, closer than a particle's radius.
  if (s.base === FormBase.STRINGS) count[0] = Math.min(MAX_STRING_PARTICLES, Math.max(count[0], Math.ceil(Math.abs(s.size[0]) / Math.max(0.5, s.particleSize / 2))));
  const total = count[0] * count[1] * count[2];
  const stride = Math.max(1, Math.ceil(total / MAX_FORM_PARTICLES));
  return { count, total, stride, drawn: Math.ceil(total / stride) };
}

/** Visibility at camera depth `z`: fading in from Near Vanish to Near Start Fade, out from Far Start Fade to Far Vanish. */
export function formVisibility(v: FormSettings["visibility"], z: number): number {
  const near = v.nearFade > v.nearVanish ? (z - v.nearVanish) / (v.nearFade - v.nearVanish) : z >= v.nearVanish ? 1 : 0;
  const far = v.farVanish > v.farFade ? (v.farVanish - z) / (v.farVanish - v.farFade) : z <= v.farVanish ? 1 : 0;
  return Math.max(0, Math.min(1, near, far));
}
