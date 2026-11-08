// Rowbyte Separate RGB (GUTS SEPRGB): a look-alike built from the parameters projects store. The plug-in is not
// installed here, so the rendering is unverified against After Effects.
//
// Each channel of the image is blurred, moved, rotated and scaled about the layer's centre and lens-distorted about
// its own centre, then mixed with the original channel and faded by its opacity. The alpha is the largest of the
// three channels', so premultiplied colour stays within it. Offsets are points: the layer's centre means no offset.
import type { Layer } from "../../aep/model.ts";
import type { LayerImage } from "../registry.ts";
import { copyImage } from "./fxextraUtil.ts";
import { blurrinessSigma, DEG } from "./stockMath.ts";
import { clampRect, gaussian, imageRect, layerCenter, layerPass, registerStock, unionRect, type Params, type Rect } from "./stockUtil.ts";

type Point = [number, number];

/** Parameter indices of each channel, in red, green, blue order. */
const PARAMS = [
  { offset: 2, rotate: 3, scale: 4, blend: 5, blur: 6, opacity: 7, distortion: 29, center: 32 },
  { offset: 10, rotate: 11, scale: 12, blend: 13, blur: 14, opacity: 15, distortion: 30, center: 33 },
  { offset: 18, rotate: 19, scale: 20, blend: 21, blur: 22, opacity: 23, distortion: 31, center: 34 },
] as const;

/** A channel's settings in image pixels. */
export interface Channel {
  offset: Point;
  /** Radians, clockwise on screen. */
  rotation: number;
  scale: number;
  blend: number;
  sigma: number;
  opacity: number;
  distortion: number;
  distortCenter: Point;
}

/** Below this the channel is too small to invert its transform. */
const MIN_SCALE = 1e-3;
/** The most a negative distortion is taken to pull a corner outward when sizing the output. */
const MIN_SPREAD = 0.25;

/** The settings of the three channels at image scale `k`; `center` is the layer's centre in layer pixels. */
export function channelSettings(p: Params, layer: Pick<Layer, "width" | "height">, center: Point, k: number): Channel[] {
  // A point never edited holds its default percentage of the layer's size unconverted: 50 x width, 50 x height.
  const point = (index: number): Point => {
    const v = p.vec(index, center);
    const untouched = layer.width > 0 && layer.height > 0 && Math.abs(v[0] - 50 * layer.width) < 0.5 && Math.abs(v[1] - 50 * layer.height) < 0.5;
    return untouched ? center : [v[0] ?? center[0], v[1] ?? center[1]];
  };
  return PARAMS.map((i) => {
    const position = point(i.offset);
    const distortCenter = point(i.center);
    return {
      offset: [(position[0] - center[0]) * k, (position[1] - center[1]) * k],
      rotation: p.num(i.rotate, 0) * DEG,
      scale: Math.max(MIN_SCALE, p.num(i.scale, 100) / 100),
      blend: Math.min(1, Math.max(0, p.num(i.blend, 0) / 100)),
      sigma: blurrinessSigma(p.num(i.blur, 0)) * k,
      opacity: Math.min(1, Math.max(0, p.num(i.opacity, 100) / 100)),
      distortion: p.num(i.distortion, 0) / 100,
      distortCenter: [distortCenter[0] * k, distortCenter[1] * k],
    };
  });
}

/** The point of a channel's source image shown at output point `q`, as the shader computes it. */
export function sourcePoint(c: Channel, center: Point, radius: number, q: Point): Point {
  const dx = q[0] - c.distortCenter[0];
  const dy = q[1] - c.distortCenter[1];
  const spread = 1 + (c.distortion * (dx * dx + dy * dy)) / (radius * radius);
  const x = c.distortCenter[0] + dx * spread - center[0] - c.offset[0];
  const y = c.distortCenter[1] + dy * spread - center[1] - c.offset[1];
  const cos = Math.cos(c.rotation) / c.scale;
  const sin = Math.sin(c.rotation) / c.scale;
  return [center[0] + cos * x + sin * y, center[1] - sin * x + cos * y];
}

