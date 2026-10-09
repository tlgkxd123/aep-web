// Float render targets for effects whose intermediate passes must not round to
// 8 bits (running sums, linear-light glows). RGBA32F targets are for texelFetch
// (float32 is not filterable everywhere); RGBA16F ones (`half`) filter linearly.
// Contexts that cannot render to float get RGBA8 targets from the regular pool.
import type { GL, Target } from "./gl.ts";
import type { RenderContext } from "./registry.ts";

interface FloatPool {
  supported: boolean;
  free: Map<string, Target[]>;
  freeBytes: number;
  owned: WeakSet<Target>;
  /** Frame in which each pooled target was last released. */
  lastFrame: Map<Target, number>;
  frame: number;
}

/** Frames a pooled float target may go unused before it is deleted. */
const KEEP_FRAMES = 2;
const pools = new WeakMap<GL, FloatPool>();
const halfTargets = new WeakSet<Target>();

function poolOf(gl: GL): FloatPool {
  let pool = pools.get(gl);
  if (!pool) {
    pool = { supported: !!gl.getExtension("EXT_color_buffer_float"), free: new Map(), freeBytes: 0, owned: new WeakSet(), lastFrame: new Map(), frame: 0 };
    pools.set(gl, pool);
  }
  return pool;
}

const bytesOf = (t: Target) => t.width * t.height * (halfTargets.has(t) ? 8 : 16);

function deleteTarget(gl: GL, pool: FloatPool, t: Target): void {
  pool.freeBytes -= bytesOf(t);
  pool.lastFrame.delete(t);
  gl.deleteFramebuffer(t.framebuffer);
  gl.deleteTexture(t.texture);
}

/**
 * Ends a frame: deletes pooled float targets the last KEEP_FRAMES frames did not use, then the largest pools while
 * more than `maxBytes` stay pooled. A blur at a grown layer size uses several targets of over 100 MB each;
 * allocating them again every frame stalls the GPU process.
 */
export function trimFloat(gl: GL, maxBytes: number): void {
  const pool = pools.get(gl);
  if (!pool) return;
  for (const [key, list] of pool.free) {
    const keep = list.filter((t) => pool.frame - pool.lastFrame.get(t)! < KEEP_FRAMES);
    for (const t of list) if (!keep.includes(t)) deleteTarget(gl, pool, t);
    if (keep.length) pool.free.set(key, keep);
    else pool.free.delete(key);
  }
  for (const [key, list] of [...pool.free].sort((a, b) => bytesOf(b[1][0]) - bytesOf(a[1][0]))) {
    if (pool.freeBytes <= maxBytes) break;
    for (const t of list) deleteTarget(gl, pool, t);
    pool.free.delete(key);
  }
  pool.frame++;
}

/** Whether float targets really are float on this context. */
export function floatTargetsSupported(ctx: RenderContext): boolean {
  return poolOf(ctx.gl).supported;
}

/** A cleared width x height RGBA32F (or with `half`, linearly filtered RGBA16F) target, no border. Release with `releaseFloat`. */
export function acquireFloat(ctx: RenderContext, width: number, height: number, half = false): Target {
  const gl = ctx.gl;
  const pool = poolOf(gl);
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (!pool.supported) return ctx.pool.acquire(w, h);
  const key = `${w}x${h}${half ? "h" : ""}`;
  let target = pool.free.get(key)?.pop();
  if (target) {
    pool.freeBytes -= bytesOf(target);
    pool.lastFrame.delete(target);
  } else {
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, half ? gl.RGBA16F : gl.RGBA32F, w, h, 0, gl.RGBA, half ? gl.HALF_FLOAT : gl.FLOAT, null);
    const filter = half ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    target = { texture, framebuffer, width: w, height: h };
    pool.owned.add(target);
    if (half) halfTargets.add(target);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return target;
}

export function releaseFloat(ctx: RenderContext, ...targets: (Target | undefined)[]): void {
  const gl = ctx.gl;
  const pool = poolOf(gl);
  for (const target of targets) {
    if (!target) continue;
    if (!pool.owned.has(target)) {
      ctx.pool.release(target);
      continue;
    }
    const key = `${target.width}x${target.height}${halfTargets.has(target) ? "h" : ""}`;
    const list = pool.free.get(key) ?? [];
    list.push(target);
    pool.free.set(key, list);
    pool.freeBytes += bytesOf(target);
    pool.lastFrame.set(target, pool.frame);
  }
}
