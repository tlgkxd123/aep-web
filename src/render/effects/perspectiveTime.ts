// Perspective and Time effects.
//
// The Time effects see their layer as it enters the effect (its source, masks and
// the effects above) at other times; they are not cacheable and render at full
// resolution. Their rules come from After Effects' renders of the perspective
// fixtures (scripts/fixtures/build_perspective.py).
import { currentValue, layerTimeAt } from "../../aep/evaluate.ts";
import type { Layer, PropertyGroup } from "../../aep/model.ts";
import { acquireFloat, releaseFloat } from "../floatTargets.ts";
import { unitQuad, type GL, type Target } from "../gl.ts";
import { MaskRenderer } from "../masks.ts";
import { contentProviders, effectRenderer, type LayerImage, type RenderContext } from "../registry.ts";
import { rasterizeShapeLayer } from "../shapes.ts";
import type { Uniforms } from "./fxextraUtil.ts";
import { clampRect, COLOR_LIB, compOf, COORDS, gaussian, imageRect, layerPass, registerStock, unionRect, type Rect } from "./stockUtil.ts";

const TIME_EFFECT = { cacheable: false, scalable: false } as const;

/** Images one pass reads at most besides its running result (WebGL 2 guarantees 16 texture units). */
const MAX_FRAMES = 14;

/** The neutral grey of Time Difference's signed result (After Effects writes 127 for no difference). */
const DIFFERENCE_MID = 127 / 255;

/** Radial Shadow's Softness over the standard deviation of its Gaussian. */
const RADIAL_SOFTNESS = 2.4;

function frameDuration(ctx: RenderContext, layer: Layer): number {
  return compOf(ctx, layer)?.frameDuration ?? 1 / 24;
}

function layerAt(ctx: RenderContext, layer: Layer, index: number): Layer | undefined {
  return index > 0 ? compOf(ctx, layer)?.layers.find((l) => l.index === index) : undefined;
}

/**
 * The layer's source at comp time `t`, or null when it draws nothing then. Caller releases. The renderer refuses
 * RenderContext.layerImage for the layer whose effects are running, so its source is drawn here as the renderer
 * draws it: a content provider's image, the shapes, a solid or a nested comp at the layer's time.
 */
function sourceAt(ctx: RenderContext, layer: Layer, t: number): LayerImage | null {
  const image = ctx.layerImage(layer, t, false);
  if (image) return image;
  for (const provider of contentProviders()) {
    const provided = provider(layer, t, ctx);
    if (provided !== undefined) return provided;
  }
  if (layer.layerType === "ShapeLayer") {
    const raster = rasterizeShapeLayer(layer, t, ctx.pad);
    if (!raster) return null;
    const pad = ctx.pad;
    return ctx.upload(raster.canvas, raster.width + 2 * pad, raster.height + 2 * pad, [raster.origin[0] - pad, raster.origin[1] - pad]);
  }
  const source = layer.sourceId ? ctx.project.items.get(layer.sourceId) : undefined;
  if (source?.kind === "footage" && source.mainSource.sourceType === "SolidSource") {
    const color = source.mainSource.color;
    return layerPass(ctx, { x: 0, y: 0, width: source.width, height: source.height }, [], "uniform vec3 u_color;", "  outColor = vec4(u_color, 1.0);", (u) =>
      ctx.gl.uniform3fv(u("u_color"), color),
    );
  }
  if (source?.kind === "comp") {
    let sourceTime = layerTimeAt(layer, t);
    if (layer.timeRemapEnabled) {
      const remap = layer.properties.find((n) => n.matchName === "ADBE Time Remapping");
      const value = remap?.kind === "property" ? currentValue(remap, t, layer) : null;
      if (typeof value === "number") sourceTime = value;
    }
    return { target: ctx.renderComp(source, sourceTime), width: source.width, height: source.height, origin: [0, 0] };
  }
  return null;
}

const maskRenderers = new WeakMap<GL, MaskRenderer>();

