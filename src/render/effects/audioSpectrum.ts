// Audio Spectrum (ADBE AudSpect), fitted to After Effects renders.
//
// The spectrum of the Audio Layer's sound (audioSpectrumAnalysis.ts) is drawn
// along a path of the effect's layer: the Start/End line, a mask (band k of N
// at k/(N−1) of an open path, k/N of a closed one), or the polar path (rays
// from the Start Point over a half turn, mirrored about the horizontal). Each band reaches
// HEIGHT_SCALE · Maximum Height · magnitude to Side A (left of the path's
// direction), Side B, or both. Every band is a capsule of width Thickness whose
// opacity falls off linearly over a ramp set by Softness, centred on the
// capsule edge, with the colour running from Inside Color on its axis to
// Outside Color at its edge, hue-turned per band by Hue Interpolation. Analog
// lines join the band tips, analog dots mark them. Overlapping capsules keep
// the strongest (a MAX blend), or with Blend Overlapping Colors each band is
// composited over the later ones.
//
// All capsules go to the GPU as one instanced draw; the spectrum is computed
// on the CPU per frame and cached by audio, time and settings.
import { currentValue } from "../../aep/evaluate.ts";
import { isShapeValue, type CompItem, type Layer, type Project, type PropertyGroup, type Shape } from "../../aep/model.ts";
import { layerAudio, mixWindow, type LayerAudio } from "../../media/mix.ts";
import { effectNumber, effectProperty, effectVector } from "../effectParams.ts";
import { compile, type GL } from "../gl.ts";
import { registerEffect, type RenderContext } from "../registry.ts";
import { analyse, analyseAveraged, windowLength, windowStart, type SpectrumSettings } from "./audioSpectrumAnalysis.ts";

/** Bar height per unit of Maximum Height and of magnitude. */
export const HEIGHT_SCALE = 0.535;

const Display = { DIGITAL: 1, LINES: 2, DOTS: 3 } as const;
const Side = { A: 1, B: 2, BOTH: 3 } as const;

/** Width of the opacity ramp across a capsule edge. */
export function rampWidth(thickness: number, softness: number): number {
  return 1 + softness * Math.max(0, thickness - 1);
}

/**
 * The colour runs Inside → Outside over max(Thickness / 2, this) from the axis;
 * thinner strokes start part-way, by half the difference: t = (d + (R − T/2) / 2) / R.
 */
const MIN_COLOR_RADIUS = 2;

