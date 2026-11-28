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
/** A keying.ts keyShader of its PREFIX_DECLS and PREFIX_BODY exports. */
const key = (name: string, prefix: string): FxShaderSource => ({ name, source: ref("keying.ts", "keyShader", ref("keying.ts", `${prefix}_DECLS`), ref("keying.ts", `${prefix}_BODY`)) });
/** A warp shader (stockUtil.ts warp()): `decls` declares `vec2 map(vec2 p)`. */
const warp = (name: string, decls: FxArg, post: FxArg = ""): FxShaderSource => layerPass(name, 1, decls, ref("stockUtil.ts", "warpBody", post));
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

/**
 * A keepMatte effect of transitionsExtra.ts from its keep() export: the pass that keeps the layer where keep() says
 * (<name>_keep) and, for effects that feather, the matte that is blurred first (<name>_matte).
 */
const keep = (name: string, exported: string, feathers: boolean): FxShaderSource[] => [
  layerPass(`${name}_keep`, 1, ref("transitionsExtra.ts", exported), ref("transitionsExtra.ts", "KEEP_BODY")),
  ...(feathers ? [{ name: `${name}_matte`, source: ref("transitionsExtra.ts", "keepMatteFragment", ref("transitionsExtra.ts", exported)) }] : []),
];
/** A layerPass transition of transitionsExtra.ts from its PREFIX_DECLS and PREFIX_BODY exports. */
const transition = (name: string, count: number, prefix: string): FxShaderSource =>
  layerPass(name, count, ref("transitionsExtra.ts", `${prefix}_DECLS`), ref("transitionsExtra.ts", `${prefix}_BODY`));

