// Sapphire S_Glow, S_ZGlow and S_Flicker look-alikes, drawn and skipped as the other Sapphire look-alikes
// (sapphire.ts).
//
// The glows take the light of the pixels brighter than Threshold (after adding Threshold Add Color), spread it
// by Gaussians (S_Glow: a bright core with a long tail, GLOW_FALLOFF; per colour channel when the channel widths
// differ), tint it by Color times Brightness and lay it over the source by Combine. Without Expand Borders the
// result keeps the layer's frame, the picture beyond it transparent or reflected by Edge Mode; with it the glow
// spreads out of the frame. S_ZGlow cuts the light into depth slices by its Z Buffer layer (the source itself
// when none is chosen) and spreads each slice by its own width and colour, from Near to Far.
import type { Layer, PropertyGroup } from "../../aep/model.ts";
import { effectNumber, effectVector } from "../effectParams.ts";
import type { LayerImage, RenderContext } from "../registry.ts";
import { copyImage, mapPass, PASS_HEADER } from "./fxextraUtil.ts";
import { containingComp, registerSapphire, sapphireBlur } from "./sapphire.ts";
import { channelGroups, Filter, flickerGains, GLOW_FALLOFF, zSliceCount } from "./sapphireMath.ts";
import { imageRect, layerPass, layerRect, unionRect, type Rect } from "./stockUtil.ts";

type RGB = [number, number, number];

/** A spread image of light and what each of its channels adds to the glow. */
interface Light {
  image: LayerImage;
  weight: RGB;
}

/** Where a glow may draw: inside `bounds` (beyond them transparent, or reflected), or anywhere when null. */
interface GlowFrame {
  bounds: Rect | null;
  reflect: boolean;
}

const LIGHT_LIB = `
uniform float u_threshold;
uniform vec3 u_addColor;
uniform float u_fromAlpha;
vec4 lightOf(vec4 c) {
  vec3 s = mix((c.a > 0.0 ? c.rgb / c.a : vec3(0.0)) + u_addColor, vec3(1.0), clamp(u_fromAlpha, 0.0, 1.0));
  float l = max(s.r, max(s.g, s.b));
  vec3 light = l > u_threshold ? s * ((l - u_threshold) / max(l, 1e-4)) * c.a : vec3(0.0);
  return vec4(light, max(light.r, max(light.g, light.b)));
}`;

function setLight(ctx: RenderContext, u: (name: string) => WebGLUniformLocation | null, threshold: number, addColor: number[], fromAlpha: number): void {
  ctx.gl.uniform1f(u("u_threshold"), threshold);
  ctx.gl.uniform3f(u("u_addColor"), addColor[0] ?? 0, addColor[1] ?? 0, addColor[2] ?? 0);
  ctx.gl.uniform1f(u("u_fromAlpha"), fromAlpha);
}

/**
 * Spreads `light` by each falloff (fractions of the widths, image pixels per channel) scaled by `wx`, `wy` per
 * axis, one blur per group of channels sharing a width. Releases `light`.
 */
function spread(ctx: RenderContext, light: LayerImage, widths: number[], wx: number, wy: number, falloff: readonly { width: number; weight: number }[], frame: GlowFrame, tint: RGB = [1, 1, 1]): Light[] {
  const bounds = frame.bounds && { origin: [frame.bounds.x, frame.bounds.y] as [number, number], width: frame.bounds.width, height: frame.bounds.height };
  const lights: Light[] = [];
  for (const group of channelGroups(widths)) {
    for (const f of falloff) {
      const width = group.width * f.width;
      const image = sapphireBlur(ctx, copyImage(ctx, light), {
        widthX: width * Math.max(0, wx),
        widthY: width * Math.max(0, wy),
        filter: Filter.GAUSS,
        repeatEdges: !!bounds && frame.reflect,
        reflectEdges: frame.reflect,
        bounds: bounds ?? undefined,
        brightness: 1,
        scaleOpacity: true,
        mixWithSource: 0,
      });
      lights.push({ image, weight: group.channels.map((on, c) => (on ? f.weight * tint[c] : 0)) as RGB });
    }
  }
  ctx.pool.release(light.target);
  return lights;
}

