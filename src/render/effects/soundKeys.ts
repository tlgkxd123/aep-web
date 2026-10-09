// Sound Keys (Trapcode) turns audio levels into keyframes; on the layer it is
// applied to, After Effects renders the plugin's own display instead of the layer,
// on transparency. This draws that display live: the Audio Layer's spectrum at the
// current time on the same calibrated axes the Apply analysis uses (src/media/
// soundKeys.ts), the boxes of the active ranges, and one bar per Output showing
// its current value within its output range. The text labels are left out.
import type { CompItem, Layer, Project, PropertyGroup } from "../../aep/model.ts";
import { layerAudio, mixWindow } from "../../media/mix.ts";
import { displayLayout, displaySpectrum, soundKeysSettings } from "../../media/soundKeys.ts";
import { effectNumber } from "../effectParams.ts";
import type { GL } from "../gl.ts";
import { registerEffect } from "../registry.ts";

const DISPLAY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_spectrum;
uniform vec2 u_size;      // padded target size
uniform float u_pad;
uniform vec2 u_image;     // display (layer) size
uniform vec4 u_frame;     // left, right, top, bottom
uniform float u_zero;
uniform int u_hasSpectrum;
uniform vec4 u_box[3];    // x0, y0, x1, y1
uniform int u_boxes;
uniform vec3 u_bars;      // output levels 0..1
uniform float u_barWidth;

vec4 over(vec4 top, vec4 below) { return top + below * (1.0 - top.a); }

void main() {
  vec2 p = vec2(v_uv.x * u_size.x - u_pad, (1.0 - v_uv.y) * u_size.y - u_pad);
  if (p.x < 0.0 || p.y < 0.0 || p.x >= u_image.x || p.y >= u_image.y) { outColor = vec4(0.0); return; }
  vec4 c = vec4(0.0);
  float left = u_frame.x, right = u_frame.y, top = u_frame.z, bottom = u_frame.w;
  bool inFrame = p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
  // Frame and zero line.
  if (inFrame && (p.y < top + 1.0 || p.y > bottom - 1.0 || abs(p.y - u_zero) < 0.5)) c = vec4(0.0, 0.0, 1.0, 1.0);
  if (p.y >= top && p.y <= bottom && (p.x < left + 1.0 && p.x >= left || p.x > right - 1.0 && p.x <= right)) c = vec4(0.0, 0.0, 1.0, 1.0);
  // Spectrum: filled from its level down to the zero line, brighter at the top.
  if (u_hasSpectrum == 1 && inFrame) {
    float level = texelFetch(u_spectrum, ivec2(int(p.x), 0), 0).r;
    if (!isnan(level)) {
      float y = clamp(level, top, bottom);
      if (p.y >= y && p.y <= max(u_zero, y)) c = over(p.y < y + 2.0 ? vec4(0.55, 0.8, 1.0, 1.0) : vec4(0.12, 0.35, 0.95, 0.85), c);
    }
  }
  // Range boxes.
  for (int i = 0; i < 3; i++) {
    if (i >= u_boxes) break;
    vec4 b = u_box[i];
    bool inside = p.x >= b.x - 1.0 && p.x <= b.z + 1.0 && p.y >= b.y - 1.0 && p.y <= b.w + 1.0;
    bool edge = inside && (p.x < b.x + 1.0 || p.x > b.z - 1.0 || p.y < b.y + 1.0 || p.y > b.w - 1.0);
    if (edge) c = vec4(1.0, 0.85, 0.1, 1.0);
  }
  // Output bars at 80%, 85%, 90% of the width, rising from the frame's bottom.
  for (int i = 0; i < 3; i++) {
    float x0 = floor(u_image.x * (0.8 + 0.05 * float(i)));
    if (p.x >= x0 && p.x < x0 + u_barWidth && p.y >= top && p.y <= bottom) {
      float fill = bottom - (bottom - top) * clamp(u_bars[i], 0.0, 1.0);
      c = over(p.y >= fill ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(0.0, 0.25, 0.0, 0.6), c);
    }
  }
  outColor = c;
}`;

const textures = new WeakMap<GL, WebGLTexture>();
function spectrumTexture(gl: GL, columns: Float32Array): WebGLTexture {
  let texture = textures.get(gl);
  if (!texture) {
    texture = gl.createTexture()!;
    textures.set(gl, texture);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, columns.length, 1, 0, gl.RED, gl.FLOAT, columns);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}

const compOfLayer = new WeakMap<Layer, CompItem>();
function compOf(project: Project, layer: Layer): CompItem | undefined {
  let comp = compOfLayer.get(layer);
  if (comp) return comp;
  for (const item of project.items.values()) if (item.kind === "comp" && item.layers.includes(layer)) comp = item;
  if (comp) compOfLayer.set(layer, comp);
  return comp;
}

registerEffect("tc Sound Keys", (input, effect: PropertyGroup, layer, time, ctx) => {
  const { width, height } = input;
  const settings = soundKeysSettings(effect, layer, time, width, height);
  const layout = displayLayout(width, height);
  const comp = compOf(ctx.project, layer);
  const audioLayer = comp?.layers.find((l) => l.index === settings.audioLayer);
  let columns: Float32Array | undefined;
  if (audioLayer) {
    const audio = layerAudio(ctx.project, audioLayer, time);
    if (audio === "pending") ctx.loading(`audio is loading ("${audioLayer.name}")`);
    else if (audio) {
      const rate = audio.rate * audio.timeScale;
      columns = displaySpectrum(settings, rate, (first, length) => mixWindow(audio, first, length, settings.channel), time);
    }
  }
  const bars = settings.ranges.map((r) => {
    const value = effectNumber(effect, r.output, layer, time, r.min);
    return r.max !== r.min ? (value - r.min) / (r.max - r.min) : 0;
  });
  // Integrating outputs grow without bound; show their fractional part.
  const levels = [0, 1, 2].map((i) => {
    const r = settings.ranges[i];
    const v = bars[i] ?? 0;
    return r && r.falloff === 4 ? v - Math.floor(v) : v;
  });

  const gl = ctx.gl;
  const pad = ctx.pad;
  const out = ctx.pool.acquire(width + 2 * pad, height + 2 * pad);
  const texture = spectrumTexture(gl, columns ?? new Float32Array(1).fill(Number.NaN));
  ctx.pass(ctx.program(DISPLAY_FS), out, [], (u) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(u("u_spectrum"), 0);
    gl.uniform2f(u("u_size"), out.width, out.height);
    gl.uniform1f(u("u_pad"), pad);
    gl.uniform2f(u("u_image"), width, height);
    gl.uniform4f(u("u_frame"), layout.left, layout.right, layout.top, layout.bottom);
    gl.uniform1f(u("u_zero"), layout.zero);
    gl.uniform1i(u("u_hasSpectrum"), columns ? 1 : 0);
    const boxes = new Float32Array(12);
    settings.ranges.slice(0, 3).forEach((r, i) => boxes.set([r.x0, r.yTop, r.x1, r.yBottom], i * 4));
    gl.uniform4fv(u("u_box[0]"), boxes);
    gl.uniform1i(u("u_boxes"), Math.min(3, settings.ranges.length));
    gl.uniform3f(u("u_bars"), levels[0], levels[1], levels[2]);
    gl.uniform1f(u("u_barWidth"), Math.max(1, Math.round(width / 53)));
  });
  ctx.pool.release(input.target);
  return { ...input, target: out };
});
