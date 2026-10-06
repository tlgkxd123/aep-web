// Rasterizes a layer's masks into one coverage texture in layer space, on the GPU.
//
// Each mask path is drawn with Canvas2D (GPU-backed in Chromium, never read
// back), uploaded as a texture, feathered and combined with the stack in
// float render targets, so intermediate coverage keeps full precision; the
// final coverage is quantized to 8 bits where it multiplies the layer.
import { currentValue } from "../aep/evaluate.ts";
import { isShapeValue, type Layer, type Property, type PropertyGroup, type PropertyValue, type Shape } from "../aep/model.ts";
import { compile, type GL } from "./gl.ts";
import { FULLSCREEN_VS } from "./shaders.ts";

const MaskMode = { NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815, LIGHTEN: 6816, DARKEN: 6817, DIFFERENCE: 6818 } as const;

type Canvas2D = OffscreenCanvasRenderingContext2D;

function child(group: PropertyGroup, matchName: string): Property | undefined {
  const node = group.children.find((c) => c.matchName === matchName);
  return node?.kind === "property" ? node : undefined;
}

function numberAt(prop: Property | undefined, time: number, layer: Layer, fallback: number): number {
  if (!prop) return fallback;
  const v = currentValue(prop, time, layer);
  return typeof v === "number" ? v : Array.isArray(v) ? (v[0] ?? fallback) : fallback;
}

function tracePath(ctx: Canvas2D, shape: Shape): void {
  const { vertices: v, inTangents: inT, outTangents: outT } = shape;
  if (!v.length) return;
  ctx.moveTo(v[0][0], v[0][1]);
  const segments = shape.closed ? v.length : v.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    const c1 = [a[0] + outT[i][0], a[1] + outT[i][1]];
    const c2 = [b[0] + inT[(i + 1) % v.length][0], b[1] + inT[(i + 1) % v.length][1]];
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], b[0], b[1]);
  }
  if (shape.closed) ctx.closePath();
}

/**
 * AE's mask feather: a Gaussian with sigma = feather / 2.4, truncated at the
 * feather radius, applied separably with edge pixels repeated. Weights come
 * from a kernel texture so any radius works.
 */
const FEATHER_FS = `#version 300 es
precision highp float;
uniform sampler2D u_coverage;
uniform sampler2D u_kernel;
uniform int u_radius;
uniform ivec2 u_step;
uniform bool u_fromAlpha;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(u_coverage, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float acc = 0.0;
  for (int k = -u_radius; k <= u_radius; k++) {
    ivec2 q = clamp(p + u_step * k, ivec2(0), size - 1);
    vec4 texel = texelFetch(u_coverage, q, 0);
    acc += (u_fromAlpha ? texel.a : texel.r) * texelFetch(u_kernel, ivec2(k + u_radius, 0), 0).r;
  }
  outColor = vec4(acc, 0.0, 0.0, 1.0);
}`;

