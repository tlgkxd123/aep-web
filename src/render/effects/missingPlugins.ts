// Effects whose plugins are not installed on the reference machine. After Effects
// opens such projects, reports the missing effects and renders each layer as if
// the effect were not there (verified with aerender: fxextra_missing_* fixtures).
// The browser does the same by default. With `approximateMissingPlugins`, rough,
// unverified look-alikes built from the stored parameters are drawn instead.
// Sapphire S_Blur and S_Shake have their own look-alikes in sapphire.ts.
import type { Layer, PropertyGroup } from "../../aep/model.ts";
import { effectNumber, effectVector } from "../effectParams.ts";
import { registerEffect, type LayerImage, type RenderContext } from "../registry.ts";
import { copyImage, gaussianBlur, grown, mapPass, PASS_HEADER } from "./fxextraUtil.ts";

type Approximation = (input: LayerImage, effect: PropertyGroup, layer: Layer, time: number, ctx: RenderContext) => LayerImage;

/** Smooth deterministic noise in [-1, 1]. */
function noise1(x: number, seed: number): number {
  const hash = (n: number) => {
    const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const i = Math.floor(x);
  const f = x - i;
  const t = (1 - Math.cos(f * Math.PI)) / 2;
  return hash(i) * (1 - t) + hash(i + 1) * t;
}

const UNMULT_FS = `${PASS_HEADER}
uniform float u_blend;
void main() {
  vec4 c = texture(u_source, v_uv);
  vec4 unmult = vec4(c.rgb, max(c.r, max(c.g, c.b)));
  outColor = mix(unmult, c, u_blend);
}`;

const SCALE_FS = `${PASS_HEADER}
uniform vec3 u_scale;
void main() {
  vec4 c = texture(u_source, v_uv);
  outColor = vec4(min(c.rgb * u_scale, vec3(c.a)), c.a);
}`;

const THRESHOLD_FS = `${PASS_HEADER}
uniform float u_threshold;
uniform vec3 u_color;
void main() {
  vec4 c = texture(u_source, v_uv);
  vec3 s = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  vec3 bright = max(s - u_threshold, 0.0) / max(1.0 - u_threshold, 1e-3);
  outColor = vec4(bright * u_color * c.a, max(bright.r, max(bright.g, bright.b)) * c.a);
}`;

const SCREEN_FS = `${PASS_HEADER}
uniform sampler2D u_extra0;
uniform float u_brightness;
void main() {
  vec4 base = texture(u_source, v_uv);
  vec4 glow = clamp(texture(u_extra0, v_uv) * u_brightness, 0.0, 1.0);
  outColor = base + glow - base * glow;
}`;

function glow(input: LayerImage, ctx: RenderContext, threshold: number, color: number[], widthX: number, widthY: number, brightness: number): LayerImage {
  const margin = Math.ceil(Math.max(widthX, widthY) * 1.5);
  const base = grown(ctx, input, margin);
  const bright = mapPass(ctx, copyImage(ctx, base), THRESHOLD_FS, (uniform) => {
    ctx.gl.uniform1f(uniform("u_threshold"), threshold);
    ctx.gl.uniform3f(uniform("u_color"), color[0], color[1], color[2]);
  });
  const blurred = gaussianBlur(ctx, bright, widthX / 2, widthY / 2);
  const out = mapPass(ctx, base, SCREEN_FS, (uniform) => ctx.gl.uniform1f(uniform("u_brightness"), brightness), [blurred]);
  ctx.pool.release(blurred.target);
  return out;
}

const approximations: Record<string, Approximation> = {
  "Fandev XMult": (input, effect, layer, time, ctx) =>
    mapPass(ctx, input, UNMULT_FS, (uniform) => ctx.gl.uniform1f(uniform("u_blend"), effectNumber(effect, 1, layer, time, 0) / 100)),
  S_Glow: (input, effect, layer, time, ctx) => {
    const num = (i: number, f: number) => effectNumber(effect, i, layer, time, f);
    const width = num(54, 20);
    return glow(input, ctx, num(52, 0.5), effectVector(effect, 51, layer, time, [1, 1, 1]), width * num(55, 1), width * num(56, 1), num(50, 1));
  },
  S_ZGlow: (input, effect, layer, time, ctx) => {
    const num = (i: number, f: number) => effectNumber(effect, i, layer, time, f);
    const width = num(52, 4);
    return glow(input, ctx, num(54, 0.5), effectVector(effect, 51, layer, time, [1, 1, 1]), width * num(70, 1), width * num(71, 1), num(50, 1));
  },
  S_Flicker: (input, effect, layer, time, ctx) => {
    const num = (i: number, f: number) => effectNumber(effect, i, layer, time, f);
    const amp = num(50, 0.2);
    const seed = num(63, 0);
    const luma = num(51, 1) * noise1(time * num(53, 6), seed);
    const wave = (phase: number) => num(54, 0) * Math.sin(2 * Math.PI * (time * num(55, 1) + phase));
    const colorAmp = num(52, 0);
    const scale = [0, 1, 2].map(
      (c) => num(62, 1) * (1 + amp * num(59 + c, 1) * (luma + wave(num(56 + c, 0)) + colorAmp * noise1(time * num(53, 6), seed + 3 + c))),
    );
    return mapPass(ctx, input, SCALE_FS, (uniform) => ctx.gl.uniform3f(uniform("u_scale"), Math.max(0, scale[0]), Math.max(0, scale[1]), Math.max(0, scale[2])));
  },
};

const NAMES: Record<string, string> = {
  "Fandev XMult": "XMult",
  S_Glow: "Sapphire S_Glow",
  S_ZGlow: "Sapphire S_ZGlow",
  S_Flicker: "Sapphire S_Flicker",
};

for (const [matchName, approximate] of Object.entries(approximations)) {
  const name = NAMES[matchName];
  registerEffect(matchName, (input, effect, layer, time, ctx) => {
    if (!ctx.options.approximateMissingPlugins) {
      ctx.warn(`${name} plugin is not installed; After Effects skips it`);
      return input;
    }
    ctx.warn(`${name} plugin is not installed; drawn with an unverified look-alike`);
    return approximate(input, effect, layer, time, ctx);
  });
}
