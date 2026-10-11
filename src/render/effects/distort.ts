// Stock Distort and Stylize effects that resample the layer: Transform, Offset,
// Corner Pin and Motion Tile. Points are layer pixels, times the image's scale
// at a reduced resolution. Look-alikes from the effects' documented behaviour,
// not yet measured against After Effects renders.
import { cornerPinInverse, geometryMatrix, invert, type Affine } from "./stockMath.ts";
import { imageRect, layerPass, layerRect, registerStock, unionRect, warp, type Rect } from "./stockUtil.ts";

/** An affine map of layer points scaled by k: S(k) m S(1/k). */
const scaled = (m: Affine, k: number): Affine => [m[0], m[1], m[2], m[3], m[4] * k, m[5] * k];

const center = (r: Rect, k: number, layerWidth: number, layerHeight: number): [number, number] =>
  layerWidth > 0 && layerHeight > 0 ? [layerWidth / 2, layerHeight / 2] : [(r.x + r.width / 2) / k, (r.y + r.height / 2) / k];

// Transform: the layer image through anchor, position, scale, skew and rotation, at Opacity, within the
// layer's box. Its motion blur is not rendered.
registerStock("ADBE Geometry2", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const rect = layerRect(layer, input);
  const c = center(rect, k, layer.width, layer.height);
  const anchor = p.vec(1, c);
  const position = p.vec(2, c);
  const uniform = p.bool(11, true);
  const scaleHeight = p.num(3, 100);
  const scaleWidth = uniform ? scaleHeight : p.num(4, 100);
  const m = geometryMatrix(anchor, position, scaleWidth, scaleHeight, p.num(5, 0), p.num(6, 0), p.num(7, 0));
  const inverse = invert(scaled(m, k));
  const opacity = Math.min(1, Math.max(0, p.num(8, 100) / 100));
  if (!p.bool(9, true) && p.num(10, 0) > 0) ctx.warn("Transform: motion blur is not rendered");
  if (!inverse) {
    ctx.pool.release(input.target);
    return layerPass(ctx, rect, [], "", "  outColor = vec4(0.0);", undefined, input.scale);
  }
  return warp(
    ctx,
    input,
    unionRect(rect, imageRect(input)),
    `uniform vec3 u_m0;
uniform vec3 u_m1;
uniform float u_opacity;
vec2 map(vec2 p) { return vec2(dot(u_m0, vec3(p, 1.0)), dot(u_m1, vec3(p, 1.0))); }`,
    (u) => {
      ctx.gl.uniform3f(u("u_m0"), inverse[0], inverse[2], inverse[4]);
      ctx.gl.uniform3f(u("u_m1"), inverse[1], inverse[3], inverse[5]);
      ctx.gl.uniform1f(u("u_opacity"), opacity);
    },
    "  outColor = c * u_opacity;",
  );
});

