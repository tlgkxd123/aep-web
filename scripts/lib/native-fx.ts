// The effect shaders the native engine embeds (native/src/fx_shaders.inc), taken from the TypeScript effects so both
// renderers run the same GLSL: each entry names a module of src/render/effects and the fragment shader it exports
// (a string, or a function called with `args` for shaders built per parameter). scripts/generate/native-shaders.ts
// converts them from WebGL2's GLSL ES to Vulkan GLSL; native/src/effects/*.cpp refer to them as fx::<name>.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface FxShaderSource {
  /** C++ identifier: fx::<name>. */
  name: string;
  /** Module under the repository root. */
  module: string;
  /** Export holding the shader source, or a function returning it. */
  export: string;
  /** Arguments of the function; `{ ref: "module#export" }` stands for another module's export. */
  args?: unknown[];
}

const STOCK = "src/render/effects/stockUtil.ts";
const ref = (module: string, name: string) => ({ ref: `src/render/effects/${module}#${name}` });
/** A layerPass shader (stockUtil.ts) over `count` sources, from a module's exported declarations and body. */
const layerPass = (name: string, count: number, module: string, decls: string, body: string): FxShaderSource => ({
  name,
  module: STOCK,
  export: "layerPassFragment",
  args: [count, ref(module, decls), ref(module, body)],
});

export const FX_SHADERS: FxShaderSource[] = [
  { name: "box_load", module: "src/render/effects/boxBlur.ts", export: "LOAD_FS" },
  { name: "box_level", module: "src/render/effects/boxBlur.ts", export: "LEVEL_FS" },
  { name: "box_accumulate", module: "src/render/effects/boxBlur.ts", export: "ACCUMULATE_FS" },
  { name: "box_finish", module: "src/render/effects/boxBlur.ts", export: "FINISH_FS" },
  { name: "box_store", module: "src/render/effects/boxBlur.ts", export: "STORE_FS" },
  { name: "glow_input", module: "src/render/effects/deepGlow.ts", export: "INPUT_FS" },
  { name: "glow_down", module: "src/render/effects/deepGlow.ts", export: "DOWN_FS" },
  { name: "glow_blur", module: "src/render/effects/deepGlow.ts", export: "BLUR_FS" },
  { name: "glow_accumulate", module: "src/render/effects/deepGlow.ts", export: "ACCUMULATE_FS" },
  { name: "glow_composite", module: "src/render/effects/deepGlow.ts", export: "COMPOSITE_FS" },
  layerPass("strobe", 1, "stylizeExtra.ts", "STROBE_DECLS", "STROBE_BODY"),
];

async function load(module: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(resolve(module)).href)) as Record<string, unknown>;
}

/** The GLSL ES source of an entry, as the TypeScript effect compiles it. */
export async function fxSource(entry: FxShaderSource): Promise<string> {
  const value = (await load(entry.module))[entry.export];
  const args: unknown[] = [];
  for (const arg of entry.args ?? []) {
    if (!arg || typeof arg !== "object" || !("ref" in arg)) {
      args.push(arg);
      continue;
    }
    const [module, name] = String(arg.ref).split("#");
    const resolved = (await load(module))[name];
    if (resolved === undefined) throw new Error(`${module} does not export ${name}`);
    args.push(resolved);
  }
  const source = typeof value === "function" ? (value as (...args: unknown[]) => unknown)(...args) : value;
  if (typeof source !== "string") throw new Error(`${entry.module} does not export a shader as ${entry.export}`);
  return source;
}

/** SHA-256 of an effect shader's source, as native/src/fx_shaders.inc records it. */
export const fxHash = (source: string): string => createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