/** Most lights summed in one pass (texture units). */
const SUM_BATCH = 12;

/** The weighted sum of `lights` over `rect`; releases them. */
function sumLights(ctx: RenderContext, rect: Rect, lights: Light[], scale: number | undefined): LayerImage {
  let rest = lights;
  for (;;) {
    const batch = rest.slice(0, SUM_BATCH);
    rest = rest.slice(SUM_BATCH);
    const terms = batch.map((_, i) => `  g += at(${i}, p).rgb * u_w[${i}];`).join("\n");
    const sum = layerPass(
      ctx,
      rect,
      batch.map((l) => l.image),
      `uniform vec3 u_w[${batch.length}];`,
      `  vec3 g = vec3(0.0);\n${terms}\n  outColor = vec4(g, max(g.r, max(g.g, g.b)));`,
      (u) => ctx.gl.uniform3fv(u("u_w"), batch.flatMap((l) => l.weight)),
      scale,
    );
    for (const l of batch) ctx.pool.release(l.image.target);
    if (!rest.length) return sum;
    rest = [{ image: sum, weight: [1, 1, 1] }, ...rest];
  }
}

/** S_Glow's Combine popup. */
const Combine = { MULT: 1, ADD: 2, SCREEN: 3, DIFFERENCE: 4, OVERLAY: 5 } as const;

interface GlowLook {
  /** Color times Brightness. */
  color: number[];
  combine: number;
  /** Glow Under Source: 1 lights the source's opaque parts too; 0 only around them. */
  under: number;
  affectAlpha: number;
  sourceOpacity: number;
  /** Opacity "All Opaque": the result over black, fully opaque. */
  opaque: boolean;
}

const COMBINE_DECLS = `
uniform vec3 u_color;
uniform int u_combine;
uniform float u_under;
uniform float u_affectAlpha;
uniform float u_sourceOpacity;
uniform int u_opaque;`;

const COMBINE_BODY = `
  vec4 src = at(0, p);
  vec4 s = src * clamp(u_sourceOpacity, 0.0, 1.0);
  vec3 g = at(1, p).rgb * u_color * (1.0 - (1.0 - clamp(u_under, 0.0, 1.0)) * src.a);
  vec3 gc = clamp(g, 0.0, 1.0);
  vec3 rgb;
  if (u_combine == ${Combine.MULT}) rgb = s.rgb * gc;
  else if (u_combine == ${Combine.ADD}) rgb = s.rgb + g;
  else if (u_combine == ${Combine.DIFFERENCE}) rgb = abs(s.rgb - g);
  else if (u_combine == ${Combine.OVERLAY}) rgb = mix(2.0 * s.rgb * gc, 1.0 - 2.0 * (1.0 - s.rgb) * (1.0 - gc), step(0.5, s.rgb));
  else rgb = s.rgb + gc - s.rgb * gc;
  float ga = clamp(max(g.r, max(g.g, g.b)), 0.0, 1.0);
  float a = u_opaque == 1 ? 1.0 : clamp(s.a + ga * max(u_affectAlpha, 0.0) * (1.0 - s.a), 0.0, 1.0);
  outColor = vec4(clamp(rgb, vec3(0.0), vec3(a)), a);`;

