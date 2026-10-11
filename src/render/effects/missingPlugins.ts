// Effects whose plugins are not installed on the reference machine. After Effects
// opens such projects, reports the missing effects and renders each layer as if
// the effect were not there (verified with aerender: fxextra_missing_* fixtures).
// The browser does the same by default. With `approximateMissingPlugins`, rough,
// unverified look-alikes built from the stored parameters are drawn instead.
// The Sapphire effects have their own look-alikes in sapphire.ts and sapphireLight.ts.
import type { Layer, PropertyGroup } from "../../aep/model.ts";
import { effectNumber } from "../effectParams.ts";
import { registerEffect, type LayerImage, type RenderContext } from "../registry.ts";
import { mapPass, PASS_HEADER } from "./fxextraUtil.ts";

type Approximation = (input: LayerImage, effect: PropertyGroup, layer: Layer, time: number, ctx: RenderContext) => LayerImage;

const UNMULT_FS = `${PASS_HEADER}
uniform float u_blend;
void main() {
  vec4 c = texture(u_source, v_uv);
  vec4 unmult = vec4(c.rgb, max(c.r, max(c.g, c.b)));
  outColor = mix(unmult, c, u_blend);
}`;

const approximations: Record<string, Approximation> = {
  "Fandev XMult": (input, effect, layer, time, ctx) =>
    mapPass(ctx, input, UNMULT_FS, (uniform) => ctx.gl.uniform1f(uniform("u_blend"), effectNumber(effect, 1, layer, time, 0) / 100)),
};

const NAMES: Record<string, string> = {
  "Fandev XMult": "XMult",
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