function maskRenderer(gl: GL): MaskRenderer {
  let masks = maskRenderers.get(gl);
  if (!masks) {
    const quad = unitQuad(gl);
    masks = new MaskRenderer(gl, () => {
      gl.bindVertexArray(quad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });
    maskRenderers.set(gl, masks);
  }
  return masks;
}

const MASK_FS = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform sampler2D u_mask;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = texelFetch(u_source, p, 0) * (floor(texelFetch(u_mask, p, 0).r * 255.0 + 0.5) / 255.0);
}`;

/** `image` times the layer's mask coverage at `t` (as the renderer masks content); releases `image`. */
function masked(ctx: RenderContext, layer: Layer, t: number, image: LayerImage): LayerImage {
  const k = image.scale ?? 1;
  const coverage = maskRenderer(ctx.gl).coverage(layer, t, image.width, image.height, ctx.pad, image.origin, k);
  if (!coverage) return image;
  const out = ctx.pool.acquire(image.target.width, image.target.height, false);
  const mask = { texture: coverage, framebuffer: null, width: image.target.width, height: image.target.height } as unknown as Target;
  ctx.pass(ctx.program(MASK_FS), out, [image.target, mask], (u) => {
    ctx.gl.uniform1i(u("u_source"), 0);
    ctx.gl.uniform1i(u("u_mask"), 1);
  });
  ctx.pool.release(image.target);
  return { ...image, target: out };
}

/**
 * The layer as `effect` receives it at comp time `t`: its source, masks and the enabled effects above `effect`, all
 * at `t`. Null when it draws nothing. Caller releases.
 */
function inputAt(ctx: RenderContext, layer: Layer, effect: PropertyGroup, t: number): LayerImage | null {
  const source = sourceAt(ctx, layer, t);
  if (!source) return null;
  let image = masked(ctx, layer, t, source);
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
  for (const above of parade?.children ?? []) {
    if (above === effect) break;
    if (above.kind !== "group" || !above.enabled) continue;
    const render = effectRenderer(above.matchName);
    if (render) image = render(image, above, layer, t, ctx);
  }
  return image;
}

/** An empty image covering `rect`. */
function emptyImage(ctx: RenderContext, rect: Rect): LayerImage {
  return layerPass(ctx, rect, [], "", "  outColor = vec4(0.0);");
}

/**
 * Runs `body` over `rect` into a float target of the padded size (no border cleared): sources are sampled with
 * `at(i, q)` (layer point q, transparent outside their content), the running result of an earlier pass with `prev()`.
 */
function floatPass(ctx: RenderContext, rect: Rect, sources: LayerImage[], prev: Target | null, decls: string, body: string, setUniforms?: Uniforms): Target {
  const out = acquireFloat(ctx, rect.width + 2 * ctx.pad, rect.height + 2 * ctx.pad);
  const samplers = sources.map((_, i) => `uniform sampler2D u_src${i};\nuniform vec2 u_img${i}Origin;\nuniform float u_img${i}Height;\nuniform vec2 u_img${i}Target;\n`).join("");
  const cases = sources
    .map((_, i) => `  if (i == ${i}) { vec2 uv = uvIn(q, u_img${i}Origin, u_img${i}Height, u_img${i}Target); vec2 t = uv * u_img${i}Target;
    if (t.x < u_pad || t.y < u_pad || t.x > u_img${i}Target.x - u_pad || t.y > u_img${i}Target.y - u_pad) return vec4(0.0);
    return texture(u_src${i}, uv); }`)
    .join("\n");
  const fragment = `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D u_prev;
