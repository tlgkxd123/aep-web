/**
 * Stylize effects, ported from src/render/effects/stylizeExtra.ts with the same shaders: CC Threshold, CC Threshold RGB,
 * Strobe Light, Find Edges, Emboss, Color Emboss, CC RepeTile, CC Kaleida, CS HexTile, CS BlockLoad and Texturize.
 */
#include <algorithm>
#include <cmath>
#include <set>
#include <vector>

#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

/** Strobe Light's Strobe popup and Strobe Operator's default. */
enum StrobeKind { kStrobeColor = 1, kStrobeTransparent = 2 };
constexpr int32_t kStrobeCopy = 1;

/** Steps per second Strobe Light rounds Strobe Duration and Period to: this decides the frames on the boundaries. */
constexpr double kStrobeTicks = 10000;

/** Whether Strobe Light strobes at layer time `t` (strobeOn). */
bool strobeOn(double t, double duration, double period) {
  const double p = std::floor(period * kStrobeTicks + 0.5);
  if (p <= 0) return false;
  return std::fmod(t * kStrobeTicks, p) < p - std::floor(duration * kStrobeTicks + 0.5);
}

/**
 * Strobe Light: during each strobe the layer's colour combined with Strobe Color by Strobe Operator (or the layer made
 * transparent), mixed with the layer by Blend With Original.
 */
FxImage strobe(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double t = layer.time - layer.startTime;
  if (p.num(5, 0) > 0) ctx.warn("Strobe Light: Random Strobe Probability is not rendered");
  if (!strobeOn(t, p.num(3, 0.5), p.num(4, 1))) return input;
  const float blend = float(std::min(1.0, std::max(0.0, p.num(2, 0) / 100)));
  return pixelPass(ctx, input, fx::strobe, [&](FxUniforms& u) {
    const std::array<float, 3> color = p.rgb(1, {1, 1, 1});
    u.fv("u_color", color.data(), 1, 3);
    u.i("u_kind", p.choice(6, kStrobeColor));
    u.i("u_op", p.choice(7, kStrobeCopy));
    u.f("u_blend", blend);
  });
}

/** clamp(v, 0, 1). */
float unit(double v) { return float(std::min(1.0, std::max(0.0, v))); }

/** Math.round: half up. */
double jsRound(double v) { return std::floor(v + 0.5); }

/** Below an 8-bit level: a level equal to the threshold does not exceed it, whatever the float rounding. */
constexpr double kThresholdTie = 1e-5;

/** Threshold as the 16-bit value the CC thresholds compare 8-bit levels with (threshold16). */
int32_t threshold16(double t) { return int32_t(std::floor(t * 32768)); }

/** CC Threshold's Channel popup default. */
constexpr int32_t kThresholdLuminance = 1;

/**
 * CC Threshold: white where the channel exceeds Threshold, black elsewhere (each of R, G, B on its own with RGB);
 * Invert swaps them, Blend w. Original mixes the layer back in.
 */
FxImage threshold(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return pixelPass(ctx, input, fx::threshold, [&](FxUniforms& u) {
    const double t = p.num(1, 0.5);
    u.f("u_threshold", float(jsRound(t * 255) / 255 + kThresholdTie));
    u.i("u_threshold16", threshold16(t));
    u.i("u_channel", p.choice(2, kThresholdLuminance));
    u.i("u_invert", p.flag(3, false) ? 1 : 0);
    u.f("u_blend", unit(p.num(4, 0)));
  });
}

/** CC Threshold RGB: each of R, G, B white where it exceeds its own threshold as 16-bit values, each optionally inverted. */
FxImage thresholdRgb(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return pixelPass(ctx, input, fx::threshold_rgb, [&](FxUniforms& u) {
    u.i("u_threshold", threshold16(p.num(1, 0.5)), threshold16(p.num(2, 0.5)), threshold16(p.num(3, 0.5)));
    u.f("u_invert", p.flag(4, false) ? 1.0f : 0.0f, p.flag(5, false) ? 1.0f : 0.0f, p.flag(6, false) ? 1.0f : 0.0f);
    u.f("u_blend", unit(p.num(7, 0)));
  });
}

/**
 * Find Edges: each channel's Sobel gradient magnitude (straight colours, edge pixels repeated), drawn dark on white
 * (bright on black with Invert), mixed with the layer by Blend With Original.
 */
FxImage findEdges(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const FxRect box = layerRect(layer, input);
  const FxImage flat = unpremultiplied(ctx, input);
  const FxImage out = layerPass(ctx, imageRect(input), {input, flat}, fx::find_edges, [&](FxUniforms& u) {
    u.f("u_box", float(box.x), float(box.y), float(box.width), float(box.height));
    u.i("u_invert", p.flag(1, false) ? 1 : 0);
    u.f("u_blend", unit(p.num(2, 0)));
  }, input.scale);
  ctx.release(flat.target);
  ctx.release(input.target);
  return out;
}

