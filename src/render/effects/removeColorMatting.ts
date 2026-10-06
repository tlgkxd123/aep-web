// Remove Color Matting: un-mattes colours from a background colour,
// straight out = clamp((straight - bg (1 - a)) / a, 0, 1), as in After Effects' renders.
import { effectVector } from "../effectParams.ts";
import { registerEffect } from "../registry.ts";
import { mapPass, PASS_HEADER } from "./fxextraUtil.ts";

const RCM_FS = `${PASS_HEADER}
uniform vec3 u_background;
void main() {
  vec4 c = texture(u_source, v_uv);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  vec3 s = c.rgb / c.a;
  vec3 unmatted = clamp((s - u_background * (1.0 - c.a)) / c.a, 0.0, 1.0);
  outColor = vec4(unmatted * c.a, c.a);
}`;

registerEffect("ADBE Remove Color Matting", (input, effect, layer, time, ctx) => {
  const bg = effectVector(effect, 1, layer, time, [0, 0, 0, 1]);
  return mapPass(ctx, input, RCM_FS, (uniform) => ctx.gl.uniform3f(uniform("u_background"), bg[0], bg[1], bg[2]));
});
