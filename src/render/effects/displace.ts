// Stock Distort effects that move the layer's pixels by a field: Turbulent Displace, Wave Warp, Bulge, Twirl,
// Optics Compensation and Displacement Map. Each output pixel shows the input at the point the field gives
// (bilinear; transparent outside the layer). Points are layer pixels, times the image's scale at a reduced
// resolution. Look-alikes from the effects' documented behaviour, not yet measured against After Effects renders.
import { layerTimeAt } from "../../aep/evaluate.ts";
import type { LayerImage } from "../registry.ts";
import { FRACTAL_GLSL, FractalShape, NoiseType, NOISE_CELL, noiseSpace, octaveTransform, setFractalUniforms } from "./fractal.ts";
import { bulgeShape, directionVector, DisplaceChannel, opticsBounds, opticsFocals } from "./stockMath.ts";
import { clampRect, compOf, growRect, imageRect, layerCenter, layerPass, layerRect, registerStock, warp, type Rect } from "./stockUtil.ts";

const boxUniform = (gl: WebGL2RenderingContext, location: WebGLUniformLocation | null, r: Rect) => gl.uniform4f(location, r.x, r.y, r.width, r.height);

/** Turbulent Displace's Displacement menu. */
const DISPLACEMENT_MENU = ["Turbulent", "Bulge", "Twist", "Turbulent Smoother", "Bulge Smoother", "Twist Smoother", "Vertical Displacement", "Horizontal Displacement", "Cross Displacement"];
const Displacement = { TURBULENT: 1, BULGE: 2, TWIST: 3, TURBULENT_SMOOTHER: 4, BULGE_SMOOTHER: 5, TWIST_SMOOTHER: 6, VERTICAL: 7, HORIZONTAL: 8, CROSS: 9 } as const;

/** Turbulent Displace's Pinning menu (separators where After Effects' are taken to be). */
const TURBULENT_PINNING_MENU = ["None", "(-", "Pin All", "Pin Horizontal", "Pin Vertical", "(-", "Pin All Locked", "Pin Horizontal Locked", "Pin Vertical Locked"];

// Turbulent Displace: the layer moved by fractal noise (fractal.ts; cells Size pixels wide, anchored at Offset, Complexity
// octaves each half the size of the one before) up to Amount % of Size: Turbulent moves along two independent noises,
// Bulge along the noise's slope (out of its crests), Twist across it, Vertical, Horizontal and Cross along one noise;
// the Smoother kinds use spline-filtered noise. Pinning holds the chosen edges, easing over one Size; Resize Layer
// grows the layer by Amount. The Locked pinnings are drawn as the others.
registerStock("ADBE Turbulent Displace", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const size = Math.max(1, p.num(3, 100));
  const amount = (p.num(2, 50) / 100) * size * k;
  if (Math.abs(amount) < 1e-3) return input;
  const mode = p.choice(1, Displacement.TURBULENT, DISPLACEMENT_MENU);
  const smoother = mode === Displacement.TURBULENT_SMOOTHER || mode === Displacement.BULGE_SMOOTHER || mode === Displacement.TWIST_SMOOTHER;
  const pinning = p.choice(12, 2, TURBULENT_PINNING_MENU);
  const pinAll = pinning === 2 || pinning === 5;
  const pinX = pinAll || pinning === 4 || pinning === 7;
  const pinY = pinAll || pinning === 3 || pinning === 6;
  const toNoise = noiseSpace(p.vec(4, layerCenter(layer, input)), [size / NOISE_CELL, size / NOISE_CELL], 0, k);
  const box = layerRect(layer, input);
  const rect = p.bool(13, false) ? clampRect(growRect(imageRect(input), pinX ? 0 : Math.abs(amount), pinY ? 0 : Math.abs(amount))) : imageRect(input);
  return warp(
    ctx,
    input,
    rect,
    `${FRACTAL_GLSL}
uniform mat3 u_toNoise;
uniform float u_amount;
uniform int u_mode;
uniform vec4 u_box;
uniform vec2 u_pin;
uniform float u_reach;
vec2 field(vec2 x) {
  if (u_mode == ${Displacement.VERTICAL}) return vec2(0.0, fractal(x, 0u) * 2.0 - 1.0);
  if (u_mode == ${Displacement.HORIZONTAL}) return vec2(fractal(x, 0u) * 2.0 - 1.0, 0.0);
  if (u_mode == ${Displacement.CROSS}) return vec2(fractal(x, 0u) * 2.0 - 1.0);
  if (u_mode == ${Displacement.TURBULENT} || u_mode == ${Displacement.TURBULENT_SMOOTHER}) return vec2(fractal(x, 0u), fractal(x, 1u)) * 2.0 - 1.0;
  float e = 0.05;
  vec2 g = vec2(fractal(x + vec2(e, 0.0), 0u) - fractal(x - vec2(e, 0.0), 0u), fractal(x + vec2(0.0, e), 0u) - fractal(x - vec2(0.0, e), 0u)) / (4.0 * e);
  return u_mode == ${Displacement.BULGE} || u_mode == ${Displacement.BULGE_SMOOTHER} ? g : vec2(-g.y, g.x);
}
float pinned(vec2 p) {
  float w = 1.0;
  if (u_pin.x > 0.0) w *= smoothstep(0.0, u_reach, min(p.x - u_box.x, u_box.x + u_box.z - p.x));
  if (u_pin.y > 0.0) w *= smoothstep(0.0, u_reach, min(p.y - u_box.y, u_box.y + u_box.w - p.y));
  return w;
}
vec2 map(vec2 p) { return p + field((u_toNoise * vec3(p, 1.0)).xy) * u_amount * pinned(p); }`,
    (u) => {
      const gl = ctx.gl;
      const m = toNoise;
      gl.uniformMatrix3fv(u("u_toNoise"), false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
      gl.uniform1f(u("u_amount"), amount);
      gl.uniform1i(u("u_mode"), mode);
      boxUniform(gl, u("u_box"), box);
      gl.uniform2f(u("u_pin"), pinX ? 1 : 0, pinY ? 1 : 0);
      gl.uniform1f(u("u_reach"), size * k);
      setFractalUniforms(gl, u, {
        noiseType: smoother ? NoiseType.SPLINE : NoiseType.SOFT_LINEAR,
        shape: FractalShape.BASIC,
        complexity: p.num(5, 1),
        persistence: 0.5,
        sub: octaveTransform(50, 0),
        evolution: p.num(6, 0),
        cycle: p.bool(8, false),
        revolutions: p.num(9, 1),
        seed: p.num(10, 0),
      });
    },
  );
});

