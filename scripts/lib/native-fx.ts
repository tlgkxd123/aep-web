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
  args?: unknown[];
}

export const FX_SHADERS: FxShaderSource[] = [
  { name: "box_load", module: "src/render/effects/boxBlur.ts", export: "LOAD_FS" },
  { name: "box_level", module: "src/render/effects/boxBlur.ts", export: "LEVEL_FS" },
  { name: "box_accumulate", module: "src/render/effects/boxBlur.ts", export: "ACCUMULATE_FS" },
  { name: "box_finish", module: "src/render/effects/boxBlur.ts", export: "FINISH_FS" },
  { name: "box_store", module: "src/render/effects/boxBlur.ts", export: "STORE_FS" },
];

/** The GLSL ES source of an entry, as the TypeScript effect compiles it. */
export async function fxSource(entry: FxShaderSource): Promise<string> {
  const module = (await import(pathToFileURL(resolve(entry.module)).href)) as Record<string, unknown>;
  const value = module[entry.export];
  const source = typeof value === "function" ? (value as (...args: unknown[]) => unknown)(...(entry.args ?? [])) : value;
  if (typeof source !== "string") throw new Error(`${entry.module} does not export a shader as ${entry.export}`);
  return source;
}

/** SHA-256 of an effect shader's source, as native/src/fx_shaders.inc records it. */
export const fxHash = (source: string): string => createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
