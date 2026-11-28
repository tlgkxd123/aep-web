/**
 * Generate effects, ported from src/render/effects/generateExtra.ts with the same shaders: Checkerboard, Circle and
 * Grid (a pattern's coverage laid over the layer by its Blending Mode), Ellipse and Beam (glowing strokes), CC Light
 * Sweep and Eyedropper Fill.
 */
#include <algorithm>
#include <cmath>

#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

/** Checkerboard's, Circle's and Grid's Blending Mode menu as After Effects stores it. */
#define BLEND_MENU                                                                                                                    \
  {"None", "Normal", "Stencil Alpha", "(-", "Add", "Multiply", "Screen", "Overlay", "Soft Light", "Hard Light", "(-", "Color Dodge", \
   "Color Burn", "(-", "Darken", "Lighten", "Difference", "Exclusion", "(-", "Hue", "Saturation", "Color", "Luminosity"}
#define SIZE_MENU {"Corner Point", "Width Slider", "Width & Height Sliders"}

constexpr int32_t kBlendNone = 1;

/**
 * A generator's output (generate()): the pattern in `color` at `opacity` composited over the layer by `blend`, over
 * the layer's rectangle (and the input's when it lays over it). Releases `input`.
 */
FxImage generate(FxContext& ctx, FxImage input, const EffectLayer& layer, std::array<float, 3> color, double opacity, int32_t blend, fx::Id shader,
                 const FxSetter& set) {
  const FxRect own = layerRect(layer, input);
  const FxRect rect = blend == kBlendNone ? own : unionRect(own, imageRect(input));
  FxImage out = layerPass(ctx, rect, {input}, shader, [&](FxUniforms& u) {
    u.i("u_blend", blend);
    u.f("u_color", color[0], color[1], color[2]);
    u.f("u_opacity", float(std::min(1.0, std::max(0.0, opacity))));
    u.f("u_own", float(own.x), float(own.y), float(own.x + own.width), float(own.y + own.height));
    set(u);
  }, input.scale);
  ctx.release(input.target);
  return out;
}

/** Size From: 1 Corner Point, 2 Width Slider, 3 Width & Height Sliders (cellSize). */
std::array<double, 2> cellSize(const FxParams& p, const std::vector<double>& anchor, uint32_t corner, uint32_t width, uint32_t height, int32_t sizeFrom) {
  const double ax = anchor.empty() ? 0 : anchor[0];
  const double ay = anchor.size() > 1 ? anchor[1] : 0;
  if (sizeFrom == 1) {
    const std::vector<double> c = p.vec(corner, anchor);
    return {std::fabs((c.empty() ? 0 : c[0]) - ax), std::fabs((c.size() > 1 ? c[1] : 0) - ay)};
  }
  const double w = p.num(width, 16);
  return {w, sizeFrom == 2 ? w : p.num(height, 8)};
}

FxImage checkerboard(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const std::vector<double> anchor = p.vec(1, layerMiddle(layer));
  const std::array<double, 2> cell = cellSize(p, anchor, 3, 4, 5, p.choice(2, 2, SIZE_MENU));
  const double feather[2] = {p.num(7, 0), p.num(8, 0)};
  return generate(ctx, input, layer, p.rgb(10, {1, 1, 1}), p.num(11, 100) / 100, p.choice(12, kBlendNone, BLEND_MENU), fx::checkerboard,
                  [&](FxUniforms& u) {
                    const std::array<double, 2> a = effectPoint(layer, anchor);
                    u.f("u_anchor", float(a[0] * k), float(a[1] * k));
                    u.f("u_cell", float(std::max(1e-3, cell[0] * k)), float(std::max(1e-3, cell[1] * k)));
                    u.f("u_soft", float(feather[0] * k), float(feather[1] * k));
                  });
}

/** Circle's Edge menu. */
enum Edge { kEdgeNone = 1, kEdgeRadius = 2, kThickness = 3, kThicknessRadius = 4, kThicknessFeatherRadius = 5 };

FxImage circle(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const std::array<double, 2> center = effectPoint(layer, p.vec(1, layerMiddle(layer)));
  const double radius = std::fabs(p.num(2, 75));
  const int32_t edge = p.choice(3, kEdgeNone, {"None", "Edge Radius", "Thickness", "Thickness * Radius", "Thickness & Feather * Radius"});
  const double value = p.num(4, 10);
  double featherOut = p.num(6, 0);
  double featherIn = p.num(7, 0);
  double inner = -1;
  double outer = radius;
  if (edge == kEdgeRadius) {
    inner = std::min(radius, std::fabs(value));
    outer = std::max(radius, std::fabs(value));
  } else if (edge != kEdgeNone) {
    const double thickness = edge == kThickness ? value : value * radius / 100;
    if (edge == kThicknessFeatherRadius) {
      featherOut = featherOut * radius / 100;
      featherIn = featherIn * radius / 100;
    }
    inner = radius - thickness / 2;
    outer = radius + thickness / 2;
  }
  return generate(ctx, input, layer, p.rgb(10, {1, 1, 1}), p.num(11, 100) / 100, p.choice(12, kBlendNone, BLEND_MENU), fx::circle, [&](FxUniforms& u) {
    u.f("u_center", float(center[0] * k), float(center[1] * k));
    u.f("u_radii", float(inner < 0 ? -1 : inner * k), float(outer * k));
    u.f("u_halfRamps", float(std::max(0.0, featherIn) * k + 0.75), float(std::max(0.0, featherOut) * k + 0.75));
    u.i("u_invert", p.flag(9, false) ? 1 : 0);
  });
}

