// Keylight (1.2): screen-colour keying with the model of keylightMath.ts.
import { effectNumber, effectVector } from "../effectParams.ts";
import { registerEffect } from "../registry.ts";
import { mapPass, PASS_HEADER } from "./fxextraUtil.ts";
import { screenChannels } from "./keylightMath.ts";

const KEYLIGHT_FS = `${PASS_HEADER}
uniform int u_view;
uniform int u_unpremultiply;
uniform int u_ignoreAlpha;
uniform vec3 u_screen;
uniform vec3 u_gainedScreen;
uniform ivec3 u_channels;
uniform float u_gain2;
uniform float u_balance;
uniform float u_clipBlack;
uniform float u_clipWhite;
uniform int u_softColour;
uniform vec3 u_replace;
uniform vec2 u_size;
uniform float u_pad;

float sat(vec3 c) { return c[u_channels.x] - (u_balance * c[u_channels.y] + (1.0 - u_balance) * c[u_channels.z]); }

void main() {
  // Exact texels: a filtered sample can pick up a trace of a neighbour's alpha, and the matte is a
  // ratio of colour to alpha, so that trace would key as the neighbour's full colour.
  vec4 src = texelFetch(u_source, ivec2(gl_FragCoord.xy), 0);
  float a = src.a;
  vec3 straight = a > 0.0 ? src.rgb / a : vec3(0.0);
  float screenSat = sat(u_screen);
  float k = screenSat > 0.0 ? max(0.0, sat(straight) / screenSat) : 0.0;
  vec3 fg = straight - k * u_gainedScreen;
  float raw = clamp(max(1.0 - u_gain2 * k, max(fg.r, max(fg.g, fg.b))), 0.0, 1.0);
  float matte = u_clipWhite > u_clipBlack ? clamp((raw - u_clipBlack) / (u_clipWhite - u_clipBlack), 0.0, 1.0) : step(u_clipBlack, raw);
  // Opaque views (Screen Matte, Source Alpha = Ignore) must leave the border outside the layer transparent.
  vec2 px = v_uv * u_size;
  if (px.x < u_pad || px.y < u_pad || px.x > u_size.x - u_pad || px.y > u_size.y - u_pad) {
    outColor = vec4(0.0);
    return;
  }
  if (u_view == 5) {
    outColor = vec4(vec3(matte), 1.0);
    return;
  }
  float alpha = u_ignoreAlpha == 1 ? matte : matte * a;
  vec3 colour;
  float soft = 0.0;
  if (u_view == 10) colour = src.rgb * matte;
  else {
    vec3 source = u_ignoreAlpha == 1 ? straight : src.rgb;
    float kp = screenSat > 0.0 ? max(0.0, sat(source) / screenSat) : 0.0;
    vec3 d = max(source - kp * u_gainedScreen, 0.0);
    // Where clipping lowers the matte, the foreground fades with it.
    float fade = raw > 0.0 ? min(1.0, matte / raw) : 0.0;
    colour = d * fade * (u_unpremultiply == 1 ? 1.0 : alpha);
    if (u_softColour == 1 && matte > 0.0) soft = max(0.0, matte - raw) * k * raw * (u_ignoreAlpha == 1 ? 1.0 : a) / matte;
  }
  // The despilled colour is premultiplied by the matte already (Unpremultiply Result keeps it so).
  outColor = vec4(min(vec3(alpha), colour + soft * u_replace), alpha);
}`;

/** Parameters left at these values do not change the result; others are not modelled. */
const NEUTRAL: [number, number, string][] = [
  [10, 0, "screen pre-blur"],
  [14, 0, "clip rollback"],
  [15, 0, "screen shrink/grow"],
  [16, 0, "screen softness"],
  [17, 0, "screen despot black"],
  [18, 0, "screen despot white"],
  [36, 0, "foreground colour correction"],
  [52, 0, "edge colour correction"],
  [75, 0, "source crop left"],
  [76, 100, "source crop right"],
  [77, 0, "source crop top"],
  [78, 100, "source crop bottom"],
];

registerEffect("Keylight 906", (input, effect, layer, time, ctx) => {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  let view = num(2, 11);
  if (view !== 5 && view !== 10 && view !== 11) {
    ctx.warn(`Keylight view ${view} is shown as Final Result`);
    view = 11;
  }
  const screen = effectVector(effect, 4, layer, time, [0, 1, 0, 1]).slice(0, 3);
  const gain = num(5, 100) / 100;
  const clipBlack = num(12, 0) / 100;
  const clipWhite = num(13, 100) / 100;
  const replaceMethod = num(19, 4);
  const replace = effectVector(effect, 20, layer, time, [0.5, 0.5, 0.5, 1]);
  const clipped = clipBlack !== 0 || clipWhite !== 1;
  if (view === 11 && clipped && replaceMethod !== 4) ctx.warn(`Keylight replace method ${replaceMethod} is drawn as Soft Colour`);
  for (const [index, neutral, label] of NEUTRAL) {
    if (num(index, neutral) !== neutral) ctx.warn(`Keylight ${label} is not rendered yet`);
  }
  // Screen Gain scales the screen colour's chroma by the gain and its grey level by the gain squared.
  const mean = (screen[0] + screen[1] + screen[2]) / 3;
  const gained = screen.map((v) => gain * v + gain * (gain - 1) * mean);
  const [ip, ia, ib] = screenChannels(screen);
  return mapPass(ctx, input, KEYLIGHT_FS, (uniform) => {
    const gl = ctx.gl;
    gl.uniform1i(uniform("u_view"), view);
    gl.uniform1i(uniform("u_unpremultiply"), num(3, 1) ? 1 : 0);
    gl.uniform1i(uniform("u_ignoreAlpha"), num(28, 3) === 1 ? 1 : 0);
    gl.uniform3f(uniform("u_screen"), screen[0], screen[1], screen[2]);
    gl.uniform3f(uniform("u_gainedScreen"), gained[0], gained[1], gained[2]);
    gl.uniform3i(uniform("u_channels"), ip, ia, ib);
    gl.uniform1f(uniform("u_gain2"), gain * gain);
    gl.uniform1f(uniform("u_balance"), num(6, 50) / 100);
    gl.uniform1f(uniform("u_clipBlack"), clipBlack);
    gl.uniform1f(uniform("u_clipWhite"), clipWhite);
    gl.uniform1i(uniform("u_softColour"), clipped ? 1 : 0);
    gl.uniform3f(uniform("u_replace"), replace[0], replace[1], replace[2]);
  });
}, { cacheable: true, scalable: true });
