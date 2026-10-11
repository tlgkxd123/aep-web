// Stock Generate, Channel and Matte effects that colour or matte the layer:
// Fill, Set Matte and Simple Choker. Look-alikes from the effects' documented
// behaviour, not yet measured against After Effects renders.
import type { CompItem, Layer } from "../../aep/model.ts";
import type { LayerImage, RenderContext } from "../registry.ts";
import { grown, mapPass, PASS_HEADER } from "./fxextraUtil.ts";
import { COLOR_LIB, imageRect, layerPass, layerRect, registerStock } from "./stockUtil.ts";

const FILL_FS = `${PASS_HEADER}
uniform vec3 u_color;
uniform float u_opacity;
void main() {
  vec4 c = texture(u_source, v_uv);
  outColor = mix(c, vec4(u_color * c.a, c.a), u_opacity);
}`;

// Fill: the layer's colour replaced by Color at Opacity (0..1), keeping its alpha. Filling only within one of its
// masks is not drawn: a mask in Add mode already limits the layer to its area, so the whole layer is filled.
registerStock("ADBE Fill", (input, p, ctx) => {
  const opacity = Math.min(1, Math.max(0, p.num(5, 1)));
  const masked = p.num(1, 0) !== 0 || p.bool(7, false);
  const inverted = p.bool(6, false);
  if (masked) ctx.warn("Fill: filling within a mask is drawn as filling the whole layer");
  if (inverted || opacity <= 0) {
    if (inverted && masked) ctx.warn("Fill: an inverted mask fill is not drawn");
    return input;
  }
  return mapPass(ctx, input, FILL_FS, (u) => {
    ctx.gl.uniform3fv(u("u_color"), p.rgb(2, [1, 0, 0]));
    ctx.gl.uniform1f(u("u_opacity"), opacity);
  });
});

/** The composition a layer belongs to. */
function compOf(ctx: RenderContext, layer: Layer): CompItem | undefined {
  for (const item of ctx.project.items.values()) if (item.kind === "comp" && item.layers.includes(layer)) return item;
  return undefined;
}

/** Set Matte's Use For Matte popup. */
const MatteChannel = { RED: 1, GREEN: 2, BLUE: 3, ALPHA: 4, LUMINANCE: 5, HUE: 6, LIGHTNESS: 7, SATURATION: 8, FULL: 9, OFF: 10 } as const;