/** Wave Warp's Wave Type choices. */
const WaveType = { SINE: 1, NOISE: 8, SMOOTH_NOISE: 9 } as const;

/** Wave Warp's Pinning choices. */
const WavePin = { NONE: 1, ALL: 2, CENTER: 3, LEFT: 4, TOP: 5, RIGHT: 6, BOTTOM: 7, HORIZONTAL: 8, VERTICAL: 9 } as const;

// Wave Warp: the layer moved across Direction (degrees, clockwise from up; the waves travel along it) by Wave Height
// times a wave of Wave Width pixels (stockMath.ts waveShape, Noise and Smooth Noise random), travelling Wave Speed
// cycles a second from Phase (degrees). Pinning holds the chosen edges (or the centre), easing over one Wave Width.
// The layer grows by the wave height.
registerStock(
  "ADBE Wave Warp",
  (input, p, ctx, layer, time) => {
    const k = input.scale ?? 1;
    const height = p.num(2, 10) * k;
    if (Math.abs(height) < 1e-3) return input;
    const width = Math.max(1, p.num(3, 40)) * k;
    const travel = directionVector(p.num(4, 90));
    const normal = [-travel[1], travel[0]];
    const shift = p.num(5, 1) * layerTimeAt(layer, time) - p.num(7, 0) / 360;
    const box = layerRect(layer, input);
    const rect = clampRect(growRect(imageRect(input), Math.abs(normal[0] * height), Math.abs(normal[1] * height)));
    return warp(
      ctx,
      input,
      rect,
      `uniform int u_type;
uniform float u_height;
uniform float u_width;
uniform vec2 u_travel;
uniform vec2 u_normal;
uniform float u_shift;
uniform int u_pin;
uniform vec4 u_box;
float random(float n) {
  uint v = uint(int(n)) * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return float((v >> 22u) ^ v) / 4294967295.0;
}
float arc(float h) { return sqrt(max(0.0, 1.0 - h * h)); }
float wave(float x) {
  float f = fract(x);
  if (u_type == 2) return f < 0.5 ? 1.0 : -1.0;
  if (u_type == 3) return 4.0 * abs(fract(x - 0.25) - 0.5) - 1.0;
  if (u_type == 4) return 2.0 * fract(x + 0.5) - 1.0;
  if (u_type == 5) return (mod(floor(2.0 * x), 2.0) == 0.0 ? 1.0 : -1.0) * arc(fract(2.0 * x) * 2.0 - 1.0);
  if (u_type == 6) return 2.0 * arc(f * 2.0 - 1.0) - 1.0;
  if (u_type == 7) return 1.0 - 2.0 * arc(f * 2.0 - 1.0);
  if (u_type == ${WaveType.NOISE}) return random(floor(x * 4.0)) * 2.0 - 1.0;
  if (u_type == ${WaveType.SMOOTH_NOISE}) {
    float i = floor(x * 2.0);
    float t = fract(x * 2.0);
    return mix(random(i), random(i + 1.0), t * t * (3.0 - 2.0 * t)) * 2.0 - 1.0;
  }
  return sin(6.28318530718 * x);
}
float pinned(vec2 p) {
  vec2 lo = clamp((p - u_box.xy) / u_width, 0.0, 1.0);
  vec2 hi = clamp((u_box.xy + u_box.zw - p) / u_width, 0.0, 1.0);
  if (u_pin == ${WavePin.ALL}) return lo.x * lo.y * hi.x * hi.y;
  if (u_pin == ${WavePin.CENTER}) return clamp(length(p - u_box.xy - 0.5 * u_box.zw) / u_width, 0.0, 1.0);
  if (u_pin == ${WavePin.LEFT}) return lo.x;
  if (u_pin == ${WavePin.TOP}) return lo.y;
  if (u_pin == ${WavePin.RIGHT}) return hi.x;
  if (u_pin == ${WavePin.BOTTOM}) return hi.y;
  if (u_pin == ${WavePin.HORIZONTAL}) return lo.y * hi.y;
  if (u_pin == ${WavePin.VERTICAL}) return lo.x * hi.x;
  return 1.0;
}
vec2 map(vec2 p) { return p - u_normal * (u_height * wave(dot(p, u_travel) / u_width - u_shift) * pinned(p)); }`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform1i(u("u_type"), p.choice(1, WaveType.SINE));
        gl.uniform1f(u("u_height"), height);
        gl.uniform1f(u("u_width"), width);
        gl.uniform2f(u("u_travel"), travel[0], travel[1]);
        gl.uniform2f(u("u_normal"), normal[0], normal[1]);
        gl.uniform1f(u("u_shift"), shift);
        gl.uniform1i(u("u_pin"), p.choice(6, WavePin.NONE));
        boxUniform(gl, u("u_box"), box);
      },
    );
  },
  { scalable: true },
);