${COORDS}${COLOR_LIB}${samplers}${decls}
vec4 at(int i, vec2 q) {
${cases}
  return vec4(0.0);
}
vec4 prev() { return texelFetch(u_prev, ivec2(gl_FragCoord.xy), 0); }
void main() {
  if (!insideContent()) { outColor = vec4(0.0); return; }
  vec2 p = layerPoint();
${body}
}`;
  const inputs = sources.map((s) => s.target);
  ctx.pass(ctx.program(fragment), out, prev ? [...inputs, prev] : inputs, (u) => {
    const gl = ctx.gl;
    gl.uniform2f(u("u_size"), out.width, out.height);
    gl.uniform1f(u("u_pad"), ctx.pad);
    gl.uniform2f(u("u_origin"), rect.x, rect.y);
    sources.forEach((s, i) => {
      gl.uniform1i(u(`u_src${i}`), i);
      gl.uniform2f(u(`u_img${i}Origin`), s.origin[0], s.origin[1]);
      gl.uniform1f(u(`u_img${i}Height`), s.height);
      gl.uniform2f(u(`u_img${i}Target`), s.target.width, s.target.height);
    });
    gl.uniform1i(u("u_prev"), prev ? sources.length : 0);
    setUniforms?.(u);
  });
  return out;
}

/** A float target of floatPass's over `rect`, as an image layerPass can sample. */
const stateImage = (state: Target, rect: Rect): LayerImage => ({ target: state, width: rect.width, height: rect.height, origin: [rect.x, rect.y] });

/** A float target of floatPass's into an image covering `rect`; `finish` is GLSL turning `vec4 v` into `outColor`. */
function finishPass(ctx: RenderContext, rect: Rect, state: Target, finish: string): LayerImage {
  const out = layerPass(ctx, rect, [stateImage(state, rect)], "", `  vec4 v = at(0, p);\n${finish}`);
  releaseFloat(ctx, state);
  return out;
}

/**
 * Folds weighted frames into a float running result, MAX_FRAMES a pass: `step` is GLSL updating `vec4 s` (the result
 * so far, `init` before the first frame) with the frame `c` (premultiplied) and its weight `w`. Releases the frames.
 */
function foldFrames(ctx: RenderContext, rect: Rect, frames: { image: LayerImage | null; weight: number }[], init: string, step: string): Target {
  let state: Target | null = null;
  for (let start = 0; start === 0 || start < frames.length; start += MAX_FRAMES) {
    const chunk = frames.slice(start, start + MAX_FRAMES);
    const images = chunk.map((f) => f.image).filter((i): i is LayerImage => !!i);
    const slots = new Int32Array(MAX_FRAMES).fill(-1);
    const weights = new Float32Array(MAX_FRAMES);
    let n = 0;
    chunk.forEach((f, i) => {
      weights[i] = f.weight;
      if (f.image) slots[i] = n++;
    });
    const next: Target = floatPass(
      ctx,
      rect,
      images,
      state,
      `uniform int u_slot[${MAX_FRAMES}];\nuniform float u_w[${MAX_FRAMES}];\nuniform int u_count;\nuniform int u_first;`,
      `  vec4 s = u_first == 1 ? ${init} : prev();
  for (int i = 0; i < ${MAX_FRAMES}; i++) {
    if (i >= u_count) break;
    vec4 c = u_slot[i] < 0 ? vec4(0.0) : at(u_slot[i], p);
    float w = u_w[i];
    ${step}
  }
  outColor = s;`,
      (u) => {
        ctx.gl.uniform1iv(u("u_slot"), slots);
        ctx.gl.uniform1fv(u("u_w"), weights);
        ctx.gl.uniform1i(u("u_count"), chunk.length);
        ctx.gl.uniform1i(u("u_first"), state ? 0 : 1);
      },
    );
    for (const image of images) ctx.pool.release(image.target);
    if (state) releaseFloat(ctx, state);
    state = next;
  }
  return state!;
}

// Echo: the layer at Number of Echoes + 1 times Echo Time apart, the k-th weighted Starting Intensity x Decay^k,
// stacked from the newest with the blend mode Echo Operator names: Add (premultiplied sum), Lighten, Darken,
// Screen, Normal with each older frame behind (Composite In Front) or on top (Composite In Back); Blend sums colours
// and coverage alike.
const lighten = (f: string) => `vec4 e = c * w;
    vec3 S = e.a > 0.0 ? e.rgb / e.a : vec3(0.0);
    vec3 B = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
    s = vec4(${f}(S, B) * e.a * s.a + e.rgb * (1.0 - s.a) + s.rgb * (1.0 - e.a), e.a + s.a - e.a * s.a);`;
const ECHO_STEP: Record<number, string> = {
  1: "s = vec4(s.rgb + c.rgb * w, 1.0 - (1.0 - s.a) * (1.0 - c.a * w));",
  2: lighten("max"),
  3: lighten("min"),
  4: "s = 1.0 - (1.0 - s) * (1.0 - c * w);",
  5: "s = c * w + s * (1.0 - c.a * w);",
  6: "s = s + c * w * (1.0 - s.a);",
  7: "s = s + c * w;",
};
const CLAMPED = "  vec4 c = clamp(v, 0.0, 1.0);\n  outColor = vec4(min(c.rgb, vec3(c.a)), c.a);";

registerStock(
  "ADBE Echo",
  (input, p, ctx, layer, time, effect) => {
    const step = p.num(1, -1 / 30);
    const count = Math.max(0, Math.min(1000, Math.round(p.num(2, 1))));
    const start = Math.max(0, Math.min(1, p.num(3, 1)));
    const decay = Math.max(0, Math.min(1, p.num(4, 1)));
    const operator = ECHO_STEP[p.choice(5, 1)] ? p.choice(5, 1) : 1;
    const rect = imageRect(input);
    const frames = [{ image: input as LayerImage | null, weight: start }];
    for (let k = 1; k <= count; k++) frames.push({ image: inputAt(ctx, layer, effect, time + k * step), weight: start * decay ** k });
    return finishPass(ctx, rect, foldFrames(ctx, rect, frames, "vec4(0.0)", ECHO_STEP[operator]), CLAMPED);
  },
  TIME_EFFECT,
);

// Posterize Time: the layer held at the last frame of Frame Rate before the time.
registerStock(
  "ADBE Posterize Time",
  (input, p, ctx, layer, time, effect) => {
    const rate = Math.max(0.01, p.num(1, 24));
    const held = Math.floor(time * rate + 1e-6) / rate;
    if (Math.abs(held - time) < 1e-9) return input;
    const rect = imageRect(input);
    ctx.pool.release(input.target);
    return inputAt(ctx, layer, effect, held) ?? emptyImage(ctx, rect);
  },
  TIME_EFFECT,
);

/** Time Difference's Alpha Channel popup. */
const DifferenceAlpha = { ORIGINAL: 1, TARGET: 2, BLEND: 3, MAX: 4, FULL: 5, RESULT_LUMINANCE: 7, RESULT_MAX: 8, ALPHA_DIFFERENCE: 10, ALPHA_DIFFERENCE_ONLY: 11 } as const;

// Time Difference: the layer minus Target (itself when none) Time Offset later, per straight channel: Contrast
// % of the difference about a neutral grey, or Contrast / 50 times its absolute value. Alpha Channel says the
// result's alpha; Result Luminance and Result Max keep the layer's own colour under the result's mean or largest
// channel, the Alpha Difference modes difference alpha like the colours.
registerStock(
  "ADBE Difference",
  (input, p, ctx, layer, time, effect) => {
    const target = layerAt(ctx, layer, Math.round(p.num(1, 0)));
    const offset = p.num(2, 0);
    const contrast = p.num(3, 50);
    const absolute = p.bool(4, false);
    const alpha = p.num(5, DifferenceAlpha.ORIGINAL);
    const other = target && target !== layer ? ctx.layerImage(target, time + offset, false) : inputAt(ctx, layer, effect, time + offset);
    const rect = imageRect(input);
    const sources = other ? [input, other] : [input];
    const out = layerPass(
      ctx,
      rect,
      sources,
      `uniform float u_contrast;
