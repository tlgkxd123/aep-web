// A frame to render, as src/native/plan.ts builds it and src/native/wire.ts writes it: every value evaluated, images in
// their own pixels (y down) with a 1 px transparent border.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace aevk {

constexpr uint32_t kPlanMagic = 0x50564541;  // "AEVP"
constexpr uint32_t kPlanVersion = 1;
constexpr int kPad = 1;

enum class ContentKind : uint32_t { Solid = 1, Comp = 2, Image = 3, Shape = 4 };

namespace matte {
constexpr uint32_t None = 0, Alpha = 1, AlphaInverted = 2, Luma = 3, LumaInverted = 4;
}

struct Mask {
  uint32_t mode = 0;
  bool inverted = false;
  float opacity = 1;
  /** Gaussian radius in image pixels. */
  float feather = 0;
  /** Mask Expansion in layer pixels. */
  float expansion = 0;
  bool closed = false;
  /** Per vertex: x, y, in tangent x, y, out tangent x, y, in layer pixels. */
  std::vector<float> vertices;
};

/** A path of a shape paint, in paint space. */
struct ShapePath {
  bool closed = false;
  /** Per vertex: x, y, in tangent x, y, out tangent x, y. */
  std::vector<float> vertices;
};

/** One fill or stroke of a shape layer (src/render/shapes.ts planShapeLayer). */
struct ShapePaint {
  bool stroke = false;
  bool evenOdd = false;
  /** Paint space to image pixels: x' = a x + c y + e, y' = b x + d y + f. */
  std::array<float, 6> matrix{1, 0, 0, 1, 0, 0};
  /** Stroke width in paint space; Line Cap 1 butt, 2 round, 3 square; Line Join 1 miter, 2 round, 3 bevel. */
  float width = 0;
  uint32_t cap = 1, join = 1;
  float miterLimit = 4;
  /** Straight RGBA, opacities included. */
  std::array<float, 4> color{1, 1, 1, 1};
  /** 0 none, 1 linear, 2 radial. */
  uint32_t gradient = 0;
  /** Paint space: start (a radial gradient's center), end, radial highlight. */
  std::array<float, 2> start{}, end{}, focus{};
  /** Straight RGBA at even steps from start to end. */
  std::vector<float> ramp;
  std::vector<ShapePath> paths;
};

struct Comp;

struct Content {
  ContentKind kind = ContentKind::Solid;
  uint32_t width = 0, height = 0;
  float originX = 0, originY = 0;
  /** Image pixels per layer pixel. */
  float scale = 1;
  std::array<float, 3> color{};
  std::unique_ptr<Comp> comp;
  uint32_t image = 0;
  /** Bottom first. */
  std::vector<ShapePaint> paints;
};

struct Layer {
  bool adjustment = false;
  uint32_t blendMode = 5212;
  float opacity = 1;
  /** Row-major, from layer pixels to target pixels (2D) or camera space (3D). */
  std::array<float, 16> matrix{};
  /** Camera zoom in target pixels for a 3D layer, 0 for a 2D one. */
  float zoom = 0;
  Content content;
  std::vector<Mask> masks;
  uint32_t matteMode = matte::None;
  float matteOpacity = 1;
  std::unique_ptr<Layer> matte;
};

struct Comp {
  uint32_t width = 0, height = 0;
  std::vector<Layer> layers;
};

struct Image {
  uint32_t width = 0, height = 0;
  /** Straight RGBA, top row first. */
  std::vector<uint8_t> pixels;
};

struct Plan {
  Comp root;
  std::vector<Image> images;
};

/** Reads a plan; false with `error` set when the bytes are not a whole, valid plan. */
bool decodePlan(const uint8_t* data, size_t size, Plan& plan, std::string& error);

}  // namespace aevk