/** The source with its glow `light` laid over it in `rect`; releases both. */
function combineGlow(ctx: RenderContext, input: LayerImage, light: LayerImage, rect: Rect, look: GlowLook): LayerImage {
  const out = layerPass(
    ctx,
    rect,
    [input, light],
    COMBINE_DECLS,
    COMBINE_BODY,
    (u) => {
      const gl = ctx.gl;
      gl.uniform3f(u("u_color"), look.color[0] ?? 1, look.color[1] ?? 1, look.color[2] ?? 1);
      gl.uniform1i(u("u_combine"), look.combine);
      gl.uniform1f(u("u_under"), look.under);
      gl.uniform1f(u("u_affectAlpha"), look.affectAlpha);
      gl.uniform1f(u("u_sourceOpacity"), look.sourceOpacity);
      gl.uniform1i(u("u_opaque"), look.opaque ? 1 : 0);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  ctx.pool.release(light.target);
  return out;
}

const scaled = (c: number[], k: number): RGB => [(c[0] ?? 1) * k, (c[1] ?? 1) * k, (c[2] ?? 1) * k];

/** The rectangle the spread lights cover: the frame, or all of them when the glow expands. */
function lightsRect(frame: GlowFrame, input: LayerImage, lights: Light[]): Rect {
  return frame.bounds ?? lights.reduce((r, l) => unionRect(r, imageRect(l.image)), imageRect(input));
}

function sGlow(input: LayerImage, effect: PropertyGroup, layer: Layer, time: number, ctx: RenderContext): LayerImage {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  const k = input.scale ?? 1;
  if (num(1, 0) || num(2, 0)) ctx.warn("Sapphire S_Glow: the Background and Matte from Layer inputs are not drawn");
  if (num(103, 0) > 0) ctx.warn("Sapphire S_Glow: Atmosphere is not drawn");
  const frameRect = unionRect(layerRect(layer, input), imageRect(input));
  const frame: GlowFrame = { bounds: num(68, 0) ? null : frameRect, reflect: Math.round(num(102, 2)) === 2 };
  const light = layerPass(ctx, frame.bounds ?? imageRect(input), [input], LIGHT_LIB, "  outColor = lightOf(at(0, p));", (u) =>
    setLight(ctx, u, num(52, 0.5), effectVector(effect, 53, layer, time, [0, 0, 0]), num(62, 0)),
    input.scale,
  );
  // Show: Threshold.
  if (Math.round(num(100, 1)) === 2) {
    ctx.pool.release(input.target);
    return light;
  }
  const width = Math.max(0, num(54, 20)) * k;
  const lights = spread(ctx, light, [57, 58, 59].map((i) => width * Math.max(0, num(i, 1))), num(55, 1), num(56, 1), GLOW_FALLOFF, frame);
  const rect = lightsRect(frame, input, lights);
  const sum = sumLights(ctx, rect, lights, input.scale);
  return combineGlow(ctx, input, sum, rect, {
    color: scaled(effectVector(effect, 51, layer, time, [1, 1, 1]), num(50, 1)),
    combine: Math.round(num(101, Combine.SCREEN)),
    under: num(63, 1),
    affectAlpha: num(61, 1),
    sourceOpacity: num(65, 1),
    opaque: Math.round(num(69, 2)) === 1,
  });
}

/** S_ZGlow's spread per slice: one Gaussian half its width. */
const ZGLOW_FALLOFF = [{ width: 0.5, weight: 1 }] as const;

const ZSLICE_DECLS = `${LIGHT_LIB}
uniform int u_hasZ;
uniform vec2 u_zScale;
uniform vec2 u_zOffset;
uniform int u_zAlpha;
uniform int u_whiteNear;
uniform vec2 u_zRange;
uniform float u_last;
uniform float u_slice;`;

const ZSLICE_BODY = `
  vec4 c = at(0, p);
  vec4 zc = u_hasZ == 1 ? at(1, p * u_zScale + u_zOffset) : c;
  float z = u_zAlpha == 1 ? zc.a : luma(straight(zc));
  if (u_whiteNear == 1) z = 1.0 - z;
  z = clamp((z - u_zRange.x) / max(u_zRange.y - u_zRange.x, 1e-4), 0.0, 1.0);
  outColor = lightOf(c) * max(0.0, 1.0 - abs(z * u_last - u_slice));`;

function sZGlow(input: LayerImage, effect: PropertyGroup, layer: Layer, time: number, ctx: RenderContext): LayerImage {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  const vec = (index: number) => effectVector(effect, index, layer, time, [1, 1, 1]);
  const k = input.scale ?? 1;
  const index = Math.round(num(1, 0));
  const zLayer = index > 0 ? containingComp(ctx, layer)?.layers.find((l) => l.index === index && l !== layer) : undefined;
  const zImage = zLayer ? ctx.layerImage(zLayer, time, true) : null;
  // The Z Buffer layer is stretched over this layer's frame.
  const own = layerRect(layer, input);
  let zScale = [1, 1];
  let zOffset = [0, 0];
  if (zImage && zLayer) {
    const zRect = layerRect(zLayer, zImage);
    zScale = [zRect.width / own.width, zRect.height / own.height];
    zOffset = [zRect.x - own.x * zScale[0], zRect.y - own.y * zScale[1]];
  }
  const frameRect = unionRect(own, imageRect(input));
  const frame: GlowFrame = { bounds: num(78, 0) ? null : frameRect, reflect: false };
  const count = zSliceCount(num(59, 5));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const nearColor = scaled(vec(61), num(60, 1));
  const farColor = scaled(vec(66), num(65, 1));
  const lights: Light[] = [];
  for (let slice = 0; slice < count; slice++) {
    const t = slice / (count - 1);
    const light = layerPass(
      ctx,
      frame.bounds ?? imageRect(input),
      zImage ? [input, zImage] : [input],
      ZSLICE_DECLS,
      ZSLICE_BODY,
      (u) => {
        const gl = ctx.gl;
        setLight(ctx, u, num(54, 0.5), effectVector(effect, 55, layer, time, [0, 0, 0]), 0);
        gl.uniform1i(u("u_hasZ"), zImage ? 1 : 0);
        gl.uniform2f(u("u_zScale"), zScale[0], zScale[1]);
        gl.uniform2f(u("u_zOffset"), zOffset[0], zOffset[1]);
        gl.uniform1i(u("u_zAlpha"), Math.round(num(77, 1)) === 2 ? 1 : 0);
        gl.uniform1i(u("u_whiteNear"), Math.round(num(56, 1)) === 2 ? 1 : 0);
        gl.uniform2f(u("u_zRange"), num(57, 0), num(58, 1));
        gl.uniform1f(u("u_last"), count - 1);
        gl.uniform1f(u("u_slice"), slice);
      },
      input.scale,
    );
    const width = Math.max(0, lerp(num(52, 4), num(53, 96), t)) * k;
    const widths = [0, 1, 2].map((c) => width * Math.max(0, num(72 + c, 1) * lerp(num(62 + c, 1), num(67 + c, 1), t)));
    const tint = [0, 1, 2].map((c) => lerp(nearColor[c], farColor[c], t)) as RGB;
    lights.push(...spread(ctx, light, widths, num(70, 1), num(71, 1), ZGLOW_FALLOFF, frame, tint));
  }
  if (zImage) ctx.pool.release(zImage.target);
  const rect = lightsRect(frame, input, lights);
  const sum = sumLights(ctx, rect, lights, input.scale);
  return combineGlow(ctx, input, sum, rect, {
    color: scaled(vec(51), num(50, 1)),
    combine: Combine.SCREEN,
    under: 1,
    affectAlpha: num(75, 1),
    sourceOpacity: num(76, 1),
    opaque: Math.round(num(79, 2)) === 1,
  });
}

const GAIN_FS = `${PASS_HEADER}
uniform vec3 u_gain;
void main() {
  vec4 c = texture(u_source, v_uv);
  outColor = vec4(min(c.rgb * u_gain, vec3(c.a)), c.a);
}`;

function sFlicker(input: LayerImage, effect: PropertyGroup, layer: Layer, time: number, ctx: RenderContext): LayerImage {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  const gains = flickerGains(
    {
      amplitude: num(50, 0.2),
      lumaAmp: num(51, 1),
      colorAmp: num(52, 0),
      frequency: num(53, 6),
      waveAmp: num(54, 0),
      waveFreq: num(55, 1),
      wavePhase: [num(56, 0), num(57, 0), num(58, 0)],
      channelAmp: [num(59, 1), num(60, 1), num(61, 1)],
      brightness: num(62, 1),
      seed: num(63, 0),
    },
    time,
  );
  if (gains.every((g) => g === 1)) return input;
  return mapPass(ctx, input, GAIN_FS, (u) => ctx.gl.uniform3f(u("u_gain"), gains[0], gains[1], gains[2]));
}

registerSapphire("S_Glow", "Sapphire S_Glow", sGlow, { cacheable: true, scalable: true });
// S_ZGlow reads its Z Buffer layer; S_Flicker changes with the time itself.
registerSapphire("S_ZGlow", "Sapphire S_ZGlow", sZGlow, { cacheable: false, scalable: true });
registerSapphire("S_Flicker", "Sapphire S_Flicker", sFlicker, { cacheable: false, scalable: true });