uniform int u_absolute;
uniform int u_alpha;
uniform float u_mid;
uniform int u_hasTarget;`,
      `  vec4 c = at(0, p);
  vec4 t = u_hasTarget == 1 ? at(1, p) : vec4(0.0);
  vec4 delta = vec4(straight(c) - straight(t), c.a - t.a);
  vec4 d = u_absolute == 1 ? abs(delta) * (u_contrast / 50.0) : u_mid + delta * (u_contrast / 100.0);
  d = clamp(d, 0.0, 1.0);
  vec3 col = d.rgb;
  float a;
  if (u_alpha == 2) a = t.a;
  else if (u_alpha == 3) a = 0.5 * (c.a + t.a);
  else if (u_alpha == 4) a = max(c.a, t.a);
  else if (u_alpha == 5) a = 1.0;
  else if (u_alpha == 7) { a = (d.r + d.g + d.b) / 3.0; col = straight(c); }
  else if (u_alpha == 8) { a = max(d.r, max(d.g, d.b)); col = straight(c); }
  else if (u_alpha == 10) a = d.a;
  else if (u_alpha == 11) { a = d.a; col = vec3(1.0); }
  else a = c.a;
  outColor = vec4(col * a, a);`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform1f(u("u_contrast"), contrast);
        gl.uniform1i(u("u_absolute"), absolute ? 1 : 0);
        gl.uniform1i(u("u_alpha"), alpha);
        gl.uniform1f(u("u_mid"), DIFFERENCE_MID);
        gl.uniform1i(u("u_hasTarget"), other ? 1 : 0);
      },
    );
    for (const s of sources) ctx.pool.release(s.target);
    return out;
  },
  TIME_EFFECT,
);

// Time Displacement: each pixel from the layer at the time its Time Displacement Layer pixel's luminance says, from
// Max Displacement Time back (black) to forward (white), in steps of 1 / Time Resolution; the map stretched over the
// layer, or at its own size from the layer's corner.
registerStock(
  "ADBE Time Displacement",
  (input, p, ctx, layer, time, effect) => {
    const mapLayer = layerAt(ctx, layer, Math.round(p.num(1, 0)));
    const maximum = p.num(2, 1);
    const resolution = Math.max(0.01, p.num(3, 60));
    const stretch = p.bool(4, true);
    const rect = imageRect(input);
    const map = mapLayer && mapLayer !== layer ? ctx.layerImage(mapLayer, time, false) : inputAt(ctx, layer, effect, time);
    if (!map || !maximum) {
      if (map) ctx.pool.release(map.target);
      return input;
    }
    // Grid step i shows the layer at i / resolution; the displaced times reach from first to last.
    const reach = Math.abs(maximum);
    const first = Math.floor((time - reach) * resolution + 1e-6);
    const last = Math.min(first + 1200, Math.floor((time + reach) * resolution + 1e-6));
    let state: Target | null = null;
    for (let base = first; base <= last; base += MAX_FRAMES - 1) {
      const indices = Array.from({ length: Math.min(MAX_FRAMES - 1, last - base + 1) }, (_, j) => base + j);
      const at = (i: number) => Math.min(Math.max(i / resolution, layer.inPoint), layer.outPoint - frameDuration(ctx, layer));
      const now = (i: number) => Math.abs(at(i) - time) < 1e-6;
      const frames = indices.map((i) => (now(i) ? null : inputAt(ctx, layer, effect, at(i))));
      const present = frames.filter((f): f is LayerImage => !!f);
      const slots = new Int32Array(MAX_FRAMES).fill(-1);
      let n = 1;
      frames.forEach((f, j) => {
        if (now(indices[j])) slots[j] = -2;
        else if (f) slots[j] = n++;
      });
      const next: Target = floatPass(
        ctx,
        rect,
        [map, ...present],
        state,
        `uniform int u_slot[${MAX_FRAMES}];
