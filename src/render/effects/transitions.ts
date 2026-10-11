// Stock Transition effects that wipe the layer away by Transition Completion:
// Linear Wipe, Radial Wipe and Venetian Blinds. Angles are degrees clockwise
// from up; feathers are layer pixels. Look-alikes from the effects' documented
// behaviour, not yet measured against After Effects renders.
import { DEG, directionVector, linearWipeEdge, projectionRange } from "./stockMath.ts";
import { imageRect, layerPass, layerRect, registerStock } from "./stockUtil.ts";

const completionOf = (v: number) => Math.min(1, Math.max(0, v / 100));

// Linear Wipe: a straight edge sweeps along Wipe Angle (90 wipes from the left) across the layer's box.
registerStock("ADBE Linear Wipe", (input, p, ctx, layer) => {
  const completion = completionOf(p.num(1, 0));
  if (completion <= 0) return input;
  const k = input.scale ?? 1;
  const dir = directionVector(p.num(2, 90));
  const feather = Math.max(0, p.num(3, 0)) * k;
  const [lo, hi] = projectionRange(layerRect(layer, input), dir);
  const edge = linearWipeEdge(lo, hi, completion, feather);
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform vec2 u_dir;
uniform float u_edge;
uniform float u_feather;`,
    `  float d = u_edge - dot(p, u_dir);
  float cut = u_feather > 0.0 ? clamp(d / (2.0 * u_feather) + 0.5, 0.0, 1.0) : (d > 0.0 ? 1.0 : 0.0);
  outColor = at(0, p) * (1.0 - cut);`,
    (u) => {
      ctx.gl.uniform2f(u("u_dir"), dir[0], dir[1]);
      ctx.gl.uniform1f(u("u_edge"), edge);
      ctx.gl.uniform1f(u("u_feather"), feather);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

/** Radial Wipe's Wipe popup. */
const RadialWipe = { CLOCKWISE: 1, COUNTERCLOCKWISE: 2, BOTH: 3 } as const;

// Radial Wipe: a sector from Start Angle around Wipe Center opens by Completion x 360 degrees (clockwise,
// counterclockwise, or half each way); the feather softens its edges by arc length.
registerStock("ADBE Radial Wipe", (input, p, ctx, layer) => {
  const completion = completionOf(p.num(1, 0));
  if (completion <= 0) return input;
  const k = input.scale ?? 1;
  const rect = layerRect(layer, input);
  const [cx, cy] = p.vec(3, [(rect.x + rect.width / 2) / k, (rect.y + rect.height / 2) / k]);
  const mode = p.num(4, RadialWipe.CLOCKWISE);
  const half = completion * 180;
  // The wiped sector: half-width `half` around `middle`, in degrees from Start Angle.
  const middle = mode === RadialWipe.BOTH ? 0 : mode === RadialWipe.COUNTERCLOCKWISE ? -half : half;
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform vec2 u_center;
uniform float u_start;
uniform float u_middle;
uniform float u_half;
uniform float u_feather;`,
    `  vec2 v = p - u_center;
  float angle = degrees(atan(v.x, -v.y));
  float rel = mod(angle - u_start - u_middle + 180.0, 360.0) - 180.0;
  float d = u_half - abs(rel);
  float cut;
  if (u_half >= 180.0) cut = 1.0;
  else if (u_feather > 0.0) cut = clamp(radians(d) * length(v) / (2.0 * u_feather) + 0.5, 0.0, 1.0);
  else cut = d > 0.0 ? 1.0 : 0.0;
  outColor = at(0, p) * (1.0 - cut);`,
    (u) => {
      ctx.gl.uniform2f(u("u_center"), cx * k, cy * k);
      ctx.gl.uniform1f(u("u_start"), p.num(2, 0));
      ctx.gl.uniform1f(u("u_middle"), middle);
      ctx.gl.uniform1f(u("u_half"), half);
      ctx.gl.uniform1f(u("u_feather"), Math.max(0, p.num(5, 0)) * k);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

// Venetian Blinds: stripes of Width pixels across Direction (0 gives horizontal slats), each wiped from its
// start by Completion of its width.
registerStock("ADBE Venetian Blinds", (input, p, ctx, layer) => {
  const completion = completionOf(p.num(1, 0));
  if (completion <= 0) return input;
  const k = input.scale ?? 1;
  const rect = layerRect(layer, input);
  const angle = p.num(2, 0) * DEG;
  const width = Math.max(1e-3, p.num(3, 10)) * k;
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform vec2 u_origin0;
uniform vec2 u_dir;
uniform float u_width;
uniform float u_completion;
uniform float u_feather;`,
    `  float local = mod(dot(p - u_origin0, u_dir), u_width);
  float d = u_completion * u_width - local;
  float cut;
  if (u_completion >= 1.0) cut = 1.0;
  else if (u_feather > 0.0) cut = clamp(d / (2.0 * u_feather) + 0.5, 0.0, 1.0);
  else cut = d > 0.0 ? 1.0 : 0.0;
  outColor = at(0, p) * (1.0 - cut);`,
    (u) => {
      ctx.gl.uniform2f(u("u_origin0"), rect.x, rect.y);
      ctx.gl.uniform2f(u("u_dir"), Math.sin(angle), -Math.cos(angle));
      ctx.gl.uniform1f(u("u_width"), width);
      ctx.gl.uniform1f(u("u_completion"), completion);
      ctx.gl.uniform1f(u("u_feather"), Math.max(0, p.num(4, 0)) * k);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});