/** A colorPass shader (stockUtil.ts colorFragment) of colorCorrection.ts's `exported` adjust(). */
const color = (name: string, exported: string): FxShaderSource => ({ name, source: ref("stockUtil.ts", "colorFragment", ref("colorCorrection.ts", exported)) });
/** A straightPass shader (colorExtra.ts straightFragment) of colorExtra.ts's `exported` adjust(). */
const straight = (name: string, exported: string): FxShaderSource => ({ name, source: ref("colorExtra.ts", "straightFragment", ref("colorExtra.ts", exported)) });

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
  shader("copy", "fxextraUtil.ts", "COPY_FS"),
  layerPass("channel_blur_mix", 2, ref("blurNoise.ts", "CHANNEL_BLUR_MIX_DECLS"), ref("blurNoise.ts", "CHANNEL_BLUR_MIX_BODY")),
  layerPass("channel_blur_colour", 2, "", ref("blurNoise.ts", "CHANNEL_BLUR_COLOUR_BODY")),
  layerPass("channel_blur_compose", 4, "", ref("blurNoise.ts", "channelBlurComposeBody", 4, [0, 1, 2])),
  layerPass("cross_blur", 2, ref("blurNoise.ts", "CROSS_BLUR_DECLS"), ref("blurNoise.ts", "CROSS_BLUR_BODY")),
  shader("keep_feather", "transitionsExtra.ts", "FEATHER_FS"),
  layerPass("keep_apply", 2, "", ref("transitionsExtra.ts", "MATTE_APPLY_BODY")),
  ...keep("jaws", "JAWS_KEEP", false),
  ...keep("iris", "IRIS_KEEP", true),
  ...keep("block_dissolve", "BLOCK_DISSOLVE_KEEP", true),
  transition("gradient_wipe", 2, "GRADIENT_WIPE"),
  transition("image_wipe", 2, "IMAGE_WIPE"),
  transition("scale_wipe", 1, "SCALE_WIPE"),
  transition("radial_scale_wipe", 1, "RADIAL_SCALE_WIPE"),
  transition("light_wipe", 1, "LIGHT_WIPE"),
  transition("line_sweep", 1, "LINE_SWEEP"),
  color("tint", "TINT_GLSL"),
  color("tritone", "TRITONE_GLSL"),
  color("brightness_contrast", "BRIGHTNESS_CONTRAST"),
  color("exposure", "EXPOSURE_GLSL"),
  color("hue_saturation", "HUE_SATURATION_GLSL"),
  color("vibrance", "VIBRANCE_GLSL"),
  color("color_balance_hls", "COLOR_BALANCE_HLS_GLSL"),
  color("channel_mixer", "CHANNEL_MIXER_GLSL"),
  color("black_white", "BLACK_WHITE_GLSL"),
  color("posterize", "POSTERIZE_GLSL"),
  shader("levels", "colorCorrection.ts", "LEVELS_FS"),
  shader("invert", "colorCorrection.ts", "INVERT_FS"),
  shader("shift_channels", "colorCorrection.ts", "SHIFT_FS"),
  straight("pro_levels", "PRO_LEVELS_GLSL"),
  straight("toner", "TONER_GLSL"),
  straight("color_offset", "COLOR_OFFSET_GLSL"),
  straight("gamma_pedestal_gain", "GAMMA_PEDESTAL_GAIN_GLSL"),
  straight("color_balance", "COLOR_BALANCE_GLSL"),
  straight("neutralizer", "NEUTRALIZER_GLSL"),
  straight("photo_filter", "PHOTO_FILTER_GLSL"),
  straight("selective_color", "SELECTIVE_COLOR_GLSL"),
  straight("leave_color", "LEAVE_COLOR_GLSL"),
  straight("change_color", "CHANGE_COLOR_GLSL"),
  straight("change_to_color", "CHANGE_TO_COLOR_GLSL"),
  shader("kernel", "colorExtra.ts", "KERNEL_FS"),
  layerPass("reframe", 1, "", "  outColor = at(0, p);"),
  shader("gauss", "stockUtil.ts", "GAUSS_FS"),
  shader("paired_gauss", "stockUtil.ts", "PAIRED_GAUSS_FS"),
  shader("gauss_reduce", "stockUtil.ts", "REDUCE_FS"),
  shader("gauss_expand", "stockUtil.ts", "EXPAND_FS"),
  shader("directional_blur", "blurSharpen.ts", "DIRECTIONAL_FS"),
  layerPass("radial_blur", 1, ref("blurSharpen.ts", "RADIAL_BLUR_DECLS"), ref("blurSharpen.ts", "RADIAL_BLUR_BODY")),
  shader("sharpen", "blurSharpen.ts", "SHARPEN_FS"),
  shader("unsharp", "blurSharpen.ts", "UNSHARP_FS"),
  layerPass("drop_shadow", 1, ref("stylize.ts", "DROP_SHADOW_DECLS"), ref("stylize.ts", "DROP_SHADOW_BODY")),
  layerPass("drop_shadow_composite", 2, "uniform int u_only;", ref("stylize.ts", "DROP_SHADOW_COMPOSITE_BODY")),
  layerPass("stock_glow_bright", 1, ref("stylize.ts", "GLOW_BRIGHT_DECLS"), ref("stylize.ts", "GLOW_BRIGHT_BODY")),
  layerPass("stock_glow_composite", 2, ref("stylize.ts", "GLOW_COMPOSITE_DECLS"), ref("stylize.ts", "GLOW_COMPOSITE_BODY")),
  layerPass("linear_wipe", 1, ref("transitions.ts", "LINEAR_WIPE_DECLS"), ref("transitions.ts", "LINEAR_WIPE_BODY")),
  layerPass("radial_wipe", 1, ref("transitions.ts", "RADIAL_WIPE_DECLS"), ref("transitions.ts", "RADIAL_WIPE_BODY")),
  layerPass("venetian_blinds", 1, ref("transitions.ts", "VENETIAN_DECLS"), ref("transitions.ts", "VENETIAN_BODY")),
  layerPass("blank", 0, "", "  outColor = vec4(0.0);"),
  warp("geometry", ref("distort.ts", "GEOMETRY_DECLS"), ref("distort.ts", "GEOMETRY_POST")),
  layerPass("offset", 1, ref("distort.ts", "OFFSET_DECLS"), ref("distort.ts", "OFFSET_BODY")),
  warp("corner_pin", ref("distort.ts", "CORNER_PIN_DECLS")),
  warp("motion_tile", ref("distort.ts", "MOTION_TILE_DECLS")),
  key("key_linear", "LINEAR_KEY"),
  key("key_color", "COLOR_KEY"),
  key("key_luma", "LUMA_KEY"),
  key("key_extract", "EXTRACT"),
  key("key_range", "COLOR_RANGE"),
  key("key_spill", "SPILL"),
  key("key_spill2", "SPILL2"),
  { name: "key_alpha", source: ref("keying.ts", "keyShader", "", "") },
  shader("key_feather", "keying.ts", "FEATHER_FS"),
  shader("key_morph", "keying.ts", "MORPH_FS"),
  shader("key_combine", "keying.ts", "COMBINE_FS"),
  shader("key_level", "keying.ts", "LEVEL_FS"),
  warp("spherize", ref("distortExtra.ts", "SPHERIZE_DECLS")),
  warp("ripple", ref("distortExtra.ts", "RIPPLE_DECLS")),
  layerPass("magnify", 1, ref("distortExtra.ts", "MAGNIFY_DECLS"), ref("distortExtra.ts", "MAGNIFY_BODY")),
  warp("cc_lens", ref("distortExtra.ts", "LENS_DECLS"), ref("distortExtra.ts", "LENS_POST")),
  layerPass("cc_slant", 1, ref("distortExtra.ts", "SLANT_DECLS"), ref("distortExtra.ts", "SLANT_BODY")),
  layerPass("cc_tiler_average", 1, ref("distortExtra.ts", "TILER_AVERAGE_DECLS"), ref("distortExtra.ts", "TILER_AVERAGE_BODY")),
  layerPass("cc_tiler", 2, ref("distortExtra.ts", "TILER_DECLS"), ref("distortExtra.ts", "TILER_BODY")),
  warp("cc_split", ref("distortExtra.ts", "SPLIT_DECLS"), ref("distortExtra.ts", "SPLIT_POST")),
  layerPass("cc_bender", 1, ref("distortExtra.ts", "BENDER_DECLS"), ref("distortExtra.ts", "BENDER_BODY")),
  warp("bezier_warp", ref("distortExtra.ts", "BEZMESH_DECLS")),
  warp("wave_warp", ref("displace.ts", "WAVE_WARP_DECLS")),
  warp("bulge", ref("displace.ts", "BULGE_DECLS")),
  warp("twirl", ref("displace.ts", "TWIRL_DECLS")),
  warp("optics_compensation", ref("displace.ts", "OPTICS_DECLS")),
  layerPass("cc_power_pin", 1, ref("distortExtra.ts", "POWER_PIN_DECLS"), ref("distortExtra.ts", "POWER_PIN_BODY")),
  layerPass("camera_lens", 1, ref("blurNoise.ts", "CAMERA_LENS_DECLS"), ref("blurNoise.ts", "CAMERA_LENS_BODY")),
  layerPass("bilateral", 1, ref("blurNoise.ts", "BILATERAL_DECLS"), ref("blurNoise.ts", "BILATERAL_BODY")),
  layerPass("smart_blur", 1, ref("blurNoise.ts", "SMART_BLUR_DECLS"), ref("blurNoise.ts", "SMART_BLUR_BODY")),
  layerPass("radial_pass", 1, ref("blurNoise.ts", "RADIAL_PASS_DECLS"), ref("blurNoise.ts", "RADIAL_PASS_BODY")),
  layerPass("noise_hls", 1, ref("blurNoise.ts", "NOISE_HLS_DECLS"), ref("blurNoise.ts", "NOISE_HLS_BODY")),
  shader("median_step", "blurNoise.ts", "MEDIAN_STEP_FS"),
  shader("median_store", "blurNoise.ts", "MEDIAN_STORE_FS"),
  shader("cs_vignette", "vignette.ts", "VIGNETTE_FS"),
  shader("minimax_unpremultiply", "minimax.ts", "UNPREMULTIPLY_FS"),
  shader("minimax_premultiply", "minimax.ts", "PREMULTIPLY_FS"),
  shader("minimax", "minimax.ts", "MINMAX_FS"),
  layerPass("mosaic", 1, ref("stylize.ts", "MOSAIC_DECLS"), ref("stylize.ts", "MOSAIC_BODY")),
  layerPass("noise", 1, ref("stylize.ts", "NOISE_DECLS"), ref("stylize.ts", "NOISE_BODY")),
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