uniform int u_count;
uniform int u_base;
uniform int u_first;
uniform vec4 u_mapRect;
uniform float u_maximum;
uniform float u_time;
uniform float u_resolution;`,
        `  vec4 s = u_first == 1 ? vec4(0.0) : prev();
  vec2 q = u_mapRect.xy + (p - u_origin) * u_mapRect.zw;
  vec4 m = at(0, q);
  float level = luma(straight(m));
  int i = int(floor((u_time + (level - 0.5) * 2.0 * u_maximum) * u_resolution + 1e-4));
  int j = i - u_base;
  if (j >= 0 && j < u_count) {
    int slot = u_slot[j];
    s = slot == -2 ? vec4(-1.0) : slot < 0 ? vec4(0.0) : at(slot, p);
  }
  outColor = s;`,
        (u) => {
          const gl = ctx.gl;
          gl.uniform1iv(u("u_slot"), slots);
          gl.uniform1i(u("u_count"), indices.length);
          gl.uniform1i(u("u_base"), base);
          gl.uniform1i(u("u_first"), state ? 0 : 1);
          const scale = stretch ? [map.width / rect.width, map.height / rect.height] : [1, 1];
          gl.uniform4f(u("u_mapRect"), map.origin[0], map.origin[1], scale[0], scale[1]);
          gl.uniform1f(u("u_maximum"), maximum);
          gl.uniform1f(u("u_time"), time);
          gl.uniform1f(u("u_resolution"), resolution);
        },
      );
      for (const f of present) ctx.pool.release(f.target);
      if (state) releaseFloat(ctx, state);
      state = next;
    }
    ctx.pool.release(map.target);
    // Pixels marked -1 show the layer at the time itself.
    const out = layerPass(ctx, rect, [input, stateImage(state!, rect)], "", `  vec4 v = at(1, p);\n  outColor = v.a < 0.0 ? at(0, p) : v;`);
    releaseFloat(ctx, state!);
    ctx.pool.release(input.target);
    return out;
  },
  TIME_EFFECT,
);

// CC Wide Time: a weighted mean of the layer over Backward Steps frames before and Forward Steps frames after the
// time, the weights falling linearly from the time's to zero one step beyond each end.
registerStock(
  "CC Wide Time",
  (input, p, ctx, layer, time, effect) => {
    const forward = Math.max(0, Math.round(p.num(1, 1)));
    const backward = Math.max(0, Math.round(p.num(2, 1)));
    const fd = frameDuration(ctx, layer);
    const rect = imageRect(input);
    const tent = (k: number) => (k > 0 ? 1 - k / (forward + 1) : 1 + k / (backward + 1));
    let total = 0;
    for (let k = -backward; k <= forward; k++) total += tent(k);
    const frames = [{ image: input as LayerImage | null, weight: 1 / total }];
    for (let k = -backward; k <= forward; k++) if (k) frames.push({ image: inputAt(ctx, layer, effect, time + k * fd), weight: tent(k) / total });
    return finishPass(ctx, rect, foldFrames(ctx, rect, frames, "vec4(0.0)", "s += c * w;"), CLAMPED);
  },
  TIME_EFFECT,
);

// CC Force Motion Blur: the mean of Motion Blur Samples renders of the layer spread over the shutter (Shutter Angle
// of a frame from Shutter Phase, or the composition's).
registerStock(
  "CC Force Motion Blur",
  (input, p, ctx, layer, time, effect) => {
    const samples = Math.max(1, Math.round(p.num(1, 8)));
    const comp = compOf(ctx, layer);
    const override = p.bool(2, true);
    const angle = override ? p.num(3, 180) : (comp?.shutterAngle ?? 180);
    const phase = override ? p.num(5, 0) : (comp?.shutterPhase ?? 0);
    const fd = frameDuration(ctx, layer);
    const rect = imageRect(input);
    ctx.pool.release(input.target);
    const frames = Array.from({ length: samples }, (_, i) => ({ image: inputAt(ctx, layer, effect, time + ((phase + (angle * i) / samples) / 360) * fd), weight: 1 / samples }));
    return finishPass(ctx, rect, foldFrames(ctx, rect, frames, "vec4(0.0)", "s += c * w;"), CLAMPED);
  },
  TIME_EFFECT,
);

// Radial Shadow: the layer's alpha cast from Light Source onto a plane behind it, scaled about the light by
// 1 / (1 - Projection Distance / 100), in Shadow Color at Opacity, softened by Softness, under the layer (or alone).
// Glass Edge tints the shadow with the layer's colour by Color Influence. Resize Layer lets the shadow grow the layer.
registerStock("ADBE Radial Shadow", (input, p, ctx, layer) => {
  const scale = input.scale ?? 1;
  const color = p.rgb(1, [0, 0, 0]);
  const opacity = Math.min(1, Math.max(0, p.num(2, 0.5)));
  const light = p.vec(3, [layer.width / 2, layer.height / 2]).map((v) => (v + 0.5) * scale);
  const distance = Math.min(99, Math.max(0, p.num(4, 10)));
  const softness = Math.max(0, p.num(5, 0)) * scale;
  const glass = p.choice(6, 1) === 2;
  const influence = Math.max(0, p.num(7, 1));
  const shadowOnly = p.bool(8, false);
  const resize = p.bool(9, true);
  const k = 1 / (1 - distance / 100);
  const rect = imageRect(input);
  const cast = { x: light[0] + (rect.x - light[0]) * k, y: light[1] + (rect.y - light[1]) * k, width: rect.width * k, height: rect.height * k };
  const shadowRect = resize ? clampRect(unionRect(rect, cast)) : rect;
  let shadow = layerPass(
    ctx,
    shadowRect,
    [input],
    "uniform vec2 u_light; uniform float u_k; uniform vec3 u_color; uniform float u_opacity; uniform int u_glass; uniform float u_influence;",
    `  vec4 c = at(0, u_light + (p - u_light) / u_k);
  vec3 tint = u_glass == 1 ? mix(u_color, straight(c), clamp(u_influence, 0.0, 1.0)) : u_color;
  float a = c.a * u_opacity;
  outColor = vec4(tint * a, a);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_light"), light[0], light[1]);
      gl.uniform1f(u("u_k"), k);
      gl.uniform3f(u("u_color"), color[0], color[1], color[2]);
      gl.uniform1f(u("u_opacity"), opacity);
      gl.uniform1i(u("u_glass"), glass ? 1 : 0);
      gl.uniform1f(u("u_influence"), influence);
    },
  );
  if (softness > 0) shadow = gaussian(ctx, shadow, softness / RADIAL_SOFTNESS, softness / RADIAL_SOFTNESS);
  const outRect = resize ? unionRect(rect, imageRect(shadow)) : rect;
  const out = layerPass(ctx, outRect, [input, shadow], "uniform int u_only;", "  vec4 c = at(0, p);\n  vec4 s = at(1, p);\n  outColor = u_only == 1 ? s : c + s * (1.0 - c.a);", (u) =>
    ctx.gl.uniform1i(u("u_only"), shadowOnly ? 1 : 0),
  );
  ctx.pool.release(shadow.target);
  ctx.pool.release(input.target);
  return out;
});

