// The effect shaders the native engine embeds (native/src/fx_shaders.inc), taken from the TypeScript effects so both
// renderers run the same GLSL: each entry names the export of a module of src/render/effects that holds the fragment
// shader, or a function export called with arguments (which may be other exports or calls) for shaders the effect
// builds. scripts/generate/native-shaders.ts converts them from WebGL2's GLSL ES to Vulkan GLSL;
// native/src/effects/*.cpp refer to them as fx::<name>.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** An export of an effect module, called with `args` when given. */
export interface FxRef {
  module: string;
  export: string;
  args?: FxArg[];
}
export type FxArg = number | string | boolean | FxRef;

export interface FxShaderSource {
  /** C++ identifier: fx::<name>. */
  name: string;
  source: FxRef;
}

const ref = (module: string, name: string, ...args: FxArg[]): FxRef => ({ module: `src/render/effects/${module}`, export: name, ...(args.length ? { args } : {}) });
const shader = (name: string, module: string, exported: string): FxShaderSource => ({ name, source: ref(module, exported) });
/** A layerPass shader (stockUtil.ts) over `count` sources. */
const layerPass = (name: string, count: number, decls: FxArg, body: FxArg): FxShaderSource => ({
  name,
  source: ref("stockUtil.ts", "layerPassFragment", count, decls, body),
});
/** A generator of generateExtra.ts (generate()): its pattern's declarations and body. */
const generator = (name: string, prefix: string): FxShaderSource =>
  layerPass(name, 1, ref("generateExtra.ts", "generateDecls", ref("generateExtra.ts", `${prefix}_DECLS`)), ref("generateExtra.ts", "generateBody", ref("generateExtra.ts", `${prefix}_BODY`)));
/** A stroke of generateExtra.ts (strokePass()). */
const stroke = (name: string, prefix: string): FxShaderSource =>
  layerPass(name, 1, ref("generateExtra.ts", "strokeDecls", ref("generateExtra.ts", `${prefix}_DECLS`)), ref("generateExtra.ts", "strokeBody", ref("generateExtra.ts", `${prefix}_BODY`)));

export const FX_SHADERS: FxShaderSource[] = [
  shader("box_load", "boxBlur.ts", "LOAD_FS"),
  shader("box_level", "boxBlur.ts", "LEVEL_FS"),
  shader("box_accumulate", "boxBlur.ts", "ACCUMULATE_FS"),
  shader("box_finish", "boxBlur.ts", "FINISH_FS"),
  shader("box_store", "boxBlur.ts", "STORE_FS"),
  shader("glow_input", "deepGlow.ts", "INPUT_FS"),
  shader("glow_down", "deepGlow.ts", "DOWN_FS"),
  shader("glow_blur", "deepGlow.ts", "BLUR_FS"),
  shader("glow_accumulate", "deepGlow.ts", "ACCUMULATE_FS"),
  shader("glow_composite", "deepGlow.ts", "COMPOSITE_FS"),
  layerPass("strobe", 1, ref("stylizeExtra.ts", "STROBE_DECLS"), ref("stylizeExtra.ts", "STROBE_BODY")),
  generator("checkerboard", "CHECKERBOARD"),
  generator("circle", "CIRCLE"),
  generator("grid", "GRID"),
  stroke("ellipse", "ELLIPSE"),
  stroke("beam", "BEAM"),
  layerPass("alpha_box", 1, ref("generateExtra.ts", "ALPHA_BOX_DECLS"), ref("generateExtra.ts", "ALPHA_BOX_BODY")),
  layerPass("light_sweep", 1, ref("generateExtra.ts", "LIGHT_SWEEP_DECLS"), ref("generateExtra.ts", "lightSweepBody", false)),
  layerPass("light_sweep_edge", 2, ref("generateExtra.ts", "LIGHT_SWEEP_DECLS"), ref("generateExtra.ts", "lightSweepBody", true)),
  shader("fill", "matte.ts", "FILL_FS"),
  shader("polar", "polar.ts", "POLAR_FS"),
  shader("mirror", "mirrorRamp.ts", "MIRROR_FS"),
  shader("ramp", "mirrorRamp.ts", "RAMP_FS"),
];

async function value(arg: FxArg): Promise<unknown> {
  if (typeof arg !== "object") return arg;
  const module = (await import(pathToFileURL(resolve(arg.module)).href)) as Record<string, unknown>;
  const exported = module[arg.export];
  if (exported === undefined) throw new Error(`${arg.module} does not export ${arg.export}`);
  if (!arg.args) return exported;
  if (typeof exported !== "function") throw new Error(`${arg.module}'s ${arg.export} is not a function`);
  return (exported as (...args: unknown[]) => unknown)(...(await Promise.all(arg.args.map(value))));
}

/** The GLSL ES source of an entry, as the TypeScript effect compiles it. */
export async function fxSource(entry: FxShaderSource): Promise<string> {
  const source = await value(entry.source);
  if (typeof source !== "string") throw new Error(`${describeFx(entry.source)} is not a shader`);
  return source;
}

/** Where a shader comes from, for the generated header: `module export(args)`. */
export function describeFx(arg: FxArg): string {
  if (typeof arg !== "object") return JSON.stringify(arg);
  const name = arg.module.replace(/^src\/render\/effects\//, "");
  return `${name} ${arg.export}${arg.args ? `(${arg.args.map(describeFx).join(", ")})` : ""}`;
}

/** SHA-256 of an effect shader's source, as native/src/fx_shaders.inc records it. */
export const fxHash = (source: string): string => createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