// Bulge: the ellipse of Horizontal and Vertical Radius about Bulge Center magnified (positive Bulge Height) or
// pinched (negative) on stockMath.ts' bulgeShape; Pin All Edges holds the layer's edges. Taper Radius is not drawn.
registerStock("ADBE Bulge", (input, p, ctx, layer) => {
  const shape = bulgeShape(p.num(4, 1));
  if (!shape) return input;
  const k = input.scale ?? 1;
  const radius = [Math.max(1e-3, p.num(1, 50)) * k, Math.max(1e-3, p.num(2, 50)) * k];
  const center = p.vec(3, layerCenter(layer, input));
  if (p.num(5, 0) > 0) ctx.warn("Bulge: Taper Radius is ignored");
  const box = layerRect(layer, input);
  return warp(
    ctx,
    input,
    imageRect(input),
    `uniform vec2 u_center;
uniform vec2 u_radius;
uniform float u_invR;
uniform float u_arcScale;
uniform float u_exponent;
uniform float u_sign;
uniform int u_pin;
uniform vec4 u_box;
uniform float u_reach;
vec2 map(vec2 p) {
  vec2 v = (p - u_center) / u_radius;
  float t = dot(v, v);
  if (t >= 1.0 || t <= 0.0) return p;
  float l = sqrt(t);
  float move = asin(min(1.0, l * u_invR)) * u_arcScale / l - 1.0 + (pow(t, u_exponent) - 1.0);
  if (u_pin == 1) {
    vec2 lo = p - u_box.xy;
    vec2 hi = u_box.xy + u_box.zw - p;
    move *= clamp(min(min(lo.x, lo.y), min(hi.x, hi.y)) / u_reach, 0.0, 1.0);
  }
  return u_center + v * (1.0 + u_sign * move) * u_radius;
}`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_center"), center[0] * k, (center[1] ?? 0) * k);
      gl.uniform2f(u("u_radius"), radius[0], radius[1]);
      gl.uniform1f(u("u_invR"), shape.invR);
      gl.uniform1f(u("u_arcScale"), shape.arcScale);
      gl.uniform1f(u("u_exponent"), shape.exponent);
      gl.uniform1f(u("u_sign"), Math.sign(p.num(4, 1)));
      gl.uniform1i(u("u_pin"), p.bool(7, false) ? 1 : 0);
      boxUniform(gl, u("u_box"), box);
      gl.uniform1f(u("u_reach"), Math.max(1, 0.25 * Math.min(radius[0], radius[1])));
    },
  );
});

