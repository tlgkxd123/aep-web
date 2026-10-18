// The I420 pictures of yuv.ts made on the GPU from a rendered comp, for encoders fed from memory (the WebAssembly H.264
// encoder, High quality): a frame reads back 1.5 bytes a pixel instead of 4, and no loop over its pixels runs in
// JavaScript. The shader repeats the integer arithmetic of Renderer.readPixels, pipeline.ts's matte and rgbToI420
// (alphaToI420), so the bytes are theirs.
import { PAD } from "../render/composition.ts";
import { bindTarget, compile, createTexture, unitQuad, type GL, type Target } from "../render/gl.ts";
import { FULLSCREEN_VS } from "../render/shaders.ts";
import { I420_COEFFICIENTS, i420Planes, type I420 } from "./yuv.ts";

/**
 * Writes the bytes of a contiguous I420 picture into an RGBA8 target, four a texel, in the order readPixels returns
 * them (the bottom row first).
 */
const I420_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_source;
uniform ivec2 u_size;
// The texel of the picture's top-left pixel: picture rows go down, texture rows up.
uniform ivec2 u_topLeft;
uniform int u_rowBytes;
// 0: colour matted over u_background, 1: straight colour, 2: alpha as luma over neutral chroma.
uniform int u_mode;
uniform ivec3 u_background;
uniform ivec3 u_y;
uniform ivec3 u_u;
uniform ivec3 u_v;
out vec4 o_bytes;

ivec4 texel(int x, int y) {
  return ivec4(floor(texelFetch(u_source, ivec2(u_topLeft.x + x, u_topLeft.y - y), 0) * 255.0 + 0.5));
}

ivec3 colour(int x, int y) {
  ivec4 p = texel(x, y);
  ivec3 straight = p.a > 0 ? min((p.rgb * 510 + p.a) / (2 * p.a), ivec3(255)) : ivec3(0);
  if (u_mode == 1) return straight;
  return (2 * (straight * p.a + u_background * (255 - p.a)) + 255) / 510;
}

int luma(int x, int y) {
  if (u_mode == 2) return texel(x, y).a;
  ivec3 c = colour(x, y);
  return (16 * 65536 + u_y.r * c.r + u_y.g * c.g + u_y.b * c.b + 32768) >> 16;
}

int chroma(int cx, int cy, ivec3 k) {
  if (u_mode == 2) return 128;
  ivec3 sum = ivec3(0);
  int n = 0;
  for (int dy = 0; dy < 2; dy++) {
    for (int dx = 0; dx < 2; dx++) {
      int x = 2 * cx + dx;
      int y = 2 * cy + dy;
      if (x < u_size.x && y < u_size.y) {
        sum += colour(x, y);
        n++;
      }
    }
  }
  int d = 65536 * n;
  return clamp((128 * d + k.r * sum.r + k.g * sum.g + k.b * sum.b + d / 2) / d, 0, 255);
}

int byteAt(int i) {
  int lumaBytes = u_size.x * u_size.y;
  int cw = (u_size.x + 1) / 2;
  int chromaBytes = cw * ((u_size.y + 1) / 2);
  if (i < lumaBytes) return luma(i % u_size.x, i / u_size.x);
  i -= lumaBytes;
  if (i < chromaBytes) return chroma(i % cw, i / cw, u_u);
  i -= chromaBytes;
  if (i < chromaBytes) return chroma(i % cw, i / cw, u_v);
  return 0;
}

void main() {
  int i = int(gl_FragCoord.y) * u_rowBytes + int(gl_FragCoord.x) * 4;
  o_bytes = vec4(byteAt(i), byteAt(i + 1), byteAt(i + 2), byteAt(i + 3)) / 255.0;
}`;

interface Converter {
  program: WebGLProgram;
  quad: WebGLVertexArrayObject;
  uniforms: Map<string, WebGLUniformLocation | null>;
  output?: Target;
}

const converters = new WeakMap<GL, Converter>();

function converterFor(gl: GL): Converter {
  let converter = converters.get(gl);
  if (!converter) converters.set(gl, (converter = { program: compile(gl, FULLSCREEN_VS, I420_FS), quad: unitQuad(gl), uniforms: new Map() }));
  return converter;
}

/** What a picture shows: the colour matted over an opaque background (0-1 RGB), the straight colour, or the alpha. */
export type PictureContent = { background: readonly number[] } | "straight" | "alpha";

/**
 * The top-left `width` x `height` of a rendered comp target as BT.709 limited-range I420: rgbToI420 of readPixels'
 * straight RGBA, matted over the background when given one, or alphaToI420 of it for "alpha".
 */
export function readI420(gl: GL, source: Target, width: number, height: number, content: PictureContent): I420 {
  const { size, layout } = i420Planes(width, height);
  const texels = Math.ceil(size / 4);
  const outWidth = Math.ceil(Math.sqrt(texels));
  const outHeight = Math.ceil(texels / outWidth);
  const converter = converterFor(gl);
  let output = converter.output;
  if (!output || output.width !== outWidth || output.height !== outHeight) {
    if (output) {
      gl.deleteFramebuffer(output.framebuffer);
      gl.deleteTexture(output.texture);
    }
    const texture = createTexture(gl, outWidth, outHeight, false);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    output = converter.output = { texture, framebuffer, width: outWidth, height: outHeight };
  }
  const { program, uniforms } = converter;
  const uniform = (name: string) => {
    if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
    return uniforms.get(name)!;
  };
  bindTarget(gl, output);
  gl.disable(gl.BLEND);
  gl.disable(gl.SCISSOR_TEST);
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, source.texture);
  gl.uniform1i(uniform("u_source"), 0);
  gl.uniform2i(uniform("u_size"), width, height);
  gl.uniform2i(uniform("u_topLeft"), PAD, source.height - 1 - PAD);
  gl.uniform1i(uniform("u_rowBytes"), outWidth * 4);
  gl.uniform1i(uniform("u_mode"), content === "straight" ? 1 : content === "alpha" ? 2 : 0);
  const [r, g, b] = [0, 1, 2].map((c) => (typeof content === "object" ? Math.round(Math.min(1, Math.max(0, content.background[c])) * 255) : 0));
  gl.uniform3i(uniform("u_background"), r, g, b);
  gl.uniform3i(uniform("u_y"), ...I420_COEFFICIENTS.y);
  gl.uniform3i(uniform("u_u"), ...I420_COEFFICIENTS.u);
  gl.uniform3i(uniform("u_v"), ...I420_COEFFICIENTS.v);
  gl.bindVertexArray(converter.quad);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const bytes = new Uint8Array(outWidth * outHeight * 4);
  gl.readPixels(0, 0, outWidth, outHeight, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  return { data: bytes.subarray(0, size), width, height, layout };
}
