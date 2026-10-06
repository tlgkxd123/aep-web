// Minimax: per-channel minimum/maximum over a square (or a horizontal/vertical run)
// of straight colour, transparent pixels counting as black, fitted to After
// Effects' renders.
import { effectNumber } from "../effectParams.ts";
import { registerEffect, type LayerImage, type RenderContext } from "../registry.ts";
import { grown, mapPass, PASS_HEADER } from "./fxextraUtil.ts";

const UNPREMULTIPLY_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_pad;
void main() {
  vec4 c = texture(u_source, v_uv);
  vec2 px = v_uv * u_size;
  if (px.x < u_pad || px.y < u_pad || px.x > u_size.x - u_pad || px.y > u_size.y - u_pad) c = vec4(0.0);
  outColor = vec4(c.a > 0.0 ? c.rgb / c.a : vec3(0.0), c.a);
}`;

const PREMULTIPLY_FS = `${PASS_HEADER}
void main() {
  vec4 c = texture(u_source, v_uv);
  outColor = vec4(c.rgb * c.a, c.a);
}`;

const MINMAX_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_pad;
uniform vec2 u_dir;
uniform int u_radius;
uniform int u_max;
uniform vec4 u_mask;
uniform int u_keepEdges;
vec4 at(vec2 q) {
  bool outside = q.x < u_pad || q.y < u_pad || q.x > u_size.x - u_pad || q.y > u_size.y - u_pad;
  if (!outside) return texture(u_source, q / u_size);
  if (u_keepEdges == 0) return vec4(0.0);
  return texture(u_source, clamp(q, vec2(u_pad + 0.5), u_size - u_pad - 0.5) / u_size);
}
void main() {
  vec4 here = texture(u_source, v_uv);
  vec4 acc = here;
  vec2 px = v_uv * u_size;
  for (int i = -u_radius; i <= u_radius; i++) {
    vec4 v = at(px + u_dir * float(i));
    acc = u_max == 1 ? max(acc, v) : min(acc, v);
  }
  outColor = mix(here, acc, u_mask);
}`;

/** Channel popup -> which straight RGBA channels are filtered. */
const CHANNELS: Record<number, [number, number, number, number]> = {
  1: [1, 1, 1, 0],
  2: [1, 1, 1, 1],
  3: [1, 0, 0, 0],
  4: [0, 1, 0, 0],
  5: [0, 0, 1, 0],
  6: [0, 0, 0, 1],
};

function filter(ctx: RenderContext, image: LayerImage, max: boolean, radius: number, direction: number, mask: number[], keepEdges: boolean): LayerImage {
  const dirs: [number, number][] = direction === 2 ? [[1, 0]] : direction === 3 ? [[0, 1]] : [[1, 0], [0, 1]];
  for (const dir of dirs) {
    image = mapPass(ctx, image, MINMAX_FS, (uniform) => {
      const gl = ctx.gl;
      gl.uniform2f(uniform("u_dir"), dir[0], dir[1]);
      gl.uniform1i(uniform("u_radius"), radius);
      gl.uniform1i(uniform("u_max"), max ? 1 : 0);
      gl.uniform4f(uniform("u_mask"), mask[0], mask[1], mask[2], mask[3]);
      gl.uniform1i(uniform("u_keepEdges"), keepEdges ? 1 : 0);
    });
  }
  return image;
}

registerEffect("ADBE Minimax", (input, effect, layer, time, ctx) => {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  const operation = num(1, 2);
  // A fractional radius covers the next whole pixel (5.5 behaves as 6).
  const radius = Math.min(256, Math.ceil(num(2, 0) - 1e-6));
  if (radius < 1) return input;
  const mask = CHANNELS[num(3, 1)] ?? CHANNELS[1];
  const direction = num(4, 1);
  const keepEdges = num(5, 0) !== 0;
  const order = operation === 1 ? [false] : operation === 2 ? [true] : operation === 3 ? [false, true] : [true, false];
  let image = mapPass(ctx, input, UNPREMULTIPLY_FS);
  // A maximum spreads colour (and alpha, when filtered) past the layer edge, where a following minimum still sees it.
  if (order.includes(true)) image = grown(ctx, image, radius);
  for (const max of order) image = filter(ctx, image, max, radius, direction, mask, keepEdges);
  return mapPass(ctx, image, PREMULTIPLY_FS);
});
