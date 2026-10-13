// Compiles every Avee shader the exporter writes for an After Effects effect (src/viz/shaders.ts) as WebGL 1, which
// is GLSL ES 1.00 as Avee Player's GLES2 runs it, in headless Edge; draws each over a test image (a colour gradient
// with an alpha ramp) and checks it links, gives finite colours and changes the image (for the settings that do):
//
//   node scripts/check-viz-shaders.ts [--chrome <path>]
//
// Prints VIZ-SHADERS-PASSED when every one does.
import { chromium } from "playwright-core";
import { effectShader, SHADER_VERTEX, type EffectReader } from "../src/viz/shaders.ts";

const args = process.argv.slice(2);
const chromeAt = args.indexOf("--chrome");
const executablePath = chromeAt >= 0 ? args[chromeAt + 1] : undefined;
const SIZE = [64, 36];

/** Each effect with its settings (parameter number → value), one case per branch the settings choose. */
const CASES: [string, Record<number, number | number[]>][] = [
  ["ADBE Tint", { 1: [0.1, 0, 0.3], 2: [1, 0.9, 0.2], 3: 80 }],
  ["ADBE Tritone", { 4: 10 }],
  ["ADBE Brightness & Contrast 2", { 1: 40, 2: 30 }],
  ["ADBE Brightness & Contrast 2", { 1: -20, 2: -40, 3: 1 }],
  ["ADBE Exposure2", { 3: 1 }],
  ["ADBE Exposure2", { 3: -1, 22: 1 }],
  ["ADBE HUE SATURATION", { 4: 90, 5: 30, 6: 10 }],
  ["ADBE HUE SATURATION", { 7: 1, 8: 200, 9: 60 }],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 13].map((channel) => ["ADBE Invert", { 1: channel }] as [string, Record<number, number>]),
  ["ADBE Posterize", { 1: 3 }],
  ["ADBE Threshold2", { 1: 100 }],
  ["ADBE Fill", { 2: [0, 1, 0], 5: 1 }],
  ["ADBE Black&White", {}],
  ["ADBE Black&White", { 7: 1 }],
  ["ADBE Easy Levels2", { 1: 1, 3: 0.2, 4: 0.8, 5: 1.4 }],
  ["ADBE Easy Levels2", { 1: 2, 3: 0.3 }],
  ["ADBE Ramp", { 1: [0, 0], 3: [64, 36], 2: [1, 0, 0], 4: [0, 0, 1] }],
  ["ADBE Ramp", { 1: [32, 18], 3: [64, 36], 5: 2 }],
  ["ADBE Offset", { 1: [10, 30] }],
  ["ADBE Mosaic", { 1: 8, 2: 4 }],
  ["ADBE Mosaic", { 1: 8, 2: 4, 3: 1 }],
  ["ADBE Polar Coordinates", { 1: 1, 2: 1 }],
  ["ADBE Polar Coordinates", { 1: 1, 2: 2 }],
  ["ADBE Motion Blur", { 1: 45, 2: 20 }],
  ["ADBE Glo2", { 2: 60, 3: 12, 4: 2 }],
  ["ADBE Glo2", { 2: 60, 3: 12, 5: 1 }],
  ["ADBE Glo2", { 2: 60, 3: 12, 5: 3 }],
  ["ADBE Glo2", { 2: 60, 3: 12, 6: 6, 1: 1 }],
  ["ADBE Drop Shadow", { 4: 6, 5: 8 }],
  ["ADBE Drop Shadow", { 4: 6, 6: 1 }],
  ["ADBE Sharpen", { 1: 80 }],
];

const reader = (settings: Record<number, number | number[]>): EffectReader => ({
  scale: 1,
  num: (n, fallback) => (typeof settings[n] === "number" ? (settings[n] as number) : fallback),
  rgb: (n, fallback) => (Array.isArray(settings[n]) ? (settings[n] as number[]) : fallback),
  point: (n, fallback) => (Array.isArray(settings[n]) ? (settings[n] as number[]) : fallback),
});

