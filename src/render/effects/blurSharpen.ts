// Stock Blur & Sharpen effects: Gaussian Blur (and the legacy Gaussian Blur and
// Fast Blur), Directional Blur, Sharpen and Unsharp Mask, on premultiplied pixels.
// Gaussian Blur's Blurriness maps to a standard deviation as mask feather does
// (stockMath.ts); none of these is measured against After Effects renders yet.
import type { Layer } from "../../aep/model.ts";
import type { LayerImage, RenderContext } from "../registry.ts";
import { copyImage, grown, mapPass, PASS_HEADER } from "./fxextraUtil.ts";
import { blurrinessSigma, directionVector } from "./stockMath.ts";
import { blurAxes, gaussian, imageRect, layerRect, registerStock, type Params } from "./stockUtil.ts";

function gaussianBlur(input: LayerImage, ctx: RenderContext, layer: Layer, blurriness: number, dimensions: number, repeatEdges: boolean): LayerImage {
  const sigma = blurrinessSigma(blurriness) * (input.scale ?? 1);
  const [h, v] = blurAxes(dimensions);
  return gaussian(ctx, input, h ? sigma : 0, v ? sigma : 0, { repeatEdges: repeatEdges ? layerRect(layer, input) : undefined });
}

registerStock("ADBE Gaussian Blur 2", (input, p, ctx, layer) => gaussianBlur(input, ctx, layer, p.num(1, 0), p.num(2, 1), p.bool(3, false)));
registerStock("ADBE Gaussian Blur", (input, p, ctx, layer) => gaussianBlur(input, ctx, layer, p.num(1, 0), p.num(2, 1), false));
registerStock("ADBE Fast Blur", (input, p, ctx, layer) => gaussianBlur(input, ctx, layer, p.num(1, 0), p.num(2, 1), p.bool(3, false)));

const DIRECTIONAL_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_pad;
uniform vec2 u_half;
uniform int u_taps;
void main() {
  vec2 px = v_uv * u_size;
  if (px.x < u_pad || px.y < u_pad || px.x > u_size.x - u_pad || px.y > u_size.y - u_pad) { outColor = vec4(0.0); return; }
  vec4 sum = vec4(0.0);
  for (int i = 0; i < u_taps; i++) {
    float t = u_taps == 1 ? 0.0 : float(i) / float(u_taps - 1) * 2.0 - 1.0;
    sum += texture(u_source, (px + u_half * t) / u_size);
  }
  outColor = sum / float(u_taps);
}`;

// Directional Blur: a box of Blur Length pixels in all along Direction (0 = vertical).
registerStock("ADBE Motion Blur", (input, p: Params, ctx) => {
  const length = Math.max(0, p.num(2, 0)) * (input.scale ?? 1);
  if (length < 0.5) return input;
  const [dx, dy] = directionVector(p.num(1, 0));
  const half = length / 2;
  const image = grown(ctx, input, Math.ceil(half));
  const taps = Math.min(257, Math.ceil(length) + 1);
  return mapPass(ctx, image, DIRECTIONAL_FS, (u) => {
    ctx.gl.uniform2f(u("u_half"), dx * half, -dy * half);
    ctx.gl.uniform1i(u("u_taps"), taps);
  });
});

const SHARPEN_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_amount;
void main() {
  vec2 t = 1.0 / u_size;
  vec4 c = texture(u_source, v_uv);
  vec4 n = texture(u_source, v_uv + vec2(0.0, t.y)) + texture(u_source, v_uv - vec2(0.0, t.y))
    + texture(u_source, v_uv + vec2(t.x, 0.0)) + texture(u_source, v_uv - vec2(t.x, 0.0));
  vec4 r = clamp(c + u_amount * (4.0 * c - n), 0.0, 1.0);
  outColor = vec4(min(r.rgb, vec3(r.a)), r.a);
}`;

registerStock("ADBE Sharpen", (input, p, ctx) => {
  const amount = Math.max(0, p.num(1, 0)) / 100;
  if (!amount) return input;
  return mapPass(ctx, input, SHARPEN_FS, (u) => ctx.gl.uniform1f(u("u_amount"), amount));
});

const UNSHARP_FS = `${PASS_HEADER}
uniform sampler2D u_extra0;
uniform float u_amount;
uniform float u_threshold;
void main() {
  vec4 c = texture(u_source, v_uv);
  vec4 b = texture(u_extra0, v_uv);
  vec4 d = c - b;
  if (max(abs(d.r), max(abs(d.g), abs(d.b))) * 255.0 < u_threshold) { outColor = c; return; }
  vec4 r = clamp(c + u_amount * d, 0.0, 1.0);
  outColor = vec4(min(r.rgb, vec3(r.a)), r.a);
}`;

// Unsharp Mask: the difference from a Gaussian of standard deviation Radius, scaled by Amount, where it exceeds
// Threshold (levels of 255).
registerStock("ADBE Unsharp Mask2", (input, p, ctx) => {
  const amount = Math.max(0, p.num(1, 50)) / 100;
  const radius = Math.max(0, p.num(2, 1)) * (input.scale ?? 1);
  if (!amount || radius < 0.1) return input;
  const blurred = gaussian(ctx, copyImage(ctx, input), radius, radius, { repeatEdges: imageRect(input) });
  const out = mapPass(
    ctx,
    input,
    UNSHARP_FS,
    (u) => {
      ctx.gl.uniform1f(u("u_amount"), amount);
      ctx.gl.uniform1f(u("u_threshold"), Math.max(0, p.num(3, 0)));
    },
    [blurred],
  );
  ctx.pool.release(blurred.target);
  return out;
});
