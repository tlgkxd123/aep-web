// Polar Coordinates (ADBE Polar Coordinates), fitted to After Effects renders.
//
// AE maps pixel indices (pixel centres at integers, y down) around c = (W/2, H/2).
// The sample position for output pixel p is mix(p, q, interpolation), where
//   Rect to Polar: q = (θ / 2π · (W − 1), 2·|p − c|), θ measured from straight up, counter-clockwise
//     (the column through c takes θ = 2π above it and π below it);
//   Polar to Rect: q = c − (p.y / H · |c|) · (cos a, sin a), a = p.x / W · 2π (0 = left, clockwise).
// The source is sampled bilinearly and is transparent outside the layer. The mapping follows the image's own
// size, so it holds at a reduced resolution too.
import { effectNumber } from "../effectParams.ts";
import { registerEffect } from "../registry.ts";

const POLAR_FS = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_size;
uniform float u_pad;
uniform float u_amount;
uniform int u_toRect;
in vec2 v_uv;
out vec4 color;
const float TAU = 6.283185307179586;
void main() {
  vec2 full = u_size + 2.0 * u_pad;
  vec2 p = vec2(gl_FragCoord.x, full.y - gl_FragCoord.y) - u_pad - 0.5;
  if (any(lessThan(p, vec2(0.0))) || any(greaterThan(p, u_size - 1.0))) {
    color = vec4(0.0);
    return;
  }
  vec2 c = u_size * 0.5;
  vec2 q;
  if (u_toRect == 1) {
    float a = p.x / u_size.x * TAU;
    float r = p.y / u_size.y * length(c);
    q = c - r * vec2(cos(a), sin(a));
  } else {
    vec2 d = p - c;
    float a = atan(-d.x, -d.y);
    if (d.x == 0.0) a = d.y > 0.0 ? 0.5 * TAU : TAU;
    else if (a < 0.0) a += TAU;
    q = vec2(a / TAU * (u_size.x - 1.0), 2.0 * length(d));
  }
  vec2 s = mix(p, q, u_amount) + 0.5;
  color = texture(u_source, vec2((s.x + u_pad) / full.x, 1.0 - (s.y + u_pad) / full.y));
}`;

registerEffect("ADBE Polar Coordinates", (input, effect, layer, time, ctx) => {
  const amount = Math.min(1, Math.max(0, effectNumber(effect, 1, layer, time, 0)));
  const toRect = effectNumber(effect, 2, layer, time, 1) === 2;
  if (amount === 0) return input;
  const out = ctx.pool.acquire(input.width + 2 * ctx.pad, input.height + 2 * ctx.pad);
  ctx.pass(ctx.program(POLAR_FS), out, [input.target], (u) => {
    ctx.gl.uniform1i(u("u_source"), 0);
    ctx.gl.uniform2f(u("u_size"), input.width, input.height);
    ctx.gl.uniform1f(u("u_pad"), ctx.pad);
    ctx.gl.uniform1f(u("u_amount"), amount);
    ctx.gl.uniform1i(u("u_toRect"), toRect ? 1 : 0);
  });
  ctx.pool.release(input.target);
  return { ...input, target: out };
}, { cacheable: true, scalable: true });