/** The rectangle a channel's source image `source` lands on. */
export function channelBounds(c: Channel, center: Point, radius: number, source: Rect): Rect {
  const cos = Math.cos(c.rotation) * c.scale;
  const sin = Math.sin(c.rotation) * c.scale;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [source.x, source.y],
    [source.x + source.width, source.y],
    [source.x, source.y + source.height],
    [source.x + source.width, source.y + source.height],
  ]) {
    const dx = x - center[0];
    const dy = y - center[1];
    const ex = center[0] + c.offset[0] + cos * dx - sin * dy - c.distortCenter[0];
    const ey = center[1] + c.offset[1] + sin * dx + cos * dy - c.distortCenter[1];
    const spread = Math.max(MIN_SPREAD, 1 + (c.distortion * (ex * ex + ey * ey)) / (radius * radius));
    xs.push(c.distortCenter[0] + ex / spread);
    ys.push(c.distortCenter[1] + ey / spread);
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const DECLS = `
uniform vec2 u_center;
uniform float u_radius;
uniform vec2 u_offset[3];
uniform mat2 u_inverse[3];
uniform float u_blend[3];
uniform float u_opacity[3];
uniform float u_distortion[3];
uniform vec2 u_distortCenter[3];
vec2 sourcePoint(int i, vec2 q) {
  vec2 d = q - u_distortCenter[i];
  vec2 lens = u_distortCenter[i] + d * (1.0 + u_distortion[i] * dot(d, d) / (u_radius * u_radius));
  return u_center + u_inverse[i] * (lens - u_center - u_offset[i]);
}
`;

// Source 0 is the original image; 1 to 3 are the channels' blurred images.
const BODY = `
  vec4 original = at(0, p);
  vec3 color = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < 3; i++) {
    vec4 c = mix(at(i + 1, sourcePoint(i, p)), original, u_blend[i]) * u_opacity[i];
    color[i] = c[i];
    alpha = max(alpha, c.a);
  }
  outColor = vec4(color, alpha);
`;

registerStock("GUTS SEPRGB", (input, p, ctx, layer) => {
  ctx.warn("Separate RGB is drawn with a look-alike; it is not compared with the plug-in");
  const k = input.scale ?? 1;
  const [cx, cy] = layerCenter(layer, input);
  const channels = channelSettings(p, layer, [cx, cy], k);
  const center: Point = [cx * k, cy * k];
  const radius = 0.5 * (layer.width > 0 && layer.height > 0 ? Math.hypot(layer.width * k, layer.height * k) : Math.hypot(input.width, input.height));

  const blurred = new Map<number, LayerImage>();
  for (const c of channels) if (c.sigma >= 0.1 && !blurred.has(c.sigma)) blurred.set(c.sigma, gaussian(ctx, copyImage(ctx, input), c.sigma, c.sigma));
  const sources = channels.map((c) => blurred.get(c.sigma) ?? input);

  const rect = clampRect(channels.reduce((r, c, i) => unionRect(r, channelBounds(c, center, radius, imageRect(sources[i]))), imageRect(input)));
  const out = layerPass(
    ctx,
    rect,
    [input, ...sources],
    DECLS,
    BODY,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_center"), center[0], center[1]);
      gl.uniform1f(u("u_radius"), radius);
      gl.uniform2fv(u("u_offset"), channels.flatMap((c) => c.offset));
      gl.uniformMatrix2fv(
        u("u_inverse"),
        false,
        channels.flatMap((c) => {
          const cos = Math.cos(c.rotation) / c.scale;
          const sin = Math.sin(c.rotation) / c.scale;
          return [cos, -sin, sin, cos];
        }),
      );
      gl.uniform1fv(u("u_blend"), channels.map((c) => c.blend));
      gl.uniform1fv(u("u_opacity"), channels.map((c) => c.opacity));
      gl.uniform1fv(u("u_distortion"), channels.map((c) => c.distortion));
      gl.uniform2fv(u("u_distortCenter"), channels.flatMap((c) => c.distortCenter));
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  for (const image of blurred.values()) ctx.pool.release(image.target);
  return out;
});
