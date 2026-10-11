// Small WebGL2 helpers: programs, render targets and a unit quad.

export type GL = WebGL2RenderingContext;

export interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

export function compile(gl: GL, vertex: string, fragment: string): WebGLProgram {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(program, 0, "a_corner");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}

export function createTexture(gl: GL, width: number, height: number, linear = true): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** Frames a pooled target may go unused before it is deleted. */
const KEEP_FRAMES = 2;

/**
 * Pools render targets by size so a frame does not allocate textures per layer, and a frame does not allocate
 * what the frame before it used: allocating hundreds of megabytes of targets per frame stalls the GPU process.
 */
export class TargetPool {
  private readonly free = new Map<string, Target[]>();
  private readonly released = new Map<Target, number>();
  /** Frame in which each pooled target was last released. */
  private readonly lastFrame = new Map<Target, number>();
  private releases = 0;
  private frame = 0;
  private freeBytes = 0;
  private readonly gl: GL;
  constructor(gl: GL) {
    this.gl = gl;
  }

  /**
   * A width x height target, bound with its viewport set and cleared to transparent; `clear` false leaves its old
   * pixels for a caller that overwrites every one of them.
   */
  acquire(width: number, height: number, clear = true): Target {
    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));
    const list = this.free.get(`${w}x${h}`);
    const pooled = list?.pop();
    if (pooled) {
      this.released.delete(pooled);
      this.lastFrame.delete(pooled);
      this.freeBytes -= w * h * 4;
    }
    const target = pooled ?? this.create(w, h);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, w, h);
    if (clear || !pooled) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return target;
  }

  release(target: Target): void {
    const key = `${target.width}x${target.height}`;
    const list = this.free.get(key) ?? [];
    list.push(target);
    this.free.set(key, list);
    this.released.set(target, ++this.releases);
    this.lastFrame.set(target, this.frame);
    this.freeBytes += target.width * target.height * 4;
  }

  /**
   * Ends a frame: deletes pooled targets the last KEEP_FRAMES frames did not use (content whose size changes every
   * frame, such as animated shapes, would otherwise leave one texture per size behind), then least recently
   * released ones until at most `maxBytes` stay pooled.
   */
  trim(maxBytes: number): void {
    for (const [key, list] of this.free) {
      const keep = list.filter((t) => this.frame - this.lastFrame.get(t)! < KEEP_FRAMES);
      if (keep.length === list.length) continue;
      for (const t of list) if (!keep.includes(t)) this.delete(t);
      if (keep.length) this.free.set(key, keep);
      else this.free.delete(key);
    }
    while (this.freeBytes > maxBytes) {
      let oldest: Target[] | undefined;
      for (const list of this.free.values()) {
        if (list.length && (!oldest || this.released.get(list[0])! < this.released.get(oldest[0])!)) oldest = list;
      }
      const target = oldest?.shift();
      if (!target) break;
      this.delete(target);
    }
    this.frame++;
  }

  private delete(target: Target): void {
    this.released.delete(target);
    this.lastFrame.delete(target);
    this.freeBytes -= target.width * target.height * 4;
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }

  private create(width: number, height: number): Target {
    const gl = this.gl;
    const texture = createTexture(gl, width, height);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, framebuffer, width, height };
  }
}

/**
 * Drops WebGL calls that would not change anything: the program, framebuffer, texture, vertex array, viewport,
 * scissor box, capability, blend function, clear colour, pixel store mode or uniform value already set. The browser's
 * GPU process validates and translates every call whether or not it changes state, and a frame makes thousands of
 * them (each pass sets its samplers, binds its target, disables blending...), enough to take longer than the GPU's
 * own work at reduced resolutions. Patches `gl` in place: everything drawing with this context goes through it.
 */