// One instance per capsule: segment a -> b in layer pixels (y down, pixel
// centres at integers) and its Inside and Outside colours, drawn as a quad
// covering its reach.
const INSTANCE_FLOATS = 10;
const CAPSULE_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_segment;
layout(location = 2) in vec3 a_inside;
layout(location = 3) in vec3 a_outside;
uniform vec2 u_size;
uniform float u_pad;
uniform float u_reach;
flat out vec4 v_segment;
flat out vec3 v_inside;
flat out vec3 v_outside;
void main() {
  v_inside = a_inside;
  v_outside = a_outside;
  vec2 a = a_segment.xy;
  vec2 b = a_segment.zw;
  float len = length(b - a);
  vec2 u = len > 1e-6 ? (b - a) / len : vec2(1.0, 0.0);
  vec2 v = vec2(-u.y, u.x);
  vec2 p = a + u * mix(-u_reach, len + u_reach, a_corner.x) + v * ((a_corner.y * 2.0 - 1.0) * u_reach);
  v_segment = a_segment;
  vec2 framebuffer = vec2(p.x + u_pad + 0.5, u_size.y - (p.y + u_pad + 0.5));
  gl_Position = vec4(framebuffer / u_size * 2.0 - 1.0, 0.0, 1.0);
}`;

const CAPSULE_FS = `#version 300 es
precision highp float;
uniform vec2 u_size;
uniform float u_pad;
uniform float u_edge;
uniform float u_ramp;
uniform float u_colorRadius;
uniform float u_colorShift;
flat in vec4 v_segment;
flat in vec3 v_inside;
flat in vec3 v_outside;
out vec4 outColor;
void main() {
  vec2 p = vec2(gl_FragCoord.x - u_pad - 0.5, u_size.y - gl_FragCoord.y - u_pad - 0.5);
  vec2 a = v_segment.xy;
  vec2 ab = v_segment.zw - a;
  float along = dot(ab, ab) > 0.0 ? clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0) : 0.0;
  float d = distance(p, a + along * ab);
  float alpha = clamp((u_edge - d) / u_ramp + 0.5, 0.0, 1.0);
  if (alpha <= 0.0) discard;
  float t = clamp((d + u_colorShift) / u_colorRadius, 0.0, 1.0);
  outColor = vec4(mix(v_inside, v_outside, t) * alpha, alpha);
}`;

interface CapsuleGpu {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  instances: WebGLBuffer;
  uniforms: Map<string, WebGLUniformLocation | null>;
}
const capsuleGpu = new WeakMap<GL, CapsuleGpu>();

function capsules(gl: GL): CapsuleGpu {
  let state = capsuleGpu.get(gl);
  if (state) return state;
  const program = compile(gl, CAPSULE_VS, CAPSULE_FS);
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const corners = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const instances = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  for (const [location, size, offset] of [[1, 4, 0], [2, 3, 16], [3, 3, 28]]) {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, INSTANCE_FLOATS * 4, offset);
    gl.vertexAttribDivisor(location, 1);
  }
  gl.bindVertexArray(null);
  state = { program, vao, instances, uniforms: new Map() };
  capsuleGpu.set(gl, state);
  return state;
}

/** The comp that holds `layer`. */
const owners = new WeakMap<Project, Map<Layer, CompItem>>();
function compOf(project: Project, layer: Layer): CompItem | undefined {
  let map = owners.get(project);
  if (!map) {
    map = new Map();
    for (const item of project.items.values()) if (item.kind === "comp") for (const l of item.layers) map.set(l, item);
    owners.set(project, map);
  }
  return map.get(layer);
}

/**
 * A path flattened for arc-length lookup: cumulative lengths of its polyline
 * points, each point's bezier segment and parameter, and the segments' control
 * points (a, c1, c2, b) for exact positions and tangents.
 */
interface Polyline {
  lengths: number[];
  segment: number[];
  param: number[];
  controls: number[][];
  closed: boolean;
}

const BEZIER_STEPS = 64;

function flatten(shape: Shape): Polyline {
  const { vertices: v, inTangents: inT, outTangents: outT } = shape;
  const line: Polyline = { lengths: [], segment: [], param: [], controls: [], closed: shape.closed };
  if (!v.length) return line;
  const count = shape.closed ? v.length : v.length - 1;
  let px = v[0][0];
  let py = v[0][1];
  line.lengths.push(0);
  line.segment.push(0);
  line.param.push(0);
  for (let i = 0; i < count; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    const straight = !outT[i][0] && !outT[i][1] && !inT[(i + 1) % v.length][0] && !inT[(i + 1) % v.length][1];
    // Straight segments get controls at the thirds, so the cubic moves along them at constant speed.
    const c1 = straight ? [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3] : [a[0] + outT[i][0], a[1] + outT[i][1]];
    const c2 = straight ? [b[0] - (b[0] - a[0]) / 3, b[1] - (b[1] - a[1]) / 3] : [b[0] + inT[(i + 1) % v.length][0], b[1] + inT[(i + 1) % v.length][1]];
    const c = [a[0], a[1], c1[0], c1[1], c2[0], c2[1], b[0], b[1]];
    line.controls.push(c);
    const steps = straight ? 1 : BEZIER_STEPS;
    for (let s = 1; s <= steps; s++) {
      const [x, y] = bezier(c, s / steps);
      line.lengths.push(line.lengths[line.lengths.length - 1] + Math.hypot(x - px, y - py));
      line.segment.push(i);
      line.param.push(s / steps);
      px = x;
      py = y;
    }
  }
  return line;
}

/** Position and derivative of a cubic bezier (control points a, c1, c2, b as x, y pairs) at `t`. */
function bezier(c: number[], t: number): [number, number, number, number] {
  const u = 1 - t;
  const x = u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6];
  const y = u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7];
  const dx = 3 * u * u * (c[2] - c[0]) + 6 * u * t * (c[4] - c[2]) + 3 * t * t * (c[6] - c[4]);
  const dy = 3 * u * u * (c[3] - c[1]) + 6 * u * t * (c[5] - c[3]) + 3 * t * t * (c[7] - c[5]);
  return [x, y, dx, dy];
}

/** Position and unit tangent at arc length `s` along `line`. */
function pointAt(line: Polyline, s: number): [number, number, number, number] {
  const { lengths } = line;
  const n = lengths.length;
  if (n < 2) return [line.controls[0]?.[0] ?? 0, line.controls[0]?.[1] ?? 0, 1, 0];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = lengths[lo + 1] - lengths[lo];
  const f = span > 0 ? Math.min(1, Math.max(0, (s - lengths[lo]) / span)) : 0;
  const segment = line.segment[lo + 1];
  const t0 = line.segment[lo] === segment ? line.param[lo] : 0;
  const c = line.controls[segment];
  const [x, y, bx, by] = bezier(c, t0 + (line.param[lo + 1] - t0) * f);
  // A zero-length tangent (a straight piece with coincident points, or a cusp): fall back to the chord.
  const [dx, dy] = Math.hypot(bx, by) > 1e-9 ? [bx, by] : [c[6] - c[0], c[7] - c[1]];
  const len = Math.hypot(dx, dy) || 1;
  return [x, y, dx / len, dy / len];
}

/** The mask of `layer` chosen by a Path parameter (1-based), at `time`. */
function maskShape(layer: Layer, index: number, time: number): Shape | undefined {
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Mask Parade");
  const masks = (parade?.children ?? []).filter((n): n is PropertyGroup => n.kind === "group" && !!n.mask);
  const mask = masks[index - 1];
  const prop = mask?.children.find((c) => c.matchName === "ADBE Mask Shape");
  const value = prop?.kind === "property" ? currentValue(prop, time, layer) : null;
  return isShapeValue(value) ? value : undefined;
}

/** Base point and Side A normal of each band (x, y, nx, ny), per run of all bands drawn as one path. */
interface BandRuns {
  runs: Float64Array[];
  /** The polar path: rays from the Start Point, drawn the same for every Side Option. */
  polar: boolean;
}

function bandRuns(effect: PropertyGroup, layer: Layer, time: number, bands: number): BandRuns {
  const frames = new Float64Array(bands * 4);
  const pathIndex = effectNumber(effect, 4, layer, time, 0);
  const start = effectVector(effect, 2, layer, time, [0, 0]);
  const end = effectVector(effect, 3, layer, time, [0, 0]);
  const shape = pathIndex > 0 ? maskShape(layer, pathIndex, time) : undefined;
  const at = (k: number) => (bands > 1 ? k / (bands - 1) : 0);
  if (shape && shape.vertices.length) {
    const line = flatten(shape);
    const total = line.lengths[line.lengths.length - 1] ?? 0;
    for (let k = 0; k < bands; k++) {
      const [x, y, dx, dy] = pointAt(line, total * (shape.closed ? k / bands : at(k)));
      frames.set([x, y, dy, -dx], k * 4);
    }
  } else if (effectNumber(effect, 5, layer, time, 0) !== 0) {
    // Rays from the Start Point at π − π k / (N − 1) (screen angles, counter-clockwise),
    // mirrored below the horizontal; the End Point is not used.
    const mirrored = new Float64Array(bands * 4);
    for (let k = 0; k < bands; k++) {
      const a = Math.PI * (1 - at(k));
      frames.set([start[0], start[1], Math.cos(a), -Math.sin(a)], k * 4);
      mirrored.set([start[0], start[1], Math.cos(a), Math.sin(a)], k * 4);
    }
    return { runs: [frames, mirrored], polar: true };
  } else {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const len = Math.hypot(dx, dy) || 1;
    for (let k = 0; k < bands; k++) frames.set([start[0] + dx * at(k), start[1] + dy * at(k), dy / len, -dx / len], k * 4);
  }
  return { runs: [frames], polar: false };
}

/** `rgb` with its hue turned by `degrees` (saturation and lightness kept). */
function rotateHue(rgb: number[], degrees: number): [number, number, number] {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d <= 0) return [r, g, b];
  const h0 = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const h = (((h0 + degrees / 60) % 6) + 6) % 6;
  const x = d * (1 - Math.abs((h % 2) - 1));
  const sector = Math.floor(h);
  const [cr, cg, cb] = [[d, x, 0], [x, d, 0], [0, d, x], [0, x, d], [x, 0, d], [d, 0, x]][sector];
  return [cr + min, cg + min, cb + min];
}

/**
 * Inside and Outside colour of each band (6 per band). Hue Interpolation turns
 * the hue by Hue · s(k) with s(k) = k / (N − 1), or the tent 1 − |2k / (N − 1) − 1|
 * with Color Symmetry; Dynamic Hue Phase subtracts s at the strongest band.
 */
function bandColors(inside: number[], outside: number[], mags: Float32Array, hue: number, dynamic: boolean, symmetry: boolean): Float32Array {
  const bands = mags.length;
  const colors = new Float32Array(bands * 6);
  const s = (k: number) => {
    const f = bands > 1 ? k / (bands - 1) : 0;
    return symmetry ? 1 - Math.abs(2 * f - 1) : f;
  };
  let strongest = 0;
  for (let k = 1; k < bands; k++) if (mags[k] > mags[strongest]) strongest = k;
  const phase = dynamic ? s(strongest) : 0;
  for (let k = 0; k < bands; k++) {
    const turn = hue * (s(k) - phase);
    // A channel moves by at most turn / 60 of the colour's range: under 1e-3 degrees no 8-bit value changes.
    const [a, b] = Math.abs(turn) < 1e-3 ? [inside, outside] : [rotateHue(inside, turn), rotateHue(outside, turn)];
    colors[k * 6] = a[0];
    colors[k * 6 + 1] = a[1];
    colors[k * 6 + 2] = a[2];
    colors[k * 6 + 3] = b[0];
    colors[k * 6 + 4] = b[1];
    colors[k * 6 + 5] = b[2];
  }
  return colors;
}

const audioIds = new WeakMap<object, number>();
let nextAudioId = 1;
const idOf = (o: object) => audioIds.get(o) ?? (audioIds.set(o, nextAudioId), nextAudioId++);

const spectra = new Map<string, Float32Array>();
const MAX_SPECTRA = 128;

/** Band magnitudes of the audio layer at comp time `time` (offset included), cached. */
function spectrumAt(audio: LayerAudio, time: number, settings: SpectrumSettings, averaged: boolean): Float32Array {
  const perSecond = audio.rate * audio.timeScale;
  const length = windowLength(perSecond, settings.durationMs);
  const first = windowStart(time, perSecond, length);
  const key = `${perSecond}:${audio.contributions.map((c) => `${idOf(c.audio)}:${c.scale}:${c.offset}:${c.from}:${c.to}`).join("|")}#${first}:${length}:${settings.startFrequency}:${settings.endFrequency}:${settings.bands}:${averaged}`;
  let mags = spectra.get(key);
  if (mags) {
    spectra.delete(key);
    spectra.set(key, mags);
    return mags;
  }
  mags = (averaged ? analyseAveraged : analyse)(mixWindow(audio, first, length), audio.rate, settings);
  spectra.set(key, mags);
  if (spectra.size > MAX_SPECTRA) spectra.delete(spectra.keys().next().value!);
  return mags;
}