// Offset: the layer shifted so its centre lands on Shift Center To, wrapping around its box.
registerStock("ADBE Offset", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const rect = layerRect(layer, input);
  const c = center(rect, k, layer.width, layer.height);
  const [sx, sy] = p.vec(1, c);
  const blend = Math.min(1, Math.max(0, p.num(2, 0) / 100));
  const out = layerPass(
    ctx,
    rect,
    [input],
    `uniform vec4 u_rect;
uniform vec2 u_shift;
uniform float u_blend;`,
    `  vec2 q = clamp(u_rect.xy + mod(p - u_shift - u_rect.xy, u_rect.zw), u_rect.xy + 0.5, u_rect.xy + u_rect.zw - 0.5);
  outColor = mix(at(0, q), at(0, p), u_blend);`,
    (u) => {
      ctx.gl.uniform4f(u("u_rect"), rect.x, rect.y, rect.width, rect.height);
      ctx.gl.uniform2f(u("u_shift"), (sx - c[0]) * k, (sy - c[1]) * k);
      ctx.gl.uniform1f(u("u_blend"), blend);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

/** The largest output a distortion may grow the layer to, per side (image pixels). */
const MAX_EXTENT = 16384;

const clampRect = (r: Rect): Rect => {
  const x = Math.max(-MAX_EXTENT, Math.floor(r.x));
  const y = Math.max(-MAX_EXTENT, Math.floor(r.y));
  return { x, y, width: Math.min(MAX_EXTENT, Math.ceil(r.x + r.width)) - x, height: Math.min(MAX_EXTENT, Math.ceil(r.y + r.height)) - y };
};

// Corner Pin: the layer's box mapped projectively onto the four pins; the output covers the pinned quad.
registerStock("ADBE Corner Pin", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const rect = layerRect(layer, input);
  const [x0, y0, x1, y1] = [rect.x / k, rect.y / k, (rect.x + rect.width) / k, (rect.y + rect.height) / k];
  const pins = [p.vec(1, [x0, y0]), p.vec(2, [x1, y0]), p.vec(3, [x0, y1]), p.vec(4, [x1, y1])].map((v) => [v[0] * k, v[1] * k]);
  const inverse = cornerPinInverse(pins[0], pins[1], pins[2], pins[3]);
  const xs = pins.map((v) => v[0]);
  const ys = pins.map((v) => v[1]);
  const out = clampRect({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
  if (!inverse || out.width < 1 || out.height < 1) {
    ctx.pool.release(input.target);
    return layerPass(ctx, { ...rect, width: 1, height: 1 }, [], "", "  outColor = vec4(0.0);", undefined, input.scale);
  }
  return warp(
    ctx,
    input,
    out,
    `uniform mat3 u_inverse;
uniform vec4 u_rect;
vec2 map(vec2 p) {
  vec3 h = u_inverse * vec3(p, 1.0);
  if (h.z <= 0.0) return vec2(-1e9);
  vec2 uv = h.xy / h.z;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(-1e9);
  return u_rect.xy + uv * u_rect.zw;
}`,
    (u) => {
      // Row-major to GLSL's column-major.
      const m = inverse;
      ctx.gl.uniformMatrix3fv(u("u_inverse"), false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
      ctx.gl.uniform4f(u("u_rect"), rect.x, rect.y, rect.width, rect.height);
    },
  );
});

// Motion Tile: the layer shrunk to Tile Width x Tile Height and repeated around Tile Center over an output of
// Output Width x Output Height of the layer's box; alternate columns (or rows, with Horizontal Phase Shift) shift
// by Phase, and alternate tiles are mirrored with Mirror Edges.
registerStock("ADBE Tile", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const rect = layerRect(layer, input);
  const c = center(rect, k, layer.width, layer.height);
  const [cx, cy] = p.vec(1, c).map((v) => v * k);
  const tile = [Math.max(1e-3, p.num(2, 100) / 100) * rect.width, Math.max(1e-3, p.num(3, 100) / 100) * rect.height];
  const ow = Math.max(0, p.num(4, 100) / 100);
  const oh = Math.max(0, p.num(5, 100) / 100);
  const mid = [rect.x + rect.width / 2, rect.y + rect.height / 2];
  const out = clampRect({ x: mid[0] - (rect.width * ow) / 2, y: mid[1] - (rect.height * oh) / 2, width: rect.width * ow, height: rect.height * oh });
  if (out.width < 1 || out.height < 1) {
    ctx.pool.release(input.target);
    return layerPass(ctx, { ...rect, width: 1, height: 1 }, [], "", "  outColor = vec4(0.0);", undefined, input.scale);
  }
  return warp(
    ctx,
    input,
    out,
    `uniform vec2 u_center;
uniform vec2 u_tile;
uniform vec4 u_rect;
uniform float u_phase;
uniform int u_horizontal;
uniform int u_mirror;
vec2 map(vec2 p) {
  vec2 t = (p - u_center) / u_tile + 0.5;
  vec2 cell = floor(t);
  if (u_horizontal == 1) t.x += mod(cell.y, 2.0) * u_phase;
  else t.y += mod(cell.x, 2.0) * u_phase;
  cell = floor(t);
  vec2 f = fract(t);
  if (u_mirror == 1) f = mix(f, 1.0 - f, mod(cell, 2.0));
  return clamp(u_rect.xy + f * u_rect.zw, u_rect.xy + 0.5, u_rect.xy + u_rect.zw - 0.5);
}`,
    (u) => {
      ctx.gl.uniform2f(u("u_center"), cx, cy);
      ctx.gl.uniform2f(u("u_tile"), tile[0], tile[1]);
      ctx.gl.uniform4f(u("u_rect"), rect.x, rect.y, rect.width, rect.height);
      ctx.gl.uniform1f(u("u_phase"), p.num(7, 0) / 360);
      ctx.gl.uniform1i(u("u_horizontal"), p.bool(8, false) ? 1 : 0);
      ctx.gl.uniform1i(u("u_mirror"), p.bool(6, false) ? 1 : 0);
    },
  );
});