const COMBINE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_coverage;
uniform sampler2D u_accumulated;
uniform bool u_fromAlpha;
uniform bool u_first;
uniform float u_start;
uniform bool u_inverted;
uniform float u_opacity;
uniform int u_mode;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 texel = texelFetch(u_coverage, p, 0);
  float c = u_fromAlpha ? texel.a : texel.r;
  if (u_inverted) c = 1.0 - c;
  c *= u_opacity;
  float a = u_first ? u_start : texelFetch(u_accumulated, p, 0).r;
  float r = a;
  if (u_mode == ${MaskMode.ADD}) r = a + c - a * c;
  else if (u_mode == ${MaskMode.SUBTRACT}) r = a * (1.0 - c);
  else if (u_mode == ${MaskMode.INTERSECT}) r = a * c;
  else if (u_mode == ${MaskMode.LIGHTEN}) r = max(a, c);
  else if (u_mode == ${MaskMode.DARKEN}) r = min(a, c);
  else if (u_mode == ${MaskMode.DIFFERENCE}) r = abs(a - c);
  outColor = vec4(r, 0.0, 0.0, 1.0);
}`;

interface FloatTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

export class MaskRenderer {
  private readonly gl: GL;
  private readonly draw: () => void;
  private readonly feather: WebGLProgram;
  private readonly combine: WebGLProgram;
  private readonly floatTargets: boolean;
  private readonly targets = new Map<string, FloatTarget[]>();
  private readonly shapeTexture: WebGLTexture;
  private readonly kernelTexture: WebGLTexture;
  private canvas: OffscreenCanvas | undefined;
  private ctx: Canvas2D | undefined;
  private readonly uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  constructor(gl: GL, draw: () => void) {
    this.gl = gl;
    this.draw = draw;
    this.feather = compile(gl, FULLSCREEN_VS, FEATHER_FS);
    this.combine = compile(gl, FULLSCREEN_VS, COMBINE_FS);
    this.floatTargets = !!gl.getExtension("EXT_color_buffer_float");
    this.shapeTexture = this.nearestTexture();
    this.kernelTexture = this.nearestTexture();
  }

  private nearestTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let map = this.uniforms.get(program);
    if (!map) this.uniforms.set(program, (map = new Map()));
    if (!map.has(name)) map.set(name, this.gl.getUniformLocation(program, name));
    return map.get(name)!;
  }

  /** Three single-channel targets of this size (stack, feather intermediate, spare), reused across frames. */
  private targetsFor(w: number, h: number): FloatTarget[] {
    const key = `${w}x${h}`;
    let list = this.targets.get(key);
    if (list) return list;
    const gl = this.gl;
    list = Array.from({ length: 3 }, () => {
      const texture = this.nearestTexture();
      if (this.floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return { texture, framebuffer };
    });
    this.targets.set(key, list);
    return list;
  }

  private bind(unit: number, texture: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
  }

  private pass(program: WebGLProgram, out: FloatTarget, w: number, h: number, setUniforms: (u: (name: string) => WebGLUniformLocation | null) => void): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(program);
    setUniforms((name) => this.uniform(program, name));
    this.draw();
  }

  /** Draws one mask path (white, nonzero fill, plus expansion) into the shape texture, GL row order. */
  private rasterize(shape: PropertyValue | null, w: number, h: number, pad: number, origin: [number, number], expansion: number): void {
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = new OffscreenCanvas(w, h);
      this.ctx = this.canvas.getContext("2d")!;
    }
    const ctx = this.ctx!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(pad - origin[0], pad - origin[1]);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    if (isShapeValue(shape)) {
      ctx.beginPath();
      tracePath(ctx, shape);
      ctx.fill("nonzero");
      if (expansion > 0) {
        ctx.lineWidth = expansion * 2;
        ctx.lineJoin = "round";
        ctx.stroke();
      }
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.shapeTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  private uploadKernel(feather: number): number {
    const sigma = feather / 2.4;
    const radius = Math.ceil(feather);
    const kernel = new Float32Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.kernelTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, kernel.length, 1, 0, gl.RED, gl.FLOAT, kernel);
    return radius;
  }

  /**
   * Coverage of the layer's enabled masks at `time` over its padded image of
   * `(width + 2*pad) x (height + 2*pad)`, in the red channel, GL row order.
   * Null when the layer has no active mask. Valid until the next call.
   */
  coverage(layer: Layer, time: number, width: number, height: number, pad: number, origin: [number, number] = [0, 0]): WebGLTexture | null {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Mask Parade");
    const masks = (parade?.children ?? []).filter(
      (n): n is PropertyGroup => n.kind === "group" && !!n.mask && n.enabled && n.mask.maskMode !== MaskMode.NONE,
    );
    if (!masks.length) return null;
    const w = width + 2 * pad;
    const h = height + 2 * pad;
    const targets = this.targetsFor(w, h);
    let stack = targets[0];
    let first = true;

    for (const mask of masks) {
      const shapeProp = child(mask, "ADBE Mask Shape");
      const shape = shapeProp ? currentValue(shapeProp, time, layer) : null;
      const opacity = numberAt(child(mask, "ADBE Mask Opacity"), time, layer, 100) / 100;
      const featherProp = child(mask, "ADBE Mask Feather");
      const featherValue = featherProp ? currentValue(featherProp, time, layer) : null;
      const feather = Array.isArray(featherValue) ? Math.max(featherValue[0] ?? 0, featherValue[1] ?? 0) : 0;
      const expansion = numberAt(child(mask, "ADBE Mask Offset"), time, layer, 0);
      this.rasterize(shape, w, h, pad, origin, expansion);

      // The two targets not holding the stack: a feather intermediate and the combine output.
      const [scratch, feathered] = targets.filter((t) => t !== stack);
      let coverage = this.shapeTexture;
      let fromAlpha = true;
      if (feather > 0) {
        const radius = this.uploadKernel(feather);
        const blur = (source: WebGLTexture, sourceIsAlpha: boolean, out: FloatTarget, step: [number, number]) =>
          this.pass(this.feather, out, w, h, (u) => {
            this.bind(0, source);
            this.bind(1, this.kernelTexture);
            this.gl.uniform1i(u("u_coverage"), 0);
            this.gl.uniform1i(u("u_kernel"), 1);
            this.gl.uniform1i(u("u_radius"), radius);
            this.gl.uniform2i(u("u_step"), step[0], step[1]);
            this.gl.uniform1i(u("u_fromAlpha"), sourceIsAlpha ? 1 : 0);
          });
        blur(this.shapeTexture, true, scratch, [1, 0]);
        blur(scratch.texture, false, feathered, [0, 1]);
        coverage = feathered.texture;
        fromAlpha = false;
      }
      const mode = mask.mask!.maskMode;
      // A stack that starts by removing coverage starts from a fully covered layer.
      const start = mode === MaskMode.SUBTRACT || mode === MaskMode.INTERSECT || mode === MaskMode.DARKEN ? 1 : 0;
      const out = scratch;
      this.pass(this.combine, out, w, h, (u) => {
        this.bind(0, coverage);
        this.bind(1, stack.texture);
        this.gl.uniform1i(u("u_coverage"), 0);
        this.gl.uniform1i(u("u_accumulated"), 1);
        this.gl.uniform1i(u("u_fromAlpha"), fromAlpha ? 1 : 0);
        this.gl.uniform1i(u("u_first"), first ? 1 : 0);
        this.gl.uniform1f(u("u_start"), start);
        this.gl.uniform1i(u("u_inverted"), mask.mask!.inverted ? 1 : 0);
        this.gl.uniform1f(u("u_opacity"), opacity);
        this.gl.uniform1i(u("u_mode"), mode);
      });
      first = false;
      stack = out;
    }
    return stack.texture;
  }
}