const shaders = CASES.map(([matchName, settings]) => {
  const shader = effectShader(matchName, reader(settings), SIZE);
  if (!shader) throw new Error(`${matchName} gives no shader`);
  return { name: `${matchName} ${JSON.stringify(settings)}`, ...shader };
});

const browser = await chromium.launch({ channel: executablePath ? undefined : "msedge", executablePath, headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
const results = (await page.evaluate(
  ({ shaders, vertex, size }) => {
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = size;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, preserveDrawingBuffer: true })!;
    // The test image: premultiplied colour gradient with alpha falling from left to right.
    const [w, h] = size;
    const pixels = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = 1 - (x / w) * 0.6;
        const i = (y * w + x) * 4;
        pixels.set([Math.round((x / w) * 255 * a), Math.round((y / h) * 255 * a), Math.round(128 * a), Math.round(a * 255)], i);
      }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // A quad over the canvas: Position in clip space with u_projView the identity, TexCoord 0–1, Color white.
    const quad = new Float32Array([-1, -1, 0, 0, 0, 1, 1, 1, 1, 1, -1, 0, 1, 0, 1, 1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return { shader, log: gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? "" : gl.getShaderInfoLog(shader) ?? "compile failed" };
    };
    const vs = compile(gl.VERTEX_SHADER, vertex);
    return shaders.map((s) => {
      if (vs.log) return { name: s.name, error: `vertex: ${vs.log}` };
      const fs = compile(gl.FRAGMENT_SHADER, s.fragment);
      if (fs.log) return { name: s.name, error: `fragment: ${fs.log}` };
      const program = gl.createProgram()!;
      gl.attachShader(program, vs.shader);
      gl.attachShader(program, fs.shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return { name: s.name, error: `link: ${gl.getProgramInfoLog(program)}` };
      gl.useProgram(program);
      const stride = 9 * 4;
      for (const [name, size, offset] of [["Position", 3, 0], ["TexCoord", 2, 12], ["Color", 4, 20]] as const) {
        const at = gl.getAttribLocation(program, name);
        if (at < 0) continue;
        gl.enableVertexAttribArray(at);
        gl.vertexAttribPointer(at, size, gl.FLOAT, false, stride, offset);
      }
      gl.uniformMatrix4fv(gl.getUniformLocation(program, "u_projView"), false, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      gl.uniform1i(gl.getUniformLocation(program, "u_texture"), 0);
      const declared = [...s.fragment.matchAll(/uniform float (\w+);/g)].map((m) => m[1]);
      const given = new Set(s.variables.map(([name]) => name));
      const missing = declared.filter((name) => !given.has(name));
      if (missing.length) return { name: s.name, error: `uniforms without a variable: ${missing.join(", ")}` };
      for (const [name, value] of s.variables) gl.uniform1f(gl.getUniformLocation(program, name), value);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      const out = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
      const glError = gl.getError();
      if (glError) return { name: s.name, error: `GL error ${glError}` };
      let changed = 0;
      let lit = 0;
      for (let i = 0; i < out.length; i++) {
        if (Math.abs(out[i] - pixels[i]) > 2) changed++;
        if (out[i]) lit++;
      }
      return { name: s.name, changed, lit };
    });
  },
  { shaders: shaders.map(({ name, fragment, variables }) => ({ name, fragment, variables })), vertex: SHADER_VERTEX, size: SIZE },
)) as { name: string; error?: string; changed?: number; lit?: number }[];
await browser.close();

let failed = 0;
for (const r of results) {
  const ok = !r.error && (r.changed ?? 0) > 0 && (r.lit ?? 0) > 0;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${r.name}${r.error ? `: ${r.error}` : `: ${r.changed} channel values changed`}`);
}
if (failed) process.exit(1);
console.log("VIZ-SHADERS-PASSED");
