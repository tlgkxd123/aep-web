// Small helpers shared by the effects in this folder that run one shader pass
// over a layer image or blur it.
import type { LayerImage, RenderContext } from "../registry.ts";

export type Uniforms = (uniform: (name: string) => WebGLUniformLocation | null) => void;

export const PASS_HEADER = `#version 300 es
precision highp float;
uniform sampler2D u_source;
in vec2 v_uv;
out vec4 outColor;
`;

/** Runs `fragment` (which samples u_source at v_uv) over an image of the same size; releases `input`. */
export function mapPass(ctx: RenderContext, input: LayerImage, fragment: string, setUniforms?: Uniforms, extra: LayerImage[] = []): LayerImage {
  const out = ctx.pool.acquire(input.target.width, input.target.height);
  ctx.pass(ctx.program(fragment), out, [input.target, ...extra.map((e) => e.target)], (uniform) => {
    ctx.gl.uniform1i(uniform("u_source"), 0);
    extra.forEach((_, i) => ctx.gl.uniform1i(uniform(`u_extra${i}`), i + 1));
    ctx.gl.uniform2f(uniform("u_size"), input.target.width, input.target.height);
    ctx.gl.uniform1f(uniform("u_pad"), ctx.pad);
    setUniforms?.(uniform);
  });
  ctx.pool.release(input.target);
  return { ...input, target: out };
}

/** A new image with the same pixels as `input` (which stays valid). */
export function copyImage(ctx: RenderContext, input: LayerImage): LayerImage {
  const out = ctx.pool.acquire(input.target.width, input.target.height);
  ctx.pass(ctx.program(`${PASS_HEADER}void main() { outColor = texture(u_source, v_uv); }`), out, [input.target], (uniform) =>
    ctx.gl.uniform1i(uniform("u_source"), 0),
  );
  return { ...input, target: out };
}

/** A copy of `input` grown by `grow` pixels on every side (content keeps its layer-space position). */
export function grown(ctx: RenderContext, input: LayerImage, grow: number): LayerImage {
  const g = Math.max(0, Math.ceil(grow));
  if (!g) return input;
  const width = input.width + 2 * g;
  const height = input.height + 2 * g;
  const out = ctx.pool.acquire(width + 2 * ctx.pad, height + 2 * ctx.pad);
  const fragment = `${PASS_HEADER}
uniform vec2 u_outSize;
uniform vec2 u_inSize;
uniform float u_grow;
void main() {
  vec2 p = v_uv * u_outSize - u_grow;
  outColor = (p.x < 0.0 || p.y < 0.0 || p.x > u_inSize.x || p.y > u_inSize.y) ? vec4(0.0) : texture(u_source, p / u_inSize);
}`;
  ctx.pass(ctx.program(fragment), out, [input.target], (uniform) => {
    ctx.gl.uniform1i(uniform("u_source"), 0);
    ctx.gl.uniform2f(uniform("u_outSize"), out.width, out.height);
    ctx.gl.uniform2f(uniform("u_inSize"), input.target.width, input.target.height);
    ctx.gl.uniform1f(uniform("u_grow"), g);
  });
  ctx.pool.release(input.target);
  return { target: out, width, height, origin: [input.origin[0] - g, input.origin[1] - g] };
}

const BLUR_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform vec2 u_dir;
uniform float u_sigma;
void main() {
  int r = int(ceil(u_sigma * 3.0));
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -256; i <= 256; i++) {
    if (i < -r || i > r) continue;
    float w = exp(-0.5 * float(i * i) / (u_sigma * u_sigma));
    sum += texture(u_source, v_uv + u_dir * float(i) / u_size) * w;
    wsum += w;
  }
  outColor = sum / wsum;
}`;

/** Separable Gaussian blur of a premultiplied image (sigma in pixels per axis); releases `input`. */
export function gaussianBlur(ctx: RenderContext, input: LayerImage, sigmaX: number, sigmaY: number): LayerImage {
  let image = input;
  for (const [sigma, dir] of [
    [Math.min(sigmaX, 85), [1, 0]],
    [Math.min(sigmaY, 85), [0, 1]],
  ] as const) {
    if (sigma < 0.05) continue;
    image = mapPass(ctx, image, BLUR_FS, (uniform) => {
      ctx.gl.uniform2f(uniform("u_dir"), dir[0], dir[1]);
      ctx.gl.uniform1f(uniform("u_sigma"), sigma);
    });
  }
  return image;
}

/** Premultiplied RGBA8 pixels of an image's target, GL row order. */
export function readTarget(ctx: RenderContext, image: LayerImage): Uint8Array {
  const gl = ctx.gl;
  const { width, height } = image.target;
  gl.bindFramebuffer(gl.FRAMEBUFFER, image.target.framebuffer);
  const data = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return data;
}

/** Writes premultiplied RGBA8 pixels (GL row order, target size) into the image's target. */
export function writeTarget(ctx: RenderContext, image: LayerImage, data: Uint8Array): void {
  const gl = ctx.gl;
  gl.bindTexture(gl.TEXTURE_2D, image.target.texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image.target.width, image.target.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
}
