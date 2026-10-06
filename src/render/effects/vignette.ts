// CC Vignette: natural (cos^4) lens fall-off around a centre, fitted to After
// Effects' renders. The field of view spans half the layer width per half angle.
import { effectNumber, effectVector } from "../effectParams.ts";
import { registerEffect } from "../registry.ts";
import { mapPass, PASS_HEADER } from "./fxextraUtil.ts";

const VIGNETTE_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_pad;
uniform vec2 u_center;
uniform float u_amount;
uniform float u_tanHalf;
uniform float u_pin;
void main() {
  vec4 c = texture(u_source, v_uv);
  // Layer pixel position, y down.
  vec2 p = vec2(v_uv.x * u_size.x - u_pad, (1.0 - v_uv.y) * u_size.y - u_pad);
  float t = length(p - u_center) / (0.5 * (u_size.x - 2.0 * u_pad)) * u_tanHalf;
  float cos2 = 1.0 / (1.0 + t * t);
  float f = 1.0 - u_amount * (1.0 - cos2 * cos2);
  vec3 s = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  // Pin Highlights gives back a share of the lost light that grows with the cube of the
  // pixel's channel mean.
  float m = (s.r + s.g + s.b) / 3.0;
  vec3 o = s * (f + (1.0 - f) * u_pin * m * m * m);
  outColor = vec4(clamp(o, 0.0, 1.0) * c.a, c.a);
}`;

registerEffect("CS Vignette", (input, effect, layer, time, ctx) => {
  const amount = effectNumber(effect, 1, layer, time, 50) / 100;
  const angle = effectNumber(effect, 2, layer, time, 45);
  let center = effectVector(effect, 3, layer, time, [input.width / 2, input.height / 2]);
  // An untouched centre is stored as a percentage of the layer.
  if (Math.abs(center[0]) > input.width * 10 || Math.abs(center[1]) > input.height * 10) center = [center[0] / 100, center[1] / 100];
  const pin = effectNumber(effect, 5, layer, time, 0) / 100;
  if (!amount) return input;
  return mapPass(ctx, input, VIGNETTE_FS, (uniform) => {
    const gl = ctx.gl;
    gl.uniform2f(uniform("u_center"), center[0] - input.origin[0], center[1] - input.origin[1]);
    gl.uniform1f(uniform("u_amount"), amount);
    gl.uniform1f(uniform("u_tanHalf"), Math.tan(((angle / 2) * Math.PI) / 180));
    gl.uniform1f(uniform("u_pin"), Math.pow(Math.max(0, pin), 0.72));
  });
});
