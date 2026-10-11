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
// The vertex shader lays every capsule out from the band layout and the
// magnitudes in one instanced draw per run; the spectrum is computed on the
// CPU, for the frames ahead in workers (spectrumPrefetch.ts), and cached by
// audio, time and settings.
import { currentValue } from "../../aep/evaluate.ts";
import { isShapeValue, type CompItem, type Layer, type Project, type PropertyGroup, type Shape } from "../../aep/model.ts";
import { layerAudio, type LayerAudio } from "../../media/mix.ts";
import { effectNumber, effectProperty, effectVector } from "../effectParams.ts";
import { compile, type GL } from "../gl.ts";
import { registerEffect, type RenderContext } from "../registry.ts";
import type { SpectrumSettings } from "./audioSpectrumAnalysis.ts";
import { prefetchSpectra, spectrumAt } from "./spectrumPrefetch.ts";

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

// One instance per capsule, laid out here from u_data: a row per run of
// bands with each band's base point and Side A normal (x, y, nx, ny; layer
// pixels, y down, pixel centres at integers), then a row of magnitudes. Each
// capsule is a segment a -> b with the band's Inside and Outside colours
// (hue-turned per band), drawn as a quad covering its reach.
const CAPSULE_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
uniform highp sampler2D u_data;
uniform int u_run;
uniform int u_magRow;
uniform int u_bands;
uniform int u_count;
uniform bool u_reverse;
uniform int u_display;
uniform bool u_both;
uniform bool u_alternate;
uniform float u_sign;
uniform float u_height;
uniform vec3 u_inside;
uniform vec3 u_outside;
uniform float u_hue;
uniform float u_phase;
uniform bool u_symmetry;
uniform vec2 u_size;
uniform float u_pad;
uniform float u_reach;
uniform float u_scale;
flat out vec4 v_segment;
flat out vec3 v_inside;
flat out vec3 v_outside;

// A layer pixel position (pixel centres at integers) in this image's pixels, at a reduced resolution.
vec2 toImage(vec2 p) {
  return u_scale == 1.0 ? p : (p + 0.5) * u_scale - 0.5;
}

vec2 tip(int k, float sign) {
  vec4 f = texelFetch(u_data, ivec2(k, u_run), 0);
  float h = u_height * texelFetch(u_data, ivec2(k, u_magRow), 0).r * (u_alternate && k % 2 == 1 ? -sign : sign);
  return toImage(f.xy + f.zw * h);
}

// The colour with its hue turned by \`degrees\` (saturation and lightness kept).
vec3 rotateHue(vec3 c, float degrees) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  if (d <= 0.0) return c;
  float h0 = mx == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  float h = mod(h0 + degrees / 60.0, 6.0);
  float x = d * (1.0 - abs(mod(h, 2.0) - 1.0));
  int sector = min(int(floor(h)), 5);
  vec3 r = sector == 0 ? vec3(d, x, 0.0) : sector == 1 ? vec3(x, d, 0.0) : sector == 2 ? vec3(0.0, d, x)
         : sector == 3 ? vec3(0.0, x, d) : sector == 4 ? vec3(x, 0.0, d) : vec3(d, 0.0, x);
  return r + mn;
}

