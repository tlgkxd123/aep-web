// Trapcode Particular: a deterministic look-alike, not a reproduction. Particular's
// particle positions come from its own random generator, so this draws a seeded
// particle system from the stored emitter, physics and particle settings (system 1
// only): particles born at the emission rate inside the emitter box, moving with
// their velocity plus wind, seen through the default comp camera, drawn as soft
// white dots with a glow halo. It replaces the layer's pixels as Particular does.
import { effectNumber, effectVector } from "../effectParams.ts";
import { registerEffect } from "../registry.ts";
import { writeTarget } from "./fxextraUtil.ts";

/** Deterministic uniform random numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adds a soft disc of radius r (feathered over its outer `feather` share) to a premultiplied float buffer. */
function splat(buffer: Float32Array, width: number, height: number, cx: number, cy: number, radius: number, feather: number, opacity: number) {
  // Dots below a pixel keep their area as fainter one-pixel dots.
  const r = Math.max(radius, 0.75);
  opacity *= Math.min(1, (radius / r) ** 2);
  const reach = r + 1;
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(width - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(height - 1, Math.ceil(cy + reach));
  const inner = r * (1 - feather);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cover = d <= inner ? 1 : d >= r ? 0 : 1 - (d - inner) / Math.max(1e-6, r - inner);
      const a = opacity * cover;
      if (a <= 0) continue;
      const i = (y * width + x) * 4 + 3;
      buffer[i] = a + buffer[i] * (1 - a);
    }
  }
}

registerEffect("tc Particular", (input, effect, layer, time, ctx) => {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  ctx.warn("Particular is drawn with a seeded look-alike; particle positions do not match After Effects");
  const rate = Math.max(0, num(146, 100));
  const emitterType = num(5, 1);
  const position = effectVector(effect, 581, layer, time, [input.width / 2, input.height / 2, 0]);
  const size = [num(14, 50), num(15, 50), num(16, 50)];
  const velocity = num(11, 100);
  const velocityRandom = num(12, 20) / 100;
  const life = Math.max(0, num(2, 3));
  const lifeRandom = num(65, 0) / 100;
  const particleSize = Math.max(0, num(27, 4));
  const sizeRandom = num(74, 0) / 100;
  const opacity = num(33, 100) / 100;
  const opacityRandom = num(75, 0) / 100;
  const feather = num(29, 50) / 100;
  const glowSize = num(215, 300) / 100;
  const glowOpacity = num(216, 25) / 100;
  const timeFactor = num(25, 1);
  const wind = [num(22, 0), num(23, 0), num(24, 0)];
  const rand = random(num(230, 100000));

  const width = input.width;
  const height = input.height;
  const buffer = new Float32Array(width * height * 4);
  // Default comp camera: 50 mm equivalent, looking at the comp centre from z = -zoom.
  const zoom = (width / 2) / Math.tan((39.6 * Math.PI) / 360);
  const born = Math.floor(time * rate + 1e-6);
  for (let i = 0; i <= born; i++) {
    const birth = i / Math.max(rate, 1e-6);
    const box = emitterType === 1 ? [0, 0, 0] : [rand() - 0.5, rand() - 0.5, rand() - 0.5];
    const dir = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
    const speed = velocity * (1 - velocityRandom * rand());
    const lifeSpan = life * (1 - lifeRandom * 0.5 * rand());
    const pSize = particleSize * (1 - sizeRandom * rand());
    const pOpacity = opacity * (1 - opacityRandom * rand());
    const age = time - birth;
    if (age < 0 || age > lifeSpan) continue;
    const t = age * timeFactor;
    const norm = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const p = [0, 1, 2].map((c) => position[c] + box[c] * size[c] + (dir[c] / norm) * speed * t + wind[c] * t);
    const scale = zoom / Math.max(1, zoom + p[2]);
    const sx = width / 2 + (p[0] - width / 2) * scale;
    const sy = height / 2 + (p[1] - height / 2) * scale;
    const r = (pSize * scale) / 2;
    splat(buffer, width, height, sx, sy, r * glowSize, 1, pOpacity * glowOpacity);
    splat(buffer, width, height, sx, sy, r, feather, pOpacity);
  }
  const pad = ctx.pad;
  const out = ctx.pool.acquire(width + 2 * pad, height + 2 * pad);
  const tw = out.width;
  const data = new Uint8Array(tw * out.height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = buffer[(y * width + x) * 4 + 3];
      if (!a) continue;
      // GL row order: row 0 is the bottom of the image.
      const o = ((out.height - 1 - pad - y) * tw + x + pad) * 4;
      const v = Math.round(a * 255);
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = v;
    }
  }
  ctx.pool.release(input.target);
  const image = { ...input, target: out };
  writeTarget(ctx, image, data);
  return image;
});
