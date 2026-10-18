// Runs one WebGL2 feature the renderer's blurs use inside the Android app's WebView (the debug APK running on an
// emulator or a device), to tell which one a GPU driver mishandles:
//
//   node scripts/android-gl-probe.ts half-float|uniform-array
//
// half-float renders into a linearly filtered RGBA16F target and reads it back through an RGBA8 one; uniform-array
// draws with a vec2 uniform array and a loop bounded by a uniform. Prints PROBE-OK with what it read back.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright-core";

const which = process.argv[2];
const PKG = "com.zionschxma.aev3";
const adbPath = join(process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? "", "Android/Sdk"), "platform-tools/adb");
const adb = (...a: string[]) => execFileSync(adbPath, a, { encoding: "utf8" });
adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
let socket = "";
for (let i = 0; i < 80 && !socket; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const pid = (() => {
    try {
      return adb("shell", "pidof", PKG).trim();
    } catch {
      return "";
    }
  })();
  if (pid && adb("shell", "cat", "/proc/net/unix").includes(`@webview_devtools_remote_${pid}`)) socket = `webview_devtools_remote_${pid}`;
}
if (!socket) throw new Error("no DevTools socket");
adb("forward", "tcp:9335", `localabstract:${socket}`);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9335");
const page = browser.contexts()[0].pages()[0];
const result = await page.evaluate((kind) => {
  const gl = new OffscreenCanvas(4, 4).getContext("webgl2")!;
  const program = (fs: string) => {
    const vs = `#version 300 es
layout(location = 0) in vec2 a; out vec2 v_uv; void main() { v_uv = a; gl_Position = vec4(a * 2.0 - 1.0, 0.0, 1.0); }`;
    const p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "compile");
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, "a");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    return p;
  };
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const target = (internal: number, format: number, type: number, w: number, h: number) => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, fb, status: gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE };
  };
  const out = target(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 4, 4);
  const read = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
    const px = new Uint8Array(4);
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [...px];
  };
  if (kind === "half-float") {
    const ext = !!gl.getExtension("EXT_color_buffer_float");
    const half = target(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, 8, 8);
    gl.viewport(0, 0, 8, 8);
    gl.useProgram(program(`#version 300 es
precision highp float; out vec4 o; void main() { o = vec4(0.25, 0.5, 0.75, 1.0); }`));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
    gl.viewport(0, 0, 4, 4);
    gl.bindTexture(gl.TEXTURE_2D, half.t);
    gl.useProgram(program(`#version 300 es
precision highp float; uniform sampler2D s; in vec2 v_uv; out vec4 o; void main() { o = texture(s, v_uv); }`));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return { ext, complete: half.status, pixel: read() };
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
  gl.viewport(0, 0, 4, 4);
  const p = program(`#version 300 es
precision highp float; uniform int n; uniform vec2 k[40]; out vec4 o;
void main() { float s = 0.0; for (int i = 0; i < n; i++) s += k[i].x * k[i].y; o = vec4(s, 0.0, 0.0, 1.0); }`);
  gl.useProgram(p);
  gl.uniform1i(gl.getUniformLocation(p, "n"), 3);
  gl.uniform2fv(gl.getUniformLocation(p, "k"), new Float32Array([0.5, 0.5, 0.25, 1, 0.25, 0]));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return { pixel: read() };
}, which);
console.log(JSON.stringify(result));
console.log("PROBE-OK");
await browser.close();