function drawCapsules(ctx: RenderContext, out: { width: number; height: number }, instances: Float32Array, thickness: number, softness: number): void {
  const gl = ctx.gl;
  const gpu = capsules(gl);
  const u = (name: string) => {
    if (!gpu.uniforms.has(name)) gpu.uniforms.set(name, gl.getUniformLocation(gpu.program, name));
    return gpu.uniforms.get(name)!;
  };
  const ramp = rampWidth(thickness, softness);
  const edge = thickness / 2;
  gl.useProgram(gpu.program);
  gl.uniform2f(u("u_size"), out.width, out.height);
  gl.uniform1f(u("u_pad"), ctx.pad);
  gl.uniform1f(u("u_reach"), edge + ramp / 2 + 1);
  gl.uniform1f(u("u_edge"), edge);
  gl.uniform1f(u("u_ramp"), ramp);
  const colorRadius = Math.max(edge, MIN_COLOR_RADIUS);
  gl.uniform1f(u("u_colorRadius"), colorRadius);
  gl.uniform1f(u("u_colorShift"), (colorRadius - edge) / 2);
  gl.bindBuffer(gl.ARRAY_BUFFER, gpu.instances);
  gl.bufferData(gl.ARRAY_BUFFER, instances, gl.STREAM_DRAW);
  gl.bindVertexArray(gpu.vao);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances.length / INSTANCE_FLOATS);
  gl.bindVertexArray(null);
}