FxImage grid(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const std::vector<double> anchor = p.vec(1, layerMiddle(layer));
  const std::array<double, 2> cell = cellSize(p, anchor, 3, 4, 5, p.choice(2, 1, SIZE_MENU));
  const double feather[2] = {std::max(0.0, p.num(8, 0)), std::max(0.0, p.num(9, 0))};
  return generate(ctx, input, layer, p.rgb(12, {1, 1, 1}), p.num(13, 100) / 100, p.choice(14, kBlendNone, BLEND_MENU), fx::grid, [&](FxUniforms& u) {
    const std::array<double, 2> a = effectPoint(layer, anchor);
    u.f("u_anchor", float(a[0] * k), float(a[1] * k));
    u.f("u_cell", float(std::max(1e-3, cell[0] * k)), float(std::max(1e-3, cell[1] * k)));
    u.f("u_border", float(std::max(0.0, p.num(6, 5)) * k));
    u.f("u_soft", float(feather[0] * k), float(feather[1] * k));
    u.i("u_invert", p.flag(11, false) ? 1 : 0);
  });
}

/** Ellipse's and Beam's glow colours (setGlow). */
void setGlow(FxUniforms& u, const FxParams& p, uint32_t inside, uint32_t outside, uint32_t softness, uint32_t onOriginal) {
  const std::array<float, 3> i = p.rgb(inside, {1, 1, 1});
  const std::array<float, 3> o = p.rgb(outside, {1, 0, 0});
  u.f("u_inside", i[0], i[1], i[2]);
  u.f("u_outside", o[0], o[1], o[2]);
  u.f("u_softness", float(std::min(1.0, std::max(0.0, p.num(softness, 0.5)))));
  u.i("u_onOriginal", p.flag(onOriginal, false) ? 1 : 0);
}

/** A generator drawing over the layer's own rectangle (strokePass); releases `input`. */
FxImage strokePass(FxContext& ctx, FxImage input, const EffectLayer& layer, fx::Id shader, const FxSetter& set) {
  FxImage out = layerPass(ctx, layerRect(layer, input), {input}, shader, set, input.scale);
  ctx.release(input.target);
  return out;
}

constexpr double kMaxEllipseSides = 512;

/** The number of sides of the polygon Ellipse draws (ellipseSides). */
int32_t ellipseSides(double width, double height, double thickness) {
  const double quarter = M_PI * (std::max(0.0, width) + std::max(0.0, height)) / 8;
  const double segments = thickness > 0 ? std::ceil(quarter / (0.8 * thickness)) : INFINITY;
  return int32_t(4 * std::min(kMaxEllipseSides / 4, std::max(8.0, segments)));
}

FxImage ellipse(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const std::array<double, 2> center = effectPoint(layer, p.vec(1, layerMiddle(layer)));
  return strokePass(ctx, input, layer, fx::ellipse, [&](FxUniforms& u) {
    u.f("u_center", float((center[0] + 0.5) * k), float((center[1] + 0.5) * k));
    u.f("u_radii", float(std::max(0.0, p.num(2, 50)) / 2 * k), float(std::max(0.0, p.num(3, 50)) / 2 * k));
    u.f("u_thickness", float(std::max(0.0, p.num(4, 8)) * k));
    u.i("u_sides", ellipseSides(p.num(2, 50), p.num(3, 50), p.num(4, 8)));
    setGlow(u, p, 6, 7, 5, 8);
  });
}

FxImage beam(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const std::array<double, 2> start = effectPoint(layer, p.vec(1, {layer.width * 0.1, layer.height / 2.0}));
  const std::array<double, 2> end = effectPoint(layer, p.vec(2, {layer.width * 0.9, layer.height / 2.0}));
  const double length = std::min(1.0, std::max(0.0, p.num(3, 0.25)));
  const double time = std::min(1.0, std::max(0.0, p.num(4, 0.5)));
  const double t0 = std::max(0.0, p.num(5, 8));
  const double t1 = std::max(0.0, p.num(6, 8));
  const double head = std::min(1.0, time * (1 + length));
  const double tail = std::min(1.0, std::max(0.0, time * (1 + length) - length));
  const bool perspective = p.flag(10, true) && t0 > 0 && t1 > 0;
  const double depth = t0 >= t1 ? 2 * t0 / t1 - 1 : 1 / (2 * t1 / t0 - 1);
  const auto onScreen = [&](double v) { return perspective ? v * depth / (1 - v + v * depth) : v; };
  return strokePass(ctx, input, layer, fx::beam, [&](FxUniforms& u) {
    u.f("u_start", float((start[0] + 0.5) * k), float((start[1] + 0.5) * k));
    u.f("u_end", float((end[0] + 0.5) * k), float((end[1] + 0.5) * k));
    u.f("u_span", float(onScreen(tail)), float(onScreen(head)));
    u.f("u_thickness", float(t0 * k), float(t1 * k));
    setGlow(u, p, 8, 9, 7, 11);
  });
}

