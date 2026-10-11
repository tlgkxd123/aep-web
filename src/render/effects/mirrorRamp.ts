// Mirror (ADBE Mirror) and Gradient Ramp (ADBE Ramp), one GPU pass each, in
// layer pixel coordinates (pixel centres at +0.5, y down; effect points are in
// layer pixels, times the image's scale at a reduced resolution).
//
// Mirror: the line through Reflection Center at Reflection Angle splits the
// layer; the side its normal (cos a, sin a) points into shows the other side
// reflected. After Effects places that line with pixel centres on whole numbers,
// half a pixel from where other effects' points fall (measured on its renders).
// Gradient Ramp: the layer's colour becomes the ramp from Start Color at Start
// of Ramp to End Color at End of Ramp (linear: along the line between them,
// radial: by distance), keeping the layer's alpha; Blend With Original mixes the
// original back in.
import { effectNumber, effectVector } from "../effectParams.ts";
import { registerEffect } from "../registry.ts";
import { mapPass, PASS_HEADER } from "./fxextraUtil.ts";

/** Converts between target pixels (GL rows) and layer pixels. */
const COORDS = `
uniform vec2 u_size;
uniform float u_pad;
uniform vec2 u_origin;
vec2 layerPoint() { return vec2(gl_FragCoord.x - u_pad + u_origin.x, u_size.y - gl_FragCoord.y - u_pad + u_origin.y); }
vec2 targetUv(vec2 q) { return vec2(q.x - u_origin.x + u_pad, u_size.y - (q.y - u_origin.y + u_pad)) / u_size; }
`;

const MIRROR_FS = `${PASS_HEADER}${COORDS}
uniform vec2 u_center;
uniform vec2 u_normal;
void main() {
  vec2 p = layerPoint();
  float d = dot(p - u_center, u_normal);
  outColor = d > 0.0 ? texture(u_source, targetUv(p - 2.0 * d * u_normal)) : texture(u_source, v_uv);
}`;

const RAMP_FS = `${PASS_HEADER}${COORDS}
uniform vec2 u_start;
uniform vec2 u_end;
uniform vec3 u_startColor;
uniform vec3 u_endColor;
uniform int u_radial;
uniform float u_blend;
void main() {
  vec4 original = texture(u_source, v_uv);
  vec2 p = layerPoint();
  vec2 axis = u_end - u_start;
  float len2 = max(dot(axis, axis), 1e-6);
  float t = u_radial == 1 ? length(p - u_start) / sqrt(len2) : dot(p - u_start, axis) / len2;
  vec3 ramp = mix(u_startColor, u_endColor, clamp(t, 0.0, 1.0));
  vec4 colored = vec4(ramp * original.a, original.a);
  outColor = mix(colored, original, u_blend);
}`;

registerEffect("ADBE Mirror", (input, effect, layer, time, ctx) => {
  const k = input.scale ?? 1;
  const [cx, cy] = effectVector(effect, 1, layer, time, [layer.width / 2, layer.height / 2]);
  const angle = (effectNumber(effect, 2, layer, time, 0) * Math.PI) / 180;
  return mapPass(ctx, input, MIRROR_FS, (u) => {
    ctx.gl.uniform2f(u("u_origin"), input.origin[0], input.origin[1]);
    ctx.gl.uniform2f(u("u_center"), (cx + 0.5) * k, (cy + 0.5) * k);
    ctx.gl.uniform2f(u("u_normal"), Math.cos(angle), Math.sin(angle));
  });
}, { cacheable: true, scalable: true });

registerEffect("ADBE Ramp", (input, effect, layer, time, ctx) => {
  const k = input.scale ?? 1;
  const start = effectVector(effect, 1, layer, time, [0, 0]);
  const startColor = effectVector(effect, 2, layer, time, [0, 0, 0, 1]);
  const end = effectVector(effect, 3, layer, time, [0, layer.height]);
  const endColor = effectVector(effect, 4, layer, time, [1, 1, 1, 1]);
  const radial = effectNumber(effect, 5, layer, time, 1) === 2;
  if (effectNumber(effect, 6, layer, time, 0) > 0) ctx.warn("Gradient Ramp: Ramp Scatter is not rendered");
  const blend = Math.min(1, Math.max(0, effectNumber(effect, 7, layer, time, 0) / 100));
  return mapPass(ctx, input, RAMP_FS, (u) => {
    ctx.gl.uniform2f(u("u_origin"), input.origin[0], input.origin[1]);
    ctx.gl.uniform2f(u("u_start"), start[0] * k, start[1] * k);
    ctx.gl.uniform2f(u("u_end"), end[0] * k, end[1] * k);
    ctx.gl.uniform3f(u("u_startColor"), startColor[0], startColor[1], startColor[2]);
    ctx.gl.uniform3f(u("u_endColor"), endColor[0], endColor[1], endColor[2]);
    ctx.gl.uniform1i(u("u_radial"), radial ? 1 : 0);
    ctx.gl.uniform1f(u("u_blend"), blend);
  });
}, { cacheable: true, scalable: true });
