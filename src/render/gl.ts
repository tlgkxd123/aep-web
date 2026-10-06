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

/** Pools render targets by size so a frame does not allocate textures per layer. */
export class TargetPool {
  private readonly free = new Map<string, Target[]>();
  private readonly released = new Map<Target, number>();
  private releases = 0;
  private freeBytes = 0;
  private readonly gl: GL;
  constructor(gl: GL) {
    this.gl = gl;
  }

  acquire(width: number, height: number): Target {
    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));
    const list = this.free.get(`${w}x${h}`);
    const pooled = list?.pop();
    if (pooled) {
      this.released.delete(pooled);
      this.freeBytes -= w * h * 4;
    }
    const target = pooled ?? this.create(w, h);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return target;
  }

  release(target: Target): void {
    const key = `${target.width}x${target.height}`;
    const list = this.free.get(key) ?? [];
    list.push(target);
    this.free.set(key, list);
    this.released.set(target, ++this.releases);
    this.freeBytes += target.width * target.height * 4;
  }

  /**
   * Deletes pooled targets, least recently released first, until at most
   * `maxBytes` stay pooled. Content whose size changes every frame (animated
   * shapes) would otherwise leave one texture per size behind.
   */
  trim(maxBytes: number): void {
    while (this.freeBytes > maxBytes) {
      let oldest: Target[] | undefined;
      for (const list of this.free.values()) {
        if (list.length && (!oldest || this.released.get(list[0])! < this.released.get(oldest[0])!)) oldest = list;
      }
      const target = oldest?.shift();
      if (!target) break;
      this.released.delete(target);
      this.freeBytes -= target.width * target.height * 4;
      this.gl.deleteFramebuffer(target.framebuffer);
      this.gl.deleteTexture(target.texture);
    }
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