const GlassesView = {
  SIDE_BY_SIDE: 1,
  OVER_UNDER: 2,
  INTERLACED: 3,
  DIFFERENCE: 4,
  RED_GREEN: 5,
  RED_BLUE: 6,
  BALANCED_RED_GREEN: 7,
  BALANCED_RED_BLUE: 8,
  BALANCED_BLUE_RED: 9,
} as const;
type GlassesView = (typeof GlassesView)[keyof typeof GlassesView];
const GLASSES_MENU = ["SBS", "OU", "Interlaced", "Difference", "(-", "RG", "RB", "(-", "BRG", "BRB", "(-", "BCBR"];

/** The share of the right view's luminance After Effects writes to green in Red Green and Red Blue LR. */
const GLASSES_GREEN = { [GlassesView.RED_GREEN]: 0.8025, [GlassesView.RED_BLUE]: 0.549 } as const;

// 3D Glasses: Left View moved right by Scene Convergence and down by Vertical Alignment, Right View the other way,
// over the box from the later of their starts to the later of their ends. Side by side and over-under squeeze each
// view into its half of the layer; Interlaced alternates rows (left on even ones); Difference subtracts them; the
// anaglyphs write the left view's luminance to red and the right view's to green or blue, at the views' mean
// alpha, each view repeating its edge pixels. The Balanced views render as their plain anaglyphs.
registerStock(
  "ADBE 3D Glasses2",
  (input, p, ctx, layer, time) => {
    const scale = input.scale ?? 1;
    const viewAt = (index: number) => {
      const view = layerAt(ctx, layer, Math.round(p.num(index, 0)));
      return view && view !== layer ? ctx.layerImage(view, time, false) : null;
    };
    let [left, right] = [viewAt(1), viewAt(2)];
    if (p.bool(4, false)) [left, right] = [right, left];
    const percent = p.choice(8, 1) === 2;
    const convergence = p.num(3, 0) * (percent ? layer.width / 100 : 1) * scale;
    const alignment = p.num(7, 0) * (percent ? layer.height / 100 : 1) * scale;
    let view: GlassesView = p.choice(5, GlassesView.RED_BLUE, GLASSES_MENU) as GlassesView;
    if (view === GlassesView.BALANCED_RED_GREEN) view = GlassesView.RED_GREEN;
    if (view === GlassesView.BALANCED_RED_BLUE || view === GlassesView.BALANCED_BLUE_RED) view = GlassesView.RED_BLUE;
    if (!left && !right) return input;
    const views = [left ?? emptyImage(ctx, imageRect(right!)), right ?? emptyImage(ctx, imageRect(left!))];
    const shifted = views.map((v, i) => {
      const r = imageRect(v);
      const sign = i === 0 ? 1 : -1;
      return { ...r, x: r.x + sign * convergence, y: r.y + sign * alignment };
    });
    const box = {
      x: Math.max(shifted[0].x, shifted[1].x),
      y: Math.max(shifted[0].y, shifted[1].y),
      width: Math.max(shifted[0].x + shifted[0].width, shifted[1].x + shifted[1].width) - Math.max(shifted[0].x, shifted[1].x),
      height: Math.max(shifted[0].y + shifted[0].height, shifted[1].y + shifted[1].height) - Math.max(shifted[0].y, shifted[1].y),
    };
    const squeezed = view === GlassesView.SIDE_BY_SIDE || view === GlassesView.OVER_UNDER;
    const half = [(layer.width * scale) / 2, (layer.height * scale) / 2];
    const rect = clampRect(
      view === GlassesView.SIDE_BY_SIDE
        ? { x: 0, y: box.y, width: layer.width * scale, height: box.height }
        : view === GlassesView.OVER_UNDER
          ? { x: box.x, y: 0, width: box.width, height: layer.height * scale }
          : box,
    );
    const out = layerPass(
      ctx,
      rect,
      views,
      "uniform vec2 u_shift; uniform vec4 u_box; uniform vec4 u_rects[2]; uniform int u_view; uniform vec2 u_half; uniform float u_green;",
      `  vec2 ql = p, qr = p;
  bool inLeft = true, inRight = true;
  if (u_view == ${GlassesView.SIDE_BY_SIDE}) { inLeft = p.x < u_half.x; inRight = !inLeft; ql.x = 2.0 * p.x; qr.x = 2.0 * (p.x - u_half.x); }
  else if (u_view == ${GlassesView.OVER_UNDER}) { inLeft = p.y < u_half.y; inRight = !inLeft; ql.y = 2.0 * p.y; qr.y = 2.0 * (p.y - u_half.y); }
  bool inBox = ${squeezed ? "true" : "all(greaterThanEqual(p, u_box.xy)) && all(lessThan(p, u_box.zw))"};
  ql -= u_shift;
  qr += u_shift;
  bool repeat = u_view == ${GlassesView.INTERLACED} || u_view >= ${GlassesView.RED_GREEN};
  if (repeat) {
    ql = clamp(ql, u_rects[0].xy + 0.5, u_rects[0].zw - 0.5);
    qr = clamp(qr, u_rects[1].xy + 0.5, u_rects[1].zw - 0.5);
  }
  bool okLeft = inLeft && (${squeezed ? "all(greaterThanEqual(ql + u_shift, u_box.xy)) && all(lessThan(ql + u_shift, u_box.zw))" : "inBox"});
  bool okRight = inRight && (${squeezed ? "all(greaterThanEqual(qr - u_shift, u_box.xy)) && all(lessThan(qr - u_shift, u_box.zw))" : "inBox"});
  vec4 l = okLeft ? at(0, ql) : vec4(0.0);
  vec4 r = okRight ? at(1, qr) : vec4(0.0);
  if (u_view == ${GlassesView.SIDE_BY_SIDE} || u_view == ${GlassesView.OVER_UNDER}) outColor = inLeft ? l : r;
  else if (u_view == ${GlassesView.INTERLACED}) outColor = mod(floor(p.y - u_box.y), 2.0) < 0.5 ? l : r;
  else if (u_view == ${GlassesView.DIFFERENCE}) outColor = vec4(abs(l.rgb - r.rgb), max(l.a, r.a));
  else {
    float a = 0.5 * (l.a + r.a);
    float yl = luma(straight(l));
    float yr = luma(straight(r));
    outColor = vec4(yl, u_green * yr, u_view == ${GlassesView.RED_GREEN} ? 0.0 : yr, 1.0) * a;
  }`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform2f(u("u_shift"), convergence, alignment);
        gl.uniform4f(u("u_box"), box.x, box.y, box.x + box.width, box.y + box.height);
        const rects = views.map(imageRect).flatMap((r) => [r.x, r.y, r.x + r.width, r.y + r.height]);
        gl.uniform4fv(u("u_rects"), rects);
        gl.uniform1i(u("u_view"), view);
        gl.uniform2f(u("u_half"), half[0], half[1]);
        gl.uniform1f(u("u_green"), view === GlassesView.RED_GREEN || view === GlassesView.RED_BLUE ? GLASSES_GREEN[view] : 0);      },
    );
    for (const v of views) ctx.pool.release(v.target);
    ctx.pool.release(input.target);
    return out;
  },
  { cacheable: false, scalable: true },
);