/**
 * Emboss and Color Emboss: each channel's difference between the layer Relief pixels ahead along Direction and as far
 * behind, times Contrast, added to mid grey (Emboss) or to the layer (Color Emboss), mixed by Blend With Original.
 */
FxImage emboss(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx, bool color) {
  const FxParams p(effect);
  const double k = input.scale;
  const std::array<double, 2> dir = directionVector(p.num(1, 45));
  const double relief = std::max(0.0, p.num(2, 1)) * k;
  const FxRect box = layerRect(layer, input);
  const FxImage flat = unpremultiplied(ctx, input);
  const FxImage out = layerPass(ctx, imageRect(input), {input, flat}, fx::emboss, [&](FxUniforms& u) {
    u.f("u_box", float(box.x), float(box.y), float(box.width), float(box.height));
    u.f("u_step", float(dir[0] * relief), float(dir[1] * relief));
    u.f("u_contrast", float(std::max(0.0, p.num(3, 100)) / 100));
    u.f("u_blend", unit(p.num(4, 0) / 100));
    u.i("u_color", color ? 1 : 0);
  }, input.scale);
  ctx.release(flat.target);
  ctx.release(input.target);
  return out;
}

/** CC RepeTile's Tiling popup: the values the renderer itself tests. */
enum Tiling {
  kTileRepeat = 1,
  kTileFlip45 = 6,
  kTileCheckerCcw = 7,
  kTileCheckerCw = 8,
  kTileRosette = 9,
  kTileRandom = 10,
  kTileTurnCw = 12,
  kTileTurnCcw = 13,
  kTileTwist = 14,
};

/**
 * CC RepeTile: the layer's box grown by Expand Right, Left, Down and Up, the new area filled with copies of the layer
 * tiled by Tiling; Blend Tiles averages each pixel's tile with its neighbours across the seams.
 */
FxImage repeTile(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const FxRect box = layerRect(layer, input);
  double grow[4];
  for (uint32_t i = 0; i < 4; i++) grow[i] = std::max(0.0, jsRound(p.num(i + 1, 0))) * k;
  const double right = grow[0], left = grow[1], down = grow[2], up = grow[3];
  const int32_t tiling = p.choice(5, kTileRepeat);
  const double blend = std::min(1.0, std::max(0.0, p.num(6, 0)));
  static const std::set<int32_t> turning = {kTileFlip45, kTileCheckerCcw, kTileCheckerCw, kTileRosette, kTileRandom, kTileTurnCw, kTileTurnCcw, kTileTwist};
  const double side = std::min(box.width, box.height);
  FxRect tile = box;
  if (turning.count(tiling)) tile.width = tile.height = side;
  const FxRect rect = clampRect({box.x - left, box.y - up, box.width + left + right, box.height + up + down});
  const FxImage out = layerPass(ctx, rect, {input}, fx::repetile, [&](FxUniforms& u) {
    u.f("u_rect", float(tile.x), float(tile.y), float(tile.width), float(tile.height));
    u.f("u_box", float(box.x), float(box.y), float(box.width), float(box.height));
    u.i("u_tiling", tiling);
    u.f("u_width", float(blend * tile.width / 4), float(blend * tile.height / 4));
  }, input.scale);
  ctx.release(input.target);
  return out;
}

/** CC Kaleida's Mirroring popup default. */
constexpr int32_t kMirrorUnfold = 1;

/**
 * CC Kaleida: the plane around the layer's centre (around Center with Floating Center) cut into squares of Size, each
 * filled by mirrored and turned copies of the square's quarter up and left of Center, as Mirroring arranges them.
 */
FxImage kaleida(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const FxRect box = layerRect(layer, input);
  const std::array<double, 2> middle = layerCenter(layer, input);
  const std::vector<double> c = p.vec(1, {middle[0], middle[1]});
  const double cx = (c.empty() ? middle[0] : c[0]) * k;
  const double cy = (c.size() > 1 ? c[1] : middle[1]) * k;
  const bool floating = p.flag(5, false);
  const double ox = floating ? cx : box.x + box.width / 2;
  const double oy = floating ? cy : box.y + box.height / 2;
  const double size = std::max(1.0, p.num(2, 30) * k);
  const int32_t mirroring = p.choice(3, kMirrorUnfold);
  const double angle = p.num(4, 0) * M_PI / 180;
  const FxImage out = layerPass(ctx, box, {input}, fx::kaleida, [&](FxUniforms& u) {
    u.f("u_anchor", float(ox), float(oy));
    u.f("u_center", float(cx), float(cy));
    u.f("u_cell", float(size));
    u.i("u_mode", mirroring);
    u.f("u_turn", float(std::cos(angle)), float(std::sin(angle)));
    u.f("u_box", float(box.x), float(box.y), float(box.width), float(box.height));
  }, input.scale);
  ctx.release(input.target);
  return out;
}

/** CS HexTile's Render popup default. */
constexpr int32_t kHexTile = 1;

/**
 * CS HexTile: a hexagonal lattice through Center, each cell showing the layer around Center, scaled by
 * 1 + Smearing / 100; the Fold renders fold each cell onto one twelfth of it.
 */