constexpr double kMaxBoxTaps = 2048;

/** The layer's alpha averaged along one axis over a box 2 x `half` wide, `shift` from the pixel (alphaBox). */
FxImage alphaBox(FxContext& ctx, const FxImage& input, const FxRect& rect, int32_t axis, double shift, double half) {
  return layerPass(ctx, rect, {input}, fx::alpha_box, [&](FxUniforms& u) {
    u.i("u_axis", axis);
    u.f("u_shift", float(shift));
    u.f("u_half", float(half));
  }, input.scale);
}

enum SweepShape { kLinear = 1 };
enum Reception { kAdd = 1 };

FxImage lightSweep(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const std::array<double, 2> center = effectPoint(layer, p.vec(1, layerMiddle(layer)));
  const double direction = p.num(2, -30) * M_PI / 180;
  const std::array<float, 3> color = p.rgb(8, {1, 1, 1});
  const double edge = std::max(0.0, p.num(6, 50)) / 50;
  const double thickness = std::min(kMaxBoxTaps / 2 - 2, std::max(0.0, p.num(7, 4)) * k);
  const FxRect rect = layerRect(layer, input);
  FxImage box;
  if (edge > 0 && thickness > 0) {
    const FxImage across = alphaBox(ctx, input, rect, 0, std::sin(direction) * thickness, thickness);
    box = alphaBox(ctx, across, rect, 1, -std::cos(direction) * thickness, thickness);
    ctx.release(across.target);
  }
  const FxSetter set = [&](FxUniforms& u) {
    u.f("u_edge", float(edge));
    u.f("u_center", float((center[0] + 0.5) * k), float((center[1] + 0.5) * k));
    u.f("u_normal", float(std::cos(direction)), float(std::sin(direction)));
    u.f("u_width", float(std::max(1e-3, p.num(4, 50) * k)));
    u.f("u_intensity", float(std::max(0.0, p.num(5, 100)) / 100));
    u.i("u_shape", p.choice(3, kLinear, {"Linear", "Smooth", "Sharp"}));
    u.i("u_reception", p.choice(9, kAdd, {"Add", "Composite", "Cutout"}));
    u.f("u_color", color[0], color[1], color[2]);
  };
  FxImage out = box.target ? layerPass(ctx, rect, {input, box}, fx::light_sweep_edge, set, input.scale)
                           : layerPass(ctx, rect, {input}, fx::light_sweep, set, input.scale);
  ctx.release(box.target);
  ctx.release(input.target);
  return out;
}

/** Eyedropper Fill's Average Pixel Colors choices. */
enum EyedropperAverage : int32_t { kAverageSkipEmpty = 1 };

/**
 * Eyedropper Fill: the layer's pixels whose centres lie within Sample Radius of Sample Point, averaged by one fragment
 * into a 1 x 1 image, fill the layer (keeping its alpha with Maintain Original Alpha), mixed with the original by Blend
 * With Original.
 */
FxImage eyedropperFill(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const std::array<double, 2> point = effectPoint(layer, p.vec(1, {0, 0}));
  const double radius = std::max(0.5, p.num(2, 10)) * k;
  const int32_t mode = p.choice(3, kAverageSkipEmpty, {"Skip Empty", "All", "All Premultiplied", "Including Alpha"});
  const int32_t reach = int32_t(std::ceil(radius));
  FxImage averaged = layerPass(ctx, FxRect{0, 0, 1, 1}, {input}, fx::eyedropper_sample, [&](FxUniforms& u) {
    u.f("u_point", float(point[0] * k), float(point[1] * k));
    u.f("u_radius", float(radius));
    u.i("u_reach", reach);
    u.i("u_mode", mode);
  });
  FxImage out = layerPass(ctx, imageRect(input), {input, averaged}, fx::eyedropper_fill, [&](FxUniforms& u) {
    u.i("u_keepAlpha", p.flag(4, false) ? 1 : 0);
    u.f("u_blend", float(std::min(1.0, std::max(0.0, p.num(5, 0)))));
  }, input.scale);
  ctx.release(averaged.target);
  ctx.release(input.target);
  return out;
}

}  // namespace

FxRenderer checkerboardRenderer() { return checkerboard; }
FxRenderer circleRenderer() { return circle; }
FxRenderer gridRenderer() { return grid; }
FxRenderer ellipseRenderer() { return ellipse; }
FxRenderer beamRenderer() { return beam; }
FxRenderer lightSweepRenderer() { return lightSweep; }
FxRenderer eyedropperFillRenderer() { return eyedropperFill; }

}  // namespace aevk
