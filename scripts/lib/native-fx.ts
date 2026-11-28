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
export type FxArg = number | string | boolean | FxRef | FxArg[];

export interface FxShaderSource {
  /** C++ identifier: fx::<name>. */
  name: string;
  source: FxRef;
  /** The vertex shader of an effect that draws geometry (FxContext::draw); fullscreen passes have none. */
  vertex?: FxRef;
}

const ref = (module: string, name: string, ...args: FxArg[]): FxRef => ({ module: `src/render/effects/${module}`, export: name, ...(args.length ? { args } : {}) });
const shader = (name: string, module: string, exported: string): FxShaderSource => ({ name, source: ref(module, exported) });
/** A program that draws geometry: a vertex and a fragment shader exported by the same module. */
const program = (name: string, module: string, vertex: string, fragment: string): FxShaderSource => ({ name, source: ref(module, fragment), vertex: ref(module, vertex) });
/** A layerPass shader (stockUtil.ts) over `count` sources. */
const layerPass = (name: string, count: number, decls: FxArg, body: FxArg): FxShaderSource => ({
  name,
  source: ref("stockUtil.ts", "layerPassFragment", count, decls, body),
});
/** A layerPass shader of stylizeExtra.ts from its PREFIX_DECLS and PREFIX_BODY exports. */
const stylize = (name: string, count: number, prefix: string): FxShaderSource => layerPass(name, count, ref("stylizeExtra.ts", `${prefix}_DECLS`), ref("stylizeExtra.ts", `${prefix}_BODY`));
/** A warp shader (stockUtil.ts warp()): `decls` declares `vec2 map(vec2 p)`. */
const warp = (name: string, decls: FxArg, post = ""): FxShaderSource => layerPass(name, 1, decls, ref("stockUtil.ts", "warpBody", post));
/**
 * A withSeconds shader of channelUtility.ts over the input and `seconds` second layers, each from its own source
 * (1, 2, ...), from its PREFIX_DECLS and PREFIX_BODY exports.
 */
const withSeconds = (name: string, seconds: number, prefix: string): FxShaderSource =>
  layerPass(
    name,
    seconds + 1,
    ref("channelUtility.ts", "secondsDecls", Array.from({ length: seconds }, (_, i) => i + 1), ref("channelUtility.ts", `${prefix}_DECLS`)),
    ref("channelUtility.ts", `${prefix}_BODY`),
  );
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
  stylize("strobe", 1, "STROBE"),
  stylize("threshold", 1, "THRESHOLD"),
  stylize("threshold_rgb", 1, "THRESHOLD_RGB"),
  layerPass("unpremultiplied", 1, "", ref("stylizeExtra.ts", "UNPREMULTIPLIED_BODY")),
  stylize("find_edges", 2, "FIND_EDGES"),
  stylize("emboss", 2, "EMBOSS"),
  stylize("repetile", 1, "REPETILE"),
  warp("kaleida", ref("stylizeExtra.ts", "KALEIDA_DECLS")),
  stylize("hextile", 1, "HEXTILE"),
  stylize("block_load", 1, "BLOCK_LOAD"),
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
  shader("grown", "fxextraUtil.ts", "GROWN_FS"),
  withSeconds("set_channels", 4, "SET_CHANNELS"),
  withSeconds("channel_combiner", 1, "CHANNEL_COMBINER"),
  shader("arithmetic", "channelUtility.ts", "ARITHMETIC_FS"),
  layerPass("compound_aligned", 1, ref("channelUtility.ts", "COMPOUND_ALIGNED_DECLS"), ref("channelUtility.ts", "COMPOUND_ALIGNED_BODY")),
  layerPass("compound_fade", 1, ref("channelUtility.ts", "COMPOUND_FADE_DECLS"), ref("channelUtility.ts", "COMPOUND_FADE_BODY")),
  shader("compound_raw", "channelUtility.ts", "COMPOUND_RAW_FS"),
  shader("min_max", "channelUtility.ts", "MINMAX_FS"),
  shader("compound", "channelUtility.ts", "COMPOUND_FS"),
  withSeconds("blend", 1, "BLEND"),
  withSeconds("calculations", 1, "CALCULATIONS"),
  shader("solid_composite", "channelUtility.ts", "SOLID_COMPOSITE_FS"),
  withSeconds("cc_composite", 1, "CC_COMPOSITE"),
  shader("cineon", "channelUtility.ts", "CINEON_FS"),
  shader("compander", "channelUtility.ts", "COMPANDER_FS"),
  shader("hdr_tonemap", "channelUtility.ts", "HDR_TONEMAP_FS"),
  program("capsule", "audioSpectrum.ts", "CAPSULE_VS", "CAPSULE_FS"),
  shader("spectrum_composite", "audioSpectrum.ts", "COMPOSITE_FS"),
];

async function value(arg: FxArg): Promise<unknown> {
  if (typeof arg !== "object") return arg;
  if (Array.isArray(arg)) return Promise.all(arg.map(value));
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

/** The GLSL ES source of an entry's vertex shader, or undefined for a fullscreen pass. */
export async function fxVertexSource(entry: FxShaderSource): Promise<string | undefined> {
  if (!entry.vertex) return undefined;
  const source = await value(entry.vertex);
  if (typeof source !== "string") throw new Error(`${describeFx(entry.vertex)} is not a shader`);
  return source;
}

/** The hash native/src/fx_shaders.inc records for an entry: of its fragment shader, and of its vertex shader before it when it has one. */
export async function fxEntryHash(entry: FxShaderSource): Promise<string> {
  const vertex = await fxVertexSource(entry);
  const source = await fxSource(entry);
  return fxHash(vertex === undefined ? source : `${vertex}\n// fragment\n${source}`);
}

/** Where a shader comes from, for the generated header: `module export(args)`. */
export function describeFx(arg: FxArg): string {
  if (typeof arg !== "object") return JSON.stringify(arg);
  if (Array.isArray(arg)) return `[${arg.map(describeFx).join(", ")}]`;
  const name = arg.module.replace(/^src\/render\/effects\//, "");
  return `${name} ${arg.export}${arg.args ? `(${arg.args.map(describeFx).join(", ")})` : ""}`;
}

/** SHA-256 of an effect shader's source, as native/src/fx_shaders.inc records it. */
export const fxHash = (source: string): string => createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