FxImage hexTile(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const FxRect box = layerRect(layer, input);
  const std::array<double, 2> middle = layerCenter(layer, input);
  const std::vector<double> c = p.vec(3, {middle[0], middle[1]});
  const double cx = (c.empty() ? middle[0] : c[0]) * k;
  const double cy = (c.size() > 1 ? c[1] : middle[1]) * k;
  const double radius = std::max(0.5, p.num(2, 20) * k);
  const double angle = p.num(5, 0) * M_PI / 180;
  if (p.flag(4, false)) ctx.warn("CS HexTile: Lock Center Tile is not rendered");
  const FxImage out = layerPass(ctx, box, {input}, fx::hextile, [&](FxUniforms& u) {
    u.f("u_center", float(cx), float(cy));
    u.f("u_radius", float(radius));
    u.i("u_render", p.choice(1, kHexTile));
    u.f("u_turn", float(std::cos(angle)), float(std::sin(angle)));
    u.f("u_smear", float(p.num(6, 0) / 100));
  }, input.scale);
  ctx.release(input.target);
  return out;
}

/**
 * CS BlockLoad: the layer drawn in Scans passes of square blocks, each pass half the size of the one before and twice
 * as long, covering the layer block by block in rows from the top as Completion advances.
 */
FxImage blockLoad(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const FxRect box = layerRect(layer, input);
  const double completion = std::min(1.0, std::max(0.0, p.num(1, 0) / 100));
  if (completion >= 1) return input;
  const int32_t scans = int32_t(std::max(1.0, std::min(16.0, jsRound(p.num(2, 4)))));
  const double done = completion * (std::ldexp(1.0, scans) - 1);
  int32_t scan = 1;
  while (scan < scans && done >= std::ldexp(1.0, scan) - 1) scan++;
  const double progress = (done - (std::ldexp(1.0, scan - 1) - 1)) / std::ldexp(1.0, scan - 1);
  const double block = std::ldexp(1.0, scans - scan) * k;
  const double columns = std::ceil(box.width / block);
  const double blocks = columns * std::ceil(box.height / block);
  return pixelPass(ctx, input, fx::block_load, [&](FxUniforms& u) {
    u.f("u_box", float(box.x), float(box.y), float(box.width), float(box.height));
    u.f("u_block", float(block));
    u.f("u_columns", float(columns));
    u.f("u_revealed", float(std::floor(progress * blocks + 1e-9)));
    u.i("u_first", scan == 1 ? 1 : 0);
    u.i("u_cleared", p.flag(3, true) ? 1 : 0);
    u.i("u_bilinear", p.flag(4, false) ? 1 : 0);
  });
}

/** Texturize's Texture Placement choices. */
enum TexturePlacement : int32_t { kTextureTile = 1 };

/**
 * Texturize: the layer's straight colour plus Texture Contrast times the relief of the texture layer, channel by
 * channel: the difference of its colour one texture pixel either way along Light Direction (bilinear), taken at its
 * pixels and interpolated between them. The texture is tiled from the layer's top left corner, stretched over the
 * layer (and wrapping at its edges), or placed once centred on it (transparent around).
 */
FxImage texturize(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  FxImage texture;
  EffectLayer other;
  if (ctx.source(effect, 1, texture, other) != FxSource::Image || !texture.target) return input;
  const double k = input.scale;
  const FxRect box = layerRect(layer, input);
  const FxRect textureBox = layerRect(other, texture);
  const int32_t placement = p.choice(4, kTextureTile);
  const std::array<double, 2> light = directionVector(p.num(2, 135));
  FxImage out = layerPass(ctx, imageRect(input), {input, texture}, fx::texturize, [&](FxUniforms& u) {
    u.f("u_box", float(box.x), float(box.y), float(box.width), float(box.height));
    u.f("u_texture", float(textureBox.x), float(textureBox.y), float(textureBox.width), float(textureBox.height));
    u.i("u_placement", placement);
    u.f("u_light", float(light[0] * k), float(light[1] * k));
    u.f("u_contrast", float(std::max(0.0, p.num(3, 1))));
  }, input.scale);
  ctx.release(input.target);
  ctx.release(texture.target);
  return out;
}

}  // namespace

FxRenderer thresholdRenderer() { return threshold; }
FxRenderer thresholdRgbRenderer() { return thresholdRgb; }
FxRenderer findEdgesRenderer() { return findEdges; }
FxRenderer embossRenderer() {
  return [](FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) { return emboss(input, effect, layer, ctx, false); };
}
FxRenderer colorEmbossRenderer() {
  return [](FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) { return emboss(input, effect, layer, ctx, true); };
}
FxRenderer repeTileRenderer() { return repeTile; }
FxRenderer kaleidaRenderer() { return kaleida; }
FxRenderer hexTileRenderer() { return hexTile; }
FxRenderer blockLoadRenderer() { return blockLoad; }
FxRenderer strobeRenderer() { return strobe; }
FxRenderer texturizeRenderer() { return texturize; }

}  // namespace aevk