// Twirl: the layer turned about Twirl Center by Angle (degrees, clockwise) at the centre, easing to nothing at Twirl
// Radius, a percentage of the layer's larger side (stockMath.ts twirlTurn).
registerStock("ADBE Twirl", (input, p, ctx, layer) => {
  const angle = p.num(1, 0);
  const k = input.scale ?? 1;
  const box = layerRect(layer, input);
  const radius = (Math.max(0, p.num(2, 30)) / 100) * Math.max(box.width, box.height);
  if (Math.abs(angle) < 1e-6 || radius < 1e-3) return input;
  const center = p.vec(3, layerCenter(layer, input));
  return warp(
    ctx,
    input,
    imageRect(input),
    `uniform vec2 u_center;
uniform float u_radius;
uniform float u_angle;
vec2 map(vec2 p) {
  vec2 v = p - u_center;
  float d = length(v);
  if (d >= u_radius) return p;
  float f = 1.0 - d / u_radius;
  float a = -u_angle * f * f;
  return u_center + vec2(cos(a) * v.x - sin(a) * v.y, sin(a) * v.x + cos(a) * v.y);
}`,
    (u) => {
      ctx.gl.uniform2f(u("u_center"), center[0] * k, (center[1] ?? 0) * k);
      ctx.gl.uniform1f(u("u_radius"), radius);
      ctx.gl.uniform1f(u("u_angle"), (angle * Math.PI) / 180);
    },
  );
});

const OpticsOrientation = { HORIZONTAL: 1, VERTICAL: 2, DIAGONAL: 3 } as const;

/**
 * Optics Compensation's Resize choices (Off, Max 2X, Max 4X, Unlimited) and the size each allows, as a multiple of
 * the layer's: Unlimited stops at 8, as the stretched corners run off towards infinity at wide fields of view.
 */
const OPTICS_RESIZE = [0, 1, 2, 4, 8];

// Optics Compensation: the layer seen through a fisheye lens of Field Of View across its width, height or diagonal
// (FOV Orientation) about View Center, or with Reverse Lens Distortion the fisheye removed (stockMath.ts
// opticsSourceRadius). Resize grows the reversed layer to show what moves past its edges. Optimal Pixels is not
// drawn.
registerStock("ADBE Optics Compensation", (input, p, ctx, layer) => {
  const fov = p.num(1, 0);
  if (fov < 1e-3) return input;
  const k = input.scale ?? 1;
  const box = layerRect(layer, input);
  const reverse = p.bool(2, false);
  const orientation = p.choice(3, OpticsOrientation.HORIZONTAL);
  const half = orientation === OpticsOrientation.VERTICAL ? box.height / 2 : orientation === OpticsOrientation.DIAGONAL ? Math.hypot(box.width, box.height) / 2 : box.width / 2;
  const focals = opticsFocals(fov, Math.max(1, half));
  const center = p.vec(4, layerCenter(layer, input)).map((v) => v * k);
  if (p.bool(5, false)) ctx.warn("Optics Compensation: Optimal Pixels is ignored");
  const factor = OPTICS_RESIZE[p.choice(6, 1)] ?? 1;
  const rect = reverse && factor > 1 ? clampRect(opticsBounds(imageRect(input), center, focals, reverse, factor)) : imageRect(input);
  return warp(
    ctx,
    input,
    rect,
    `uniform vec2 u_center;
uniform vec2 u_focals;
uniform int u_reverse;
vec2 map(vec2 p) {
  vec2 v = p - u_center;
  float r = length(v);
  if (r < 1e-6) return p;
  float source;
  if (u_reverse == 1) source = u_focals.y * atan(r / u_focals.x);
  else {
    float a = r / u_focals.y;
    if (a >= 1.5707963) return vec2(-1e9);
    source = u_focals.x * tan(a);
  }
  return u_center + v * (source / r);
}`,
    (u) => {
      ctx.gl.uniform2f(u("u_center"), center[0], center[1] ?? 0);
      ctx.gl.uniform2f(u("u_focals"), focals[0], focals[1]);
      ctx.gl.uniform1i(u("u_reverse"), reverse ? 1 : 0);
    },
  );
});

const MapBehavior = { CENTER: 1, STRETCH: 2, TILE: 3 } as const;