// Set Matte: the layer's alpha from a channel of another layer's source (the layer itself when none is chosen),
// stretched over the layer's box or centred on it, optionally inverted, times the layer's own alpha with Composite
// Matte with Original; Premultiply Matte Layer reads the matte layer's colour premultiplied.
registerStock("ADBE Set Matte3", (input, p, ctx, layer, time) => {
  const channel = p.num(2, MatteChannel.ALPHA);
  if (channel === MatteChannel.OFF) return input;
  const k = input.scale ?? 1;
  const index = Math.round(p.num(1, 0));
  const other = index > 0 ? compOf(ctx, layer)?.layers.find((l) => l.index === index && l !== layer) : undefined;
  const matte: LayerImage | null = other ? ctx.layerImage(other, time, false) : input;
  const rect = layerRect(layer, input);
  // Matte layer point = scale * layer point + offset, per axis.
  let scale = [1, 1];
  let offset = [0, 0];
  if (matte && matte !== input && other) {
    const mk = matte.scale ?? 1;
    const mrect = layerRect(other, matte);
    if (p.bool(4, true)) scale = [mrect.width / rect.width, mrect.height / rect.height];
    else scale = [mk / k, mk / k];
    offset = [mrect.x + mrect.width / 2 - (rect.x + rect.width / 2) * scale[0], mrect.y + mrect.height / 2 - (rect.y + rect.height / 2) * scale[1]];
  }
  const out = layerPass(
    ctx,
    imageRect(input),
    matte ? [input, matte] : [input],
    `uniform int u_channel;
uniform int u_hasMatte;
uniform int u_invert;
uniform int u_composite;
uniform int u_premultiply;
uniform vec2 u_scale;
uniform vec2 u_offset;`,
    `  vec4 c = at(0, p);
  vec4 m = u_hasMatte == 1 ? at(1, p * u_scale + u_offset) : vec4(0.0);
  vec3 s = u_premultiply == 1 ? m.rgb : straight(m);
  vec3 hsl = rgb2hsl(straight(m));
  float v;
  if (u_channel == 1) v = s.r;
  else if (u_channel == 2) v = s.g;
  else if (u_channel == 3) v = s.b;
  else if (u_channel == 4) v = m.a;
  else if (u_channel == 5) v = luma(s);
  else if (u_channel == 6) v = hsl.x;
  else if (u_channel == 7) v = hsl.z;
  else if (u_channel == 8) v = hsl.y;
  else v = 1.0;
  if (u_invert == 1) v = 1.0 - v;
  float a = u_composite == 1 ? c.a * v : v;
  outColor = vec4(straight(c) * a, a);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform1i(u("u_channel"), channel);
      gl.uniform1i(u("u_hasMatte"), matte ? 1 : 0);
      gl.uniform1i(u("u_invert"), p.bool(3, false) ? 1 : 0);
      gl.uniform1i(u("u_composite"), p.bool(5, true) ? 1 : 0);
      gl.uniform1i(u("u_premultiply"), p.bool(6, true) ? 1 : 0);
      gl.uniform2f(u("u_scale"), scale[0], scale[1]);
      gl.uniform2f(u("u_offset"), offset[0], offset[1]);
    },
    input.scale,
  );
  if (matte && matte !== input) ctx.pool.release(matte.target);
  ctx.pool.release(input.target);
  return out;
});

/** Choke (layer pixels) up to which Simple Choker uses a round neighbourhood; beyond it, a square one. */
const ROUND_CHOKE = 24;

const CHOKE_FS = `${PASS_HEADER}${COLOR_LIB}
uniform vec2 u_size;
uniform float u_pad;
uniform float u_radius;
uniform int u_reach;
uniform int u_erode;
uniform vec2 u_dir;
uniform int u_round;
uniform int u_matte;
vec4 tap(vec2 px) {
  if (px.x < u_pad || px.y < u_pad || px.x > u_size.x - u_pad || px.y > u_size.y - u_pad) return vec4(0.0);
  return texture(u_source, px / u_size);
}
void main() {
  vec2 px = v_uv * u_size;
  vec4 here = tap(px);
  vec4 best = here;
  if (u_round == 1) {
    for (int j = -u_reach; j <= u_reach; j++)
      for (int i = -u_reach; i <= u_reach; i++) {
        if (float(i * i + j * j) > u_radius * u_radius) continue;
        vec4 t = tap(px + vec2(i, j));
        if (u_erode == 1 ? t.a < best.a : t.a > best.a) best = t;
      }
  } else {
    for (int i = -u_reach; i <= u_reach; i++) {
      vec4 t = tap(px + u_dir * float(i));
      if (u_erode == 1 ? t.a < best.a : t.a > best.a) best = t;
    }
  }
  float a = best.a;
  vec3 s = here.a > 0.0 ? straight(here) : straight(best);
  outColor = u_matte == 1 ? vec4(vec3(a), 1.0) : vec4(s * a, a);
}`;

function choke(ctx: RenderContext, image: LayerImage, radius: number, round: boolean, erode: boolean, matteView: boolean): LayerImage {
  const reach = Math.ceil(radius - 1e-6);
  const passes: [number, number][] = round ? [[0, 0]] : [[1, 0], [0, 1]];
  passes.forEach((dir, i) => {
    image = mapPass(ctx, image, CHOKE_FS, (u) => {
      const gl = ctx.gl;
      gl.uniform1f(u("u_radius"), radius);
      gl.uniform1i(u("u_reach"), reach);
      gl.uniform1i(u("u_erode"), erode ? 1 : 0);
      gl.uniform2f(u("u_dir"), dir[0], dir[1]);
      gl.uniform1i(u("u_round"), round ? 1 : 0);
      gl.uniform1i(u("u_matte"), matteView && i === passes.length - 1 ? 1 : 0);
    });
  });
  return image;
}

// Simple Choker: the alpha shrunk (positive Choke Matte) or spread (negative) by that many pixels; View Matte
// shows the resulting alpha as grey.
registerStock("ADBE Simple Choker", (input, p, ctx) => {
  const amount = p.num(2, 0);
  const matteView = p.num(1, 1) === 2;
  if (Math.abs(amount) < 0.05) return matteView ? choke(ctx, input, 0, true, true, true) : input;
  const radius = Math.min(256, Math.abs(amount) * (input.scale ?? 1));
  const image = amount < 0 ? grown(ctx, input, Math.ceil(radius)) : input;
  return choke(ctx, image, radius, Math.abs(amount) <= ROUND_CHOKE, amount > 0, matteView);
});
