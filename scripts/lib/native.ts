// Paths and helpers shared by the native engine's scripts (native-shaders.ts, native-report.ts) and its tests.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const NATIVE_DIR = resolve("native");
export const SHADER_DIR = join(NATIVE_DIR, "shaders");
export const SHADER_HEADER = join(NATIVE_DIR, "src", "shaders.inc");

/** The C++ array a shader's SPIR-V is embedded as: layer.vert -> kShader_layer_vert. */
export const shaderSymbol = (file: string): string => `kShader_${file.replace(/\W/g, "_")}`;

/** SHA-256 of a shader source with line endings normalized, as the generated header records it. */
export function shaderHash(file: string): string {
  return createHash("sha256")
    .update(readFileSync(join(SHADER_DIR, file), "utf8").replace(/\r\n/g, "\n"))
    .digest("hex");
}

/** The headless renderer built by CMake (native/build by default), or undefined when it has not been built. */
export function findRenderTool(given?: string): string | undefined {
  const exe = process.platform === "win32" ? "aevk-render.exe" : "aevk-render";
  const candidates = given ? [given] : [join(NATIVE_DIR, "build", exe), join(NATIVE_DIR, "build", "Release", exe), join(NATIVE_DIR, "build", "Debug", exe)];
  return candidates.find((c) => existsSync(c));
}