// CC Spotlight: a spot at Height (percent of the layer's height) above From, aimed at To on the layer, lighting each
// point by the cosine of its incidence times Intensity inside a cone of half-angle Cone Angle whose edge softens, in
// cosine, over Edge Softness of the way to the axis. The light's points are pixel corners. Light Only is the light
// itself, Light Add adds it to the layer, Light Shadow darkens the layer outside the cone by Intensity. The Gel modes
// render as their light modes.
registerStock("CC Spotlight", (input, p, ctx, layer) => {
  const scale = input.scale ?? 1;
  const from = p.vec(1, [layer.width / 4, layer.height / 4]);
  const to = p.vec(2, [layer.width / 2, layer.height / 2]);
  const height = (p.num(3, 50) / 100) * layer.height;
  const cone = (Math.min(180, Math.max(0, p.num(4, 25))) * Math.PI) / 180;
  const softness = Math.min(1, Math.max(0, p.num(5, 0.3)));
  const color = p.rgb(6, [1, 1, 1]);
  const intensity = Math.max(0, p.num(7, 100)) / 100;
  const mode = [1, 2, 3, 4, 1, 2, 3, 4][p.choice(8, 1) - 1] ?? 1;
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    "uniform vec2 u_from; uniform vec2 u_to; uniform float u_height; uniform float u_cosCone; uniform float u_soft; uniform vec3 u_color; uniform float u_intensity; uniform float u_scale; uniform int u_mode;",
    `  vec3 s = vec3(u_from, u_height);
  vec3 d = vec3(p / u_scale - 0.5, 0.0) - s;
  float dist = max(length(d), 1e-6);
  vec3 axis = vec3(u_to, 0.0) - s;
  float cosAxis = dot(d, axis) / (dist * max(length(axis), 1e-6));
  float edge = u_cosCone + u_soft * (1.0 - u_cosCone);
  float cone = edge > u_cosCone ? smoothstep(u_cosCone, edge, cosAxis) : step(u_cosCone, cosAxis);
  float k = cone * u_height / dist * u_intensity;
  vec4 c = at(0, p);
  if (u_mode == 1) {
    float a = clamp(k, 0.0, 1.0);
    outColor = vec4(u_color * a, a);
  } else if (u_mode == 4) {
    outColor = vec4(c.rgb * clamp(1.0 - u_intensity * (1.0 - cone), 0.0, 1.0), c.a);
  } else {
    outColor = vec4(min(c.rgb + u_color * k * c.a, vec3(c.a)), c.a);
  }`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_from"), from[0], from[1]);
      gl.uniform2f(u("u_to"), to[0], to[1]);
      gl.uniform1f(u("u_height"), height);
      gl.uniform1f(u("u_cosCone"), Math.cos(cone));
      gl.uniform1f(u("u_soft"), softness);
      gl.uniform3f(u("u_color"), color[0], color[1], color[2]);
      gl.uniform1f(u("u_intensity"), intensity);
      gl.uniform1f(u("u_scale"), scale);
      gl.uniform1i(u("u_mode"), mode);
    },
  );
  ctx.pool.release(input.target);
  return out;
});
