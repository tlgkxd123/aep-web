// Nested, moving copies of the source image, projected as rotating cards. The stack
// composites from the largest to the smallest, keeping each portal visible inside the next.
import { registerEffect } from "../registry.ts";
import { imageRect, layerPass, params } from "./stockUtil.ts";

// One background plane plus the requested cards. The last card grows into the stack
// as the first exits, so all indices shift by one at a loop boundary.
const MAX_CARDS = 17;
const DECLS = `
uniform vec2 u_dimensions;
uniform vec2 u_center;
uniform vec3 u_x[17];
uniform vec3 u_y[17];
uniform vec3 u_centers[17];
uniform vec4 u_sizes[17];
uniform int u_count;
uniform float u_shadow;
uniform float u_edge;
uniform float u_background;
vec4 at(int i, vec2 q);
`;

const BODY = `
  vec2 screen = (p - u_center) / u_dimensions.y;
  vec3 ray = vec3(screen, 3.0);
  vec4 color = at(0, p) * u_background;
  for (int i = 0; i < 17; i++) {
    if (i >= u_count) break;
    vec3 normal = cross(u_x[i], u_y[i]);
    float denominator = dot(normal, ray);
    if (denominator <= 0.001) continue;
    float distance = dot(normal, u_centers[i]) / denominator;
    if (distance <= 0.0) continue;
    vec3 hit = distance * ray - u_centers[i];
    vec2 local = vec2(dot(hit, u_x[i]), dot(hit, u_y[i]));
    vec2 halfSize = u_sizes[i].xy * 0.5;
    vec2 edge = abs(local) - halfSize;
    float d = max(edge.x, edge.y);
    float aa = max(fwidth(d), 0.0001);
    float cover = 1.0 - smoothstep(-aa, aa, d);
    // The arriving background extends across the frame before the departing one
    // fades. No border, shadow or brightness step remains on that plane.
    float frame = smoothstep(0.05, 0.15, u_sizes[i].w);
    if (u_background > 0.0) cover = mix(1.0, cover, frame);
    vec2 texel = 0.5 / u_dimensions;
    vec2 uv = clamp(local / u_sizes[i].xy + 0.5, texel, 1.0 - texel);
    vec4 card = at(0, uv * u_dimensions);
    float fade = u_sizes[i].z;
    // Contact shadow and a restrained bright rim separate the repeated image planes.
    float shadow = exp(-max(d, 0.0) * 100.0 / u_sizes[i].y) * u_shadow * fade * card.a * (1.0 - cover) * frame;
    color.rgb *= 1.0 - shadow;
    float rim = exp(-abs(d) * 240.0 / u_sizes[i].y) * u_edge * frame;
    card.rgb = min(vec3(card.a), card.rgb + vec3(rim * card.a));
    card *= cover * fade;
    color = card + color * (1.0 - card.a);
  }
  outColor = color;
`;

registerEffect("AEPW Portal Cards", (input, effect, layer, time, ctx) => {
  const p = params(effect, layer, time);
  const bounded = (index: number, fallback: number, min: number, max: number) => Math.max(min, Math.min(max, p.num(index, fallback)));
  const count = Math.round(bounded(1, 7, 1, MAX_CARDS - 1)) + 1;
  const spacing = bounded(2, 62, 25, 90) / 100;
  const evolution = p.num(4, 0) / 360;
  const travel = time * bounded(3, 18, -200, 200) / 100 + evolution;
  const phase = travel - Math.floor(travel);
  const pulse = bounded(15, 0, 0, 100) / 100;
  const zoom = bounded(9, 100, 10, 400) / 100 * (1 + pulse * 0.18);
  const k = input.scale ?? 1;
  const width = Math.max(1, layer.width || input.width / k) * k;
  const height = Math.max(1, layer.height || input.height / k) * k;
  const aspect = width / height;
  const radians = Math.PI / 180;
  const yaw = bounded(5, 38, -85, 85) * radians;
  const pitch = bounded(6, 14, -85, 85) * radians;
  const twist = bounded(7, 8, -180, 180) * radians;
  const drift = bounded(8, 18, 0, 100) / 100;
  const axesX = new Float32Array(MAX_CARDS * 3);
  const axesY = new Float32Array(MAX_CARDS * 3);
  const centers = new Float32Array(MAX_CARDS * 3);
  const sizes = new Float32Array(MAX_CARDS * 4);
  const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };
  for (let i = 0; i < count; i++) {
    const depth = i - phase;
    const size = zoom * spacing ** depth;
    const motion = depth * 1.45;
    const rotation = smooth(depth / 0.8);
    const y = yaw * Math.sin(motion) * rotation;
    const x = pitch * Math.cos(motion * 0.83) * rotation;
    const z = twist * Math.sin(motion * 0.61) * rotation;
    const cy = Math.cos(y), sy = Math.sin(y), cx = Math.cos(x), sx = Math.sin(x), cz = Math.cos(z), sz = Math.sin(z);
    axesX.set([cz * cy, sz * cy, -sy], i * 3);
    axesY.set([cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx], i * 3);
    centers.set([drift * size * Math.sin(motion * 0.7) * rotation, drift * size * 0.45 * Math.cos(motion * 0.9) * rotation, 3], i * 3);
    // Opaque interiors keep source brightness. Only the terminal card enters with
    // a crossfade; the departing background fades after its successor covers it.
    const fade = i === 0 ? smooth((1 - phase) / 0.02) : i === count - 1 ? smooth(phase) : 1;
    sizes.set([aspect * size, size, fade, depth], i * 4);
  }
  const out = layerPass(ctx, imageRect(input), [input], DECLS, BODY, (u) => {
    const gl = ctx.gl;
    gl.uniform2f(u("u_dimensions"), width, height);
    gl.uniform2f(u("u_center"), width * bounded(10, 50, -100, 200) / 100, height * bounded(11, 50, -100, 200) / 100);
    gl.uniform3fv(u("u_x[0]"), axesX);
    gl.uniform3fv(u("u_y[0]"), axesY);
    gl.uniform3fv(u("u_centers[0]"), centers);
    gl.uniform4fv(u("u_sizes[0]"), sizes);
    gl.uniform1i(u("u_count"), count);
    gl.uniform1f(u("u_shadow"), bounded(12, 45, 0, 100) / 100);
    gl.uniform1f(u("u_edge"), bounded(13, 12, 0, 100) / 100);
    gl.uniform1f(u("u_background"), bounded(14, 70, 0, 100) / 100);
  }, input.scale);
  ctx.pool.release(input.target);
  return out;
}, { scalable: true });