// Displacement Map: each pixel shows the layer Max Horizontal / Vertical Displacement pixels away times the
// displacementFraction (stockMath.ts) of a channel of the map layer's source (the layer itself when none is chosen)
// at that pixel, the map centred on the layer, stretched over it or tiled from its corner. Wrap Pixels Around reads
// the layer as tiled; Expand Output grows it by the displacement. Reads another layer, so it is drawn every frame.
registerStock(
  "ADBE Displacement Map",
  (input, p, ctx, layer, time) => {
    const k = input.scale ?? 1;
    const max = [p.num(3, 5) * k, p.num(5, 5) * k];
    const index = Math.round(p.num(1, 0));
    const other = index > 0 ? compOf(ctx, layer)?.layers.find((l) => l.index === index && l !== layer) : undefined;
    const map: LayerImage | null = other ? ctx.layerImage(other, time, false) : input;
    if (!map) return input;
    const behavior = p.choice(6, MapBehavior.CENTER);
    const rect = layerRect(layer, input);
    // Map layer point = scale * layer point + offset, per axis.
    let scale = [1, 1];
    let offset = [0, 0];
    let mapRect = rect;
    if (map !== input && other) {
      mapRect = layerRect(other, map);
      const mk = map.scale ?? 1;
      scale = behavior === MapBehavior.STRETCH ? [mapRect.width / rect.width, mapRect.height / rect.height] : [mk / k, mk / k];
      offset =
        behavior === MapBehavior.CENTER
          ? [mapRect.x + mapRect.width / 2 - (rect.x + rect.width / 2) * scale[0], mapRect.y + mapRect.height / 2 - (rect.y + rect.height / 2) * scale[1]]
          : [mapRect.x - rect.x * scale[0], mapRect.y - rect.y * scale[1]];
    }
    const out = p.bool(8, true) ? clampRect(growRect(imageRect(input), Math.abs(max[0]), Math.abs(max[1]))) : imageRect(input);
    const result = layerPass(
      ctx,
      out,
      [input, map],
      `uniform vec2 u_scale;
uniform vec2 u_offset;
uniform vec4 u_mapRect;
uniform int u_tile;
uniform ivec2 u_channels;
uniform vec2 u_max;
uniform int u_wrap;
uniform vec4 u_box;
float fraction(int channel, vec4 m) {
  vec3 s = straight(m);
  vec3 hsl = rgb2hsl(s);
  if (channel == ${DisplaceChannel.RED}) return (s.r - 0.5) * 2.0 * m.a;
  if (channel == ${DisplaceChannel.GREEN}) return (s.g - 0.5) * 2.0 * m.a;
  if (channel == ${DisplaceChannel.BLUE}) return (s.b - 0.5) * 2.0 * m.a;
  if (channel == ${DisplaceChannel.ALPHA}) return (m.a - 0.5) * 2.0;
  if (channel == ${DisplaceChannel.LUMINANCE}) return (luma(s) - 0.5) * 2.0 * m.a;
  if (channel == ${DisplaceChannel.HUE}) return (hsl.x - 0.5) * 2.0;
  if (channel == ${DisplaceChannel.LIGHTNESS}) return (hsl.z - 0.5) * 2.0;
  if (channel == ${DisplaceChannel.SATURATION}) return (hsl.y - 0.5) * 2.0;
  if (channel == ${DisplaceChannel.FULL}) return 1.0;
  if (channel == ${DisplaceChannel.HALF}) return 0.0;
  return -1.0;
}`,
      `  vec2 q = p * u_scale + u_offset;
  if (u_tile == 1) q = u_mapRect.xy + mod(q - u_mapRect.xy, u_mapRect.zw);
  else q = clamp(q, u_mapRect.xy + 0.5, u_mapRect.xy + u_mapRect.zw - 0.5);
  vec4 m = at(1, q);
  vec2 s = p + vec2(fraction(u_channels.x, m), fraction(u_channels.y, m)) * u_max;
  if (u_wrap == 1) s = u_box.xy + mod(s - u_box.xy, u_box.zw);
  outColor = at(0, s);`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform2f(u("u_scale"), scale[0], scale[1]);
        gl.uniform2f(u("u_offset"), offset[0], offset[1]);
        boxUniform(gl, u("u_mapRect"), mapRect);
        gl.uniform1i(u("u_tile"), behavior === MapBehavior.TILE ? 1 : 0);
        gl.uniform2i(u("u_channels"), p.choice(2, DisplaceChannel.RED), p.choice(4, DisplaceChannel.GREEN));
        gl.uniform2f(u("u_max"), max[0], max[1]);
        gl.uniform1i(u("u_wrap"), p.bool(7, false) ? 1 : 0);
        boxUniform(gl, u("u_box"), rect);
      },
      input.scale,
    );
    if (map !== input) ctx.pool.release(map.target);
    ctx.pool.release(input.target);
    return result;
  },
  { scalable: true },
);
