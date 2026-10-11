// A WebGL2 context for analysing reference videos and the few helpers its passes
// share: float render targets, fragment-shader passes over a target, and frame
// textures. Analysis reads back compact results (detections, crops, statistics),
// never whole frames.
import { compile, type GL } from "../../render/gl.ts";

const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
void main() { gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0); }`;

export interface Surface {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  format: number;
}

export interface Gpu {
  gl: GL;
  canvas: OffscreenCanvas;
  /** A render target; `formats` with more than one entry makes one with several colour attachments. */
  surface(width: number, height: number, format: number, linear?: boolean): Surface;
  multi(width: number, height: number, format: number, count: number): { framebuffer: WebGLFramebuffer; textures: WebGLTexture[]; width: number; height: number };
  program(fragment: string): WebGLProgram;
  /** Draws `program` over all of a framebuffer, with `inputs` on units 0..n-1. */
  pass(program: WebGLProgram, out: { framebuffer: WebGLFramebuffer; width: number; height: number } | null, inputs: WebGLTexture[], uniforms?: (u: (name: string) => WebGLUniformLocation | null) => void): void;
  release(surface: Surface): void;
  dispose(): void;
}

export function createGpu(width = 16, height = 16): Gpu {
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false }) as GL | null;
  if (!gl) throw new Error("This browser has no WebGL2, which Particle Match needs.");
  if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("This GPU cannot render to float textures, which Particle Match needs.");
  const quad = gl.createVertexArray()!;
  gl.bindVertexArray(quad);
  const corners = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const programs = new Map<string, WebGLProgram>();
  const locations = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  const created: (WebGLTexture | WebGLFramebuffer)[] = [];

  const texture = (w: number, h: number, format: number, linear: boolean) => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };

  const gpu: Gpu = {
    gl,
    canvas,
    surface(w, h, format, linear = false) {
      const t = texture(w, h, format, linear);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("an analysis render target is not supported");
      created.push(t, framebuffer);
      return { texture: t, framebuffer, width: w, height: h, format };
    },
    multi(w, h, format, count) {
      const textures = Array.from({ length: count }, () => texture(w, h, format, false));
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      textures.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("an analysis render target is not supported");
      created.push(...textures, framebuffer);
      return { framebuffer, textures, width: w, height: h };
    },
    program(fragment) {
      let p = programs.get(fragment);
      if (!p) programs.set(fragment, (p = compile(gl, FULLSCREEN_VS, fragment)));
      return p;
    },
    pass(program, out, inputs, uniforms) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.framebuffer : null);
      gl.viewport(0, 0, out ? out.width : canvas.width, out ? out.height : canvas.height);
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(program);
      inputs.forEach((t, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
      });
      let cache = locations.get(program);
      if (!cache) locations.set(program, (cache = new Map()));
      const u = (name: string) => {
        if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
        return cache.get(name)!;
      };
      uniforms?.(u);
      gl.bindVertexArray(quad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
    release(surface) {
      gl.deleteTexture(surface.texture);
      gl.deleteFramebuffer(surface.framebuffer);
    },
    dispose() {
      for (const o of created) {
        if (o instanceof WebGLTexture) gl.deleteTexture(o);
        else gl.deleteFramebuffer(o as WebGLFramebuffer);
      }
      for (const p of programs.values()) gl.deleteProgram(p);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
  return gpu;
}

/** An RGBA8 texture for video frames (rows top first, as uploaded). */
export function frameTexture(gl: GL, width: number, height: number): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** Copies a decoded picture into a frame texture (no flip: row 0 is the picture's top). */
export function uploadFrame(gl: GL, texture: WebGLTexture, source: TexImageSource): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
}

interface PendingRead<T> {
  tag: T;
  buffers: { buffer: WebGLBuffer; floats: number }[];
  fence: WebGLSync;
}

/**
 * Reads float RGBA framebuffer attachments back without waiting for the GPU: each read goes into pixel-pack
 * buffers behind a fence, and `collect` hands back, in issue order, the reads the GPU has finished. WebGL
 * cannot block on a fence, so a full queue (or `drain`) finishes its oldest read with a stalling read. Each
 * read gets buffers of its own: Chrome drops the copy that makes a fenced read fast when a buffer it made
 * one for is written again.
 */
export class ReadbackQueue<T> {
  private readonly gl: GL;
  private readonly depth: number;
  private readonly pending: PendingRead<T>[] = [];

  constructor(gl: GL, depth = 3) {
    this.gl = gl;
    this.depth = depth;
  }

  /** Queues reads of `attachments` of `framebuffer` (`width` × `height` RGBA floats each), tagged `tag`. */
  read(tag: T, framebuffer: WebGLFramebuffer, attachments: number[], width: number, height: number): { tag: T; data: Float32Array[] }[] {
    const { gl } = this;
    const done = this.pending.length >= this.depth ? [this.finish(this.pending.shift()!)] : [];
    const floats = width * height * 4;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    const buffers = attachments.map((attachment) => {
      const slot = { buffer: gl.createBuffer()!, floats };
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, floats * 4, gl.STREAM_READ);
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, 0);
      return slot;
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    this.pending.push({ tag, buffers, fence: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)! });
    gl.flush();
    return done;
  }

  /** The reads the GPU has finished, oldest first. */
  collect(): { tag: T; data: Float32Array[] }[] {
    const { gl } = this;
    const out: { tag: T; data: Float32Array[] }[] = [];
    while (this.pending.length) {
      const status = gl.clientWaitSync(this.pending[0].fence, 0, 0);
      if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) break;
      out.push(this.finish(this.pending.shift()!));
    }
    return out;
  }

  /** Every queued read, oldest first. */
  drain(): { tag: T; data: Float32Array[] }[] {
    const out = this.collect();
    while (this.pending.length) out.push(this.finish(this.pending.shift()!));
    return out;
  }

  get size(): number {
    return this.pending.length;
  }

  private finish(read: PendingRead<T>): { tag: T; data: Float32Array[] } {
    const { gl } = this;
    gl.deleteSync(read.fence);
    const data = read.buffers.map((slot) => {
      const out = new Float32Array(slot.floats);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
      gl.deleteBuffer(slot.buffer);
      return out;
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return { tag: read.tag, data };
  }

  dispose(): void {
    for (const read of this.pending) {
      this.gl.deleteSync(read.fence);
      for (const slot of read.buffers) this.gl.deleteBuffer(slot.buffer);
    }
    this.pending.length = 0;
  }
}

/** Reads a float RGBA framebuffer attachment. */
export function readFloats(gl: GL, framebuffer: WebGLFramebuffer, attachment: number, width: number, height: number, into?: Float32Array): Float32Array {
  const out = into && into.length >= width * height * 4 ? into : new Float32Array(width * height * 4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
  gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  return out;
}