let sharedInstances = new Float32Array(0);

/** A reused buffer for at least `capacity` instances. */
function instanceBuffer(capacity: number): Float32Array {
  if (sharedInstances.length < capacity * INSTANCE_FLOATS) sharedInstances = new Float32Array(capacity * INSTANCE_FLOATS);
  return sharedInstances;
}

/** Reverses the order of the instances in place. */
function reverseInstances(instances: Float32Array): void {
  const n = instances.length / INSTANCE_FLOATS;
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    for (let c = 0; c < INSTANCE_FLOATS; c++) {
      const t = instances[i * INSTANCE_FLOATS + c];
      instances[i * INSTANCE_FLOATS + c] = instances[j * INSTANCE_FLOATS + c];
      instances[j * INSTANCE_FLOATS + c] = t;
    }
  }
}

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_spectrum;
uniform sampler2D u_original;
in vec2 v_uv;
out vec4 color;
void main() {
  vec4 s = texture(u_spectrum, v_uv);
  color = s + texture(u_original, v_uv) * (1.0 - s.a);
}`;

registerEffect("ADBE AudSpect", (input, effect, layer, time, ctx) => {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  const composite = num(23, 0) !== 0;
  const pad = ctx.pad;
  const out = ctx.pool.acquire(input.width + 2 * pad, input.height + 2 * pad);
  const finish = () => {
    if (!composite) {
      ctx.pool.release(input.target);
      return { ...input, target: out };
    }
    const merged = ctx.pool.acquire(out.width, out.height);
    ctx.pass(ctx.program(COMPOSITE_FS), merged, [out, input.target], (u) => {
      ctx.gl.uniform1i(u("u_spectrum"), 0);
      ctx.gl.uniform1i(u("u_original"), 1);
    });
    ctx.pool.release(out);
    ctx.pool.release(input.target);
    return { ...input, target: merged };
  };

  const comp = compOf(ctx.project, layer);
  const audioIndex = num(1, 0);
  const audioLayer = comp?.layers.find((l) => l.index === audioIndex);
  if (!audioLayer) return finish();
  const audio = layerAudio(ctx.project, audioLayer, time);
  if (audio === "pending") {
    ctx.loading(`audio is loading ("${audioLayer.name}")`);
    return finish();
  }
  const bands = Math.max(1, Math.round(num(8, 64)));
  const settings = { startFrequency: num(6, 20), endFrequency: num(7, 2000), bands, durationMs: Math.max(0, num(10, 90)) };
  // An audio layer without sound is analysed as silence: the bands are drawn at zero height.
  const mags = audio ? spectrumAt(audio, time + num(11, 0) / 1000, settings, num(22, 0) !== 0) : new Float32Array(bands);
  const maxHeight = num(9, 50);
  const thickness = Math.max(0, num(12, 3));
  const softness = Math.min(1, Math.max(0, num(13, 0.5)));
  const inside = effectVector(effect, 14, layer, time, [1, 1, 1, 1]);
  const outside = effectVector(effect, 15, layer, time, [1, 1, 1, 1]);
  const display = num(20, Display.DIGITAL);
  const blend = num(16, 0) !== 0;
  if (num(22, 0)) ctx.warn("Audio Spectrum: Duration Averaging is approximated (tones are drawn too small)");
  if (effectProperty(effect, 4) && num(4, 0) > 0 && !maskShape(layer, num(4, 0), time)) ctx.warn("Audio Spectrum: its Path mask was not found");

  const { runs, polar } = bandRuns(effect, layer, time, bands);
  const side = polar ? Side.A : num(21, Side.A);
  const colors = bandColors(inside, outside, mags, num(17, 0), num(18, 1) !== 0, num(19, 1) !== 0);
  const instances = instanceBuffer(runs.length * 2 * bands);
  let count = 0;
  const push = (k: number, ax: number, ay: number, bx: number, by: number) => {
    const at = count++ * INSTANCE_FLOATS;
    instances[at] = ax;
    instances[at + 1] = ay;
    instances[at + 2] = bx;
    instances[at + 3] = by;
    for (let c = 0; c < 6; c++) instances[at + 4 + c] = colors[6 * k + c];
  };
  for (const frames of runs) {
    // Tips per side; analog lines on both sides alternate, even bands on Side A.
    const tips: Float64Array[] = [];
    const alternate = side === Side.BOTH && display === Display.LINES;
    const sides = side === Side.BOTH && !alternate ? [1, -1] : side === Side.B ? [-1] : [1];
    for (const sign of sides) {
      const tip = new Float64Array(bands * 2);
      for (let k = 0; k < bands; k++) {
        const h = HEIGHT_SCALE * maxHeight * mags[k] * (alternate && k % 2 ? -sign : sign);
        tip[2 * k] = frames[4 * k] + frames[4 * k + 2] * h;
        tip[2 * k + 1] = frames[4 * k + 1] + frames[4 * k + 3] * h;
      }
      tips.push(tip);
    }
    if (display === Display.LINES) {
      for (const tip of tips) for (let k = 0; k + 1 < bands; k++) push(k, tip[2 * k], tip[2 * k + 1], tip[2 * k + 2], tip[2 * k + 3]);
      if (bands === 1) for (const tip of tips) push(0, tip[0], tip[1], tip[0], tip[1]);
    } else if (display === Display.DOTS) {
      for (const tip of tips) for (let k = 0; k < bands; k++) push(k, tip[2 * k], tip[2 * k + 1], tip[2 * k], tip[2 * k + 1]);
    } else if (side === Side.BOTH) {
      for (let k = 0; k < bands; k++) push(k, tips[1][2 * k], tips[1][2 * k + 1], tips[0][2 * k], tips[0][2 * k + 1]);
    } else {
      for (let k = 0; k < bands; k++) push(k, frames[4 * k], frames[4 * k + 1], tips[0][2 * k], tips[0][2 * k + 1]);
    }
  }

  // `acquire` left `out` bound with its viewport set.
  const gl = ctx.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
  gl.viewport(0, 0, out.width, out.height);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(pad, pad, input.width, input.height);
  gl.enable(gl.BLEND);
  // Blend Overlapping Colors composites each band over the later ones; otherwise the strongest wins.
  if (blend) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  else gl.blendEquation(gl.MAX);
  const drawn = instances.subarray(0, count * INSTANCE_FLOATS);
  if (blend) reverseInstances(drawn);
  drawCapsules(ctx, out, drawn, thickness, softness);
  gl.blendEquation(gl.FUNC_ADD);
  gl.disable(gl.BLEND);
  gl.disable(gl.SCISSOR_TEST);
  return finish();
});