void main() {
  int i = u_reverse ? u_count - 1 - gl_InstanceID : gl_InstanceID;
  int k;
  vec2 a;
  vec2 b;
  if (u_display == ${Display.LINES}) {
    int per = max(u_bands - 1, 1);
    k = i % per;
    float sign = i / per == 0 ? u_sign : -u_sign;
    a = tip(k, sign);
    b = u_bands == 1 ? a : tip(k + 1, sign);
  } else if (u_display == ${Display.DOTS}) {
    k = i % u_bands;
    a = tip(k, i / u_bands == 0 ? u_sign : -u_sign);
    b = a;
  } else if (u_both) {
    k = i;
    a = tip(k, -1.0);
    b = tip(k, 1.0);
  } else {
    k = i;
    a = toImage(texelFetch(u_data, ivec2(k, u_run), 0).xy);
    b = tip(k, u_sign);
  }
  // Hue Interpolation turns the hue by Hue · s(k), s(k) = k / (N − 1) or the tent 1 − |2k / (N − 1) − 1| with
  // Color Symmetry; Dynamic Hue Phase subtracts s at the strongest band (u_phase). Under 1e-3 degrees no 8-bit
  // value changes.
  float f = u_bands > 1 ? float(k) / float(u_bands - 1) : 0.0;
  float turn = u_hue * ((u_symmetry ? 1.0 - abs(2.0 * f - 1.0) : f) - u_phase);
  v_inside = abs(turn) < 1e-3 ? u_inside : rotateHue(u_inside, turn);
  v_outside = abs(turn) < 1e-3 ? u_outside : rotateHue(u_outside, turn);
  float len = length(b - a);
  vec2 u = len > 1e-6 ? (b - a) / len : vec2(1.0, 0.0);
  vec2 v = vec2(-u.y, u.x);
  vec2 p = a + u * mix(-u_reach, len + u_reach, a_corner.x) + v * ((a_corner.y * 2.0 - 1.0) * u_reach);
  v_segment = vec4(a, b);
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

/**
 * Band data textures used in turn, per size. Rewriting a texture that draws already queued still read makes the
 * driver wait for the GPU to finish them; with a ring, each spectrum of a frame (and of the next frames) gets its
 * own. A ring per size keeps each texture's storage, so it is refilled rather than allocated again.
 */
const DATA_RING = 32;

interface DataRing {
  textures: WebGLTexture[];
  next: number;
}

interface CapsuleGpu {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  /** RGBA32F band layouts and magnitudes (see CAPSULE_VS), by "width x height". */
  data: Map<string, DataRing>;
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
  gl.bindVertexArray(null);
  state = { program, vao, data: new Map(), uniforms: new Map() };
  capsuleGpu.set(gl, state);
  return state;
}

let sharedData = new Float32Array(0);

/** Uploads the runs' band layout and the magnitudes (a row each) into the next data texture, bound to unit 0. */
function uploadBands(gl: GL, gpu: CapsuleGpu, runs: Float64Array[], mags: Float32Array): void {
  const width = mags.length;
  const height = runs.length + 1;
  if (sharedData.length < width * height * 4) sharedData = new Float32Array(width * height * 4);
  const data = sharedData.subarray(0, width * height * 4);
  runs.forEach((frames, r) => data.set(frames, r * width * 4));
  data.fill(0, runs.length * width * 4);
  for (let k = 0; k < width; k++) data[(runs.length * width + k) * 4] = mags[k];
  const size = `${width}x${height}`;
  let ring = gpu.data.get(size);
  if (!ring) gpu.data.set(size, (ring = { textures: [], next: 0 }));
  gl.activeTexture(gl.TEXTURE0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  let texture = ring.textures[ring.next];
  if (!texture) {
    texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
    ring.textures.push(texture);
  } else gl.bindTexture(gl.TEXTURE_2D, texture);
  ring.next = (ring.next + 1) % DATA_RING;
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data);
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

const runCache = new WeakMap<PropertyGroup, { key: string; shape: Shape | undefined; runs: BandRuns }>();

function bandRuns(effect: PropertyGroup, layer: Layer, time: number, bands: number): BandRuns {
  const pathIndex = effectNumber(effect, 4, layer, time, 0);
  const start = effectVector(effect, 2, layer, time, [0, 0]);
  const end = effectVector(effect, 3, layer, time, [0, 0]);
  const shape = pathIndex > 0 ? maskShape(layer, pathIndex, time) : undefined;
  const polar = effectNumber(effect, 5, layer, time, 0) !== 0;
  // The same parameters (and the same mask path value) lay the bands out the same.
  const key = `${bands}|${pathIndex}|${start.join()}|${end.join()}|${polar}`;
  const cached = runCache.get(effect);
  if (cached && cached.key === key && cached.shape === shape) return cached.runs;
  const runs = layOutBands(start, end, shape, polar, bands);
  runCache.set(effect, { key, shape, runs });
  return runs;
}

function layOutBands(start: number[], end: number[], shape: Shape | undefined, polar: boolean, bands: number): BandRuns {
  const frames = new Float64Array(bands * 4);
  const at = (k: number) => (bands > 1 ? k / (bands - 1) : 0);
  if (shape && shape.vertices.length) {
    const line = flatten(shape);
    const total = line.lengths[line.lengths.length - 1] ?? 0;
    for (let k = 0; k < bands; k++) {
      const [x, y, dx, dy] = pointAt(line, total * (shape.closed ? k / bands : at(k)));
      frames.set([x, y, dy, -dx], k * 4);
    }
  } else if (polar) {
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

/** Frames ahead whose spectra are computed off this thread while a frame renders (playback shows them next). */
const PREFETCH_FRAMES = 16;
/** The last time each effect was drawn at and the smallest step between its draws (its frame step in playback). */
const drawn = new WeakMap<PropertyGroup, { time: number; step: number }>();

/**
 * The spectrum drawn at `time` (null while the workers compute it, see spectraOffThread), and the spectra of the
 * next frames started on the workers: spaced by the smallest step between the effect's draws (a nested comp is
 * drawn at its parent's frame times), else by `frame`.
 */
function spectrum(effect: PropertyGroup, audio: LayerAudio, time: number, frame: number, settings: SpectrumSettings, averaged: boolean): Float32Array | null {
  const mags = spectrumAt(audio, time, settings, averaged);
  const last = drawn.get(effect);
  const delta = last ? time - last.time : 0;
  // Steps under a quarter of a 60 fps frame are motion blur samples, not frames.
  const step = Math.min(last?.step ?? frame, delta >= 1 / 240 && delta < 0.25 ? delta : Infinity);
  drawn.set(effect, { time, step });
  if (step > 0) prefetchSpectra(audio, Array.from({ length: PREFETCH_FRAMES }, (_, k) => time + (k + 1) * step), settings, averaged);
  return mags;
}

interface CapsuleStyle {
  display: number;
  side: number;
  maxHeight: number;
  thickness: number;
  softness: number;
  inside: number[];
  outside: number[];
  hue: number;
  dynamic: boolean;
  symmetry: boolean;
  /** Blend Overlapping Colors: each band composited over the later ones, so drawn last to first. */
  blend: boolean;
}

/**
 * Draws every band capsule of every run into the bound target. Analog lines on both sides alternate, even
 * bands on Side A; analog dots on both sides are drawn once per side; digital bars on both sides run from one
 * side's tip to the other's.
 */
function drawCapsules(
  ctx: RenderContext,
  out: { width: number; height: number },
  runs: Float64Array[],
  mags: Float32Array,
  style: CapsuleStyle,
  scale: number,
): void {
  const gl = ctx.gl;
  const gpu = capsules(gl);
  const u = (name: string) => {
    if (!gpu.uniforms.has(name)) gpu.uniforms.set(name, gl.getUniformLocation(gpu.program, name));
    return gpu.uniforms.get(name)!;
  };
  const bands = mags.length;
  uploadBands(gl, gpu, runs, mags);
  // Widths in this image's pixels (positions are converted in the vertex shader).
  const thickness = style.thickness * scale;
  const ramp = rampWidth(thickness, style.softness);
  const edge = thickness / 2;
  gl.useProgram(gpu.program);
  gl.uniform1i(u("u_data"), 0);
  gl.uniform1i(u("u_magRow"), runs.length);
  gl.uniform1i(u("u_bands"), bands);
  gl.uniform1i(u("u_display"), style.display);
  const both = style.side === Side.BOTH;
  gl.uniform1i(u("u_both"), both ? 1 : 0);
  gl.uniform1i(u("u_alternate"), both && style.display === Display.LINES ? 1 : 0);
  gl.uniform1f(u("u_sign"), style.side === Side.B ? -1 : 1);
  gl.uniform1f(u("u_height"), HEIGHT_SCALE * style.maxHeight);
  gl.uniform3f(u("u_inside"), style.inside[0], style.inside[1], style.inside[2]);
  gl.uniform3f(u("u_outside"), style.outside[0], style.outside[1], style.outside[2]);
  let phase = 0;
  if (style.dynamic && style.hue !== 0) {
    let strongest = 0;
    for (let k = 1; k < bands; k++) if (mags[k] > mags[strongest]) strongest = k;
    const f = bands > 1 ? strongest / (bands - 1) : 0;
    phase = style.symmetry ? 1 - Math.abs(2 * f - 1) : f;
  }
  gl.uniform1f(u("u_hue"), style.hue);
  gl.uniform1f(u("u_phase"), phase);
  gl.uniform1i(u("u_symmetry"), style.symmetry ? 1 : 0);
  gl.uniform2f(u("u_size"), out.width, out.height);
  gl.uniform1f(u("u_pad"), ctx.pad);
  gl.uniform1f(u("u_reach"), edge + ramp / 2 + 1);
  gl.uniform1f(u("u_scale"), scale);
  gl.uniform1f(u("u_edge"), edge);
  gl.uniform1f(u("u_ramp"), ramp);
  const colorRadius = Math.max(edge, MIN_COLOR_RADIUS * scale);
  gl.uniform1f(u("u_colorRadius"), colorRadius);
  gl.uniform1f(u("u_colorShift"), (colorRadius - edge) / 2);
  gl.uniform1i(u("u_reverse"), style.blend ? 1 : 0);
  const sides = style.display === Display.DOTS && both ? 2 : 1;
  const count = style.display === Display.LINES ? Math.max(bands - 1, 1) : style.display === Display.DOTS ? sides * bands : bands;
  gl.uniform1i(u("u_count"), count);
  gl.bindVertexArray(gpu.vao);
  const order = runs.map((_, r) => r);
  if (style.blend) order.reverse();
  for (const r of order) {
    gl.uniform1i(u("u_run"), r);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  }
  gl.bindVertexArray(null);
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
  const frame = comp ? comp.frameDuration || 1 / (comp.frameRate || 24) : 0;
  const mags = audio ? spectrum(effect, audio, time + num(11, 0) / 1000, frame, settings, num(22, 0) !== 0) : new Float32Array(bands);
  if (!mags) {
    ctx.loading(`audio spectrum is being analysed ("${audioLayer.name}")`);
    return finish();
  }
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
  const style: CapsuleStyle = { display, side, maxHeight, thickness, softness, inside, outside, hue: num(17, 0), dynamic: num(18, 1) !== 0, symmetry: num(19, 1) !== 0, blend };

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
  drawCapsules(ctx, out, runs, mags, style, input.scale ?? 1);
  gl.blendEquation(gl.FUNC_ADD);
  gl.disable(gl.BLEND);
  gl.disable(gl.SCISSOR_TEST);
  return finish();
}, { scalable: true });