export function filterRedundantState(gl: GL): void {
  const proto = Object.getPrototypeOf(gl) as GL;
  const call = <K extends keyof GL>(name: K, args: unknown[]) => (proto[name] as (...a: unknown[]) => unknown).apply(gl, args);
  const patch = <K extends keyof GL>(name: K, fn: (...args: any[]) => unknown) => {
    (gl as unknown as Record<string, unknown>)[name] = fn;
  };
  const sameList = (a: ArrayLike<unknown> | undefined, b: ArrayLike<unknown>) => {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  // undefined: not known (the first call always goes through); null: nothing bound.
  let program: WebGLProgram | null | undefined;
  let drawFramebuffer: WebGLFramebuffer | null | undefined;
  let readFramebuffer: WebGLFramebuffer | null | undefined;
  let vertexArray: WebGLVertexArrayObject | null | undefined;
  let unit: number = gl.TEXTURE0;
  const textures = new Map<number, WebGLTexture | null>();
  let viewport: number[] | undefined;
  let scissor: number[] | undefined;
  let clearColor: number[] | undefined;
  let blendFunc: number[] | undefined;
  let blendEquation: number[] | undefined;
  const capabilities = new Map<number, boolean>();
  const pixelStore = new Map<number, unknown>();
  const uniforms = new WeakMap<WebGLUniformLocation, unknown[]>();

  patch("useProgram", (p: WebGLProgram | null) => {
    if (p === program) return;
    program = p;
    call("useProgram", [p]);
  });
  patch("bindFramebuffer", (target: number, fb: WebGLFramebuffer | null) => {
    const draw = target !== gl.READ_FRAMEBUFFER;
    const read = target !== gl.DRAW_FRAMEBUFFER;
    if ((!draw || fb === drawFramebuffer) && (!read || fb === readFramebuffer)) return;
    if (draw) drawFramebuffer = fb;
    if (read) readFramebuffer = fb;
    call("bindFramebuffer", [target, fb]);
  });
  patch("bindVertexArray", (vao: WebGLVertexArrayObject | null) => {
    if (vao === vertexArray) return;
    vertexArray = vao;
    call("bindVertexArray", [vao]);
  });
  patch("activeTexture", (texture: number) => {
    if (texture === unit) return;
    unit = texture;
    call("activeTexture", [texture]);
  });
  patch("bindTexture", (target: number, texture: WebGLTexture | null) => {
    if (target !== gl.TEXTURE_2D) return call("bindTexture", [target, texture]);
    if (textures.has(unit) && textures.get(unit) === texture) return;
    textures.set(unit, texture);
    call("bindTexture", [target, texture]);
  });
  const listState = (name: "viewport" | "scissor" | "clearColor" | "blendFunc" | "blendEquation", get: () => number[] | undefined, set: (v: number[]) => void) =>
    patch(name, (...args: number[]) => {
      if (sameList(get(), args)) return;
      set(args);
      call(name, args);
    });
  listState("viewport", () => viewport, (v) => (viewport = v));
  listState("scissor", () => scissor, (v) => (scissor = v));
  listState("clearColor", () => clearColor, (v) => (clearColor = v));
  listState("blendFunc", () => blendFunc, (v) => (blendFunc = v));
  listState("blendEquation", () => blendEquation, (v) => (blendEquation = v));
  patch("blendFuncSeparate", (...args: number[]) => {
    blendFunc = undefined;
    call("blendFuncSeparate", args);
  });
  patch("blendEquationSeparate", (...args: number[]) => {
    blendEquation = undefined;
    call("blendEquationSeparate", args);
  });
  for (const [name, on] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    patch(name, (cap: number) => {
      if (capabilities.get(cap) === on) return;
      capabilities.set(cap, on);
      call(name, [cap]);
    });
  }
  patch("pixelStorei", (pname: number, value: unknown) => {
    if (pixelStore.has(pname) && pixelStore.get(pname) === value) return;
    pixelStore.set(pname, value);
    call("pixelStorei", [pname, value]);
  });
  for (const name of ["uniform1i", "uniform1f", "uniform2i", "uniform2f", "uniform3i", "uniform3f", "uniform4i", "uniform4f"] as const) {
    patch(name, (location: WebGLUniformLocation | null, ...values: unknown[]) => {
      if (location) {
        if (sameList(uniforms.get(location), values)) return;
        uniforms.set(location, values);
      }
      call(name, [location, ...values]);
    });
  }
  for (const name of ["uniform1fv", "uniform2fv", "uniform3fv", "uniform4fv", "uniform1iv", "uniform2iv", "uniform3iv", "uniform4iv"] as const) {
    patch(name, (location: WebGLUniformLocation | null, data: ArrayLike<number>, ...rest: unknown[]) => {
      if (location && !rest.length) {
        if (sameList(uniforms.get(location), data)) return;
        uniforms.set(location, Array.from(data));
      } else if (location) uniforms.delete(location);
      call(name, [location, data, ...rest]);
    });
  }
  for (const name of ["uniformMatrix2fv", "uniformMatrix3fv", "uniformMatrix4fv"] as const) {
    patch(name, (location: WebGLUniformLocation | null, transpose: boolean, data: ArrayLike<number>, ...rest: unknown[]) => {
      if (location && !rest.length) {
        const values = [transpose, ...Array.from(data)];
        if (sameList(uniforms.get(location), values)) return;
        uniforms.set(location, values);
      } else if (location) uniforms.delete(location);
      call(name, [location, transpose, data, ...rest]);
    });
  }
  // Deleting a bound object unbinds it.
  patch("deleteProgram", (p: WebGLProgram | null) => {
    if (p && p === program) program = undefined;
    call("deleteProgram", [p]);
  });
  patch("deleteFramebuffer", (fb: WebGLFramebuffer | null) => {
    if (fb && fb === drawFramebuffer) drawFramebuffer = null;
    if (fb && fb === readFramebuffer) readFramebuffer = null;
    call("deleteFramebuffer", [fb]);
  });
  patch("deleteVertexArray", (vao: WebGLVertexArrayObject | null) => {
    if (vao && vao === vertexArray) vertexArray = null;
    call("deleteVertexArray", [vao]);
  });
  patch("deleteTexture", (texture: WebGLTexture | null) => {
    for (const [u, t] of textures) if (texture && t === texture) textures.set(u, null);
    call("deleteTexture", [texture]);
  });
}

const syncTargets = new WeakMap<GL, WebGLFramebuffer>();

/**
 * Blocks until the GPU has run every command issued so far, for profiling. Chrome's gl.finish() only flushes;
 * reading a pixel back has to wait for the GPU.
 */
export function finishGpu(gl: GL): void {
  let framebuffer = syncTargets.get(gl);
  if (!framebuffer) {
    framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, createTexture(gl, 1, 1, false), 0);
    syncTargets.set(gl, framebuffer);
  }
  const bound = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, bound);
}

export function bindTarget(gl: GL, target: Target | null, width?: number, height?: number): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
  gl.viewport(0, 0, target ? target.width : width!, target ? target.height : height!);
}

/** A VAO holding the unit square (0,0)-(1,1) as a triangle strip on attribute 0. */
export function unitQuad(gl: GL): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}
