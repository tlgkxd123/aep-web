// Rendering on whatever Vulkan device there is (lavapipe will do); skipped without one.
#include <array>
#include <cmath>
#include <fstream>
#include <initializer_list>
#include <iterator>
#include <memory>

#include "check.h"
#include "engine.h"
#include "geometry.h"
#include "playback.h"

using namespace aevk;

namespace {

Engine* engine() {
  static std::unique_ptr<Engine> shared;
  static bool tried = false;
  static std::string error;
  if (!tried) {
    tried = true;
    shared = Engine::create(EngineOptions(), error);
    if (!shared) std::printf("  no Vulkan engine: %s\n", error.c_str());
  }
  return shared.get();
}

std::array<float, 16> translation(float x, float y) { return {1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, 0, 0, 0, 0, 1}; }

Layer solid(uint32_t w, uint32_t h, std::array<float, 3> color, float x, float y) {
  Layer layer;
  layer.content.kind = ContentKind::Solid;
  layer.content.width = w;
  layer.content.height = h;
  layer.content.color = color;
  layer.matrix = translation(x + kPad, y + kPad);
  return layer;
}

Mask rectangle(float x0, float y0, float x1, float y1) {
  Mask m;
  m.mode = 6813;
  m.closed = true;
  m.vertices = {x0, y0, 0, 0, 0, 0, x1, y0, 0, 0, 0, 0, x1, y1, 0, 0, 0, 0, x0, y1, 0, 0, 0, 0};
  return m;
}

const uint8_t* pixel(const std::vector<uint8_t>& rgba, uint32_t width, uint32_t x, uint32_t y) { return &rgba[(size_t(y) * width + x) * 4]; }

/** A shape layer at the comp's origin whose paint space is its layer space. */
Layer shapeLayer(uint32_t w, uint32_t h, std::vector<ShapePaint> paints) {
  Layer layer;
  layer.content.kind = ContentKind::Shape;
  layer.content.width = w;
  layer.content.height = h;
  layer.content.paints = std::move(paints);
  layer.matrix = translation(kPad, kPad);
  return layer;
}

ShapePath polyline(std::initializer_list<std::array<float, 2>> points, bool closed) {
  ShapePath path;
  path.closed = closed;
  for (const auto& p : points) path.vertices.insert(path.vertices.end(), {p[0], p[1], 0, 0, 0, 0});
  return path;
}

ShapePaint painted(std::array<float, 4> color, std::vector<ShapePath> paths) {
  ShapePaint paint;
  paint.matrix = {1, 0, 0, 1, float(kPad), float(kPad)};
  paint.color = color;
  paint.paths = std::move(paths);
  return paint;
}

bool render(const Plan& plan, std::vector<uint8_t>& rgba, uint32_t& w, uint32_t& h) {
  std::string error;
  const bool ok = engine()->render(plan, rgba, w, h, error);
  if (!ok) std::printf("  render failed: %s\n", error.c_str());
  return ok;
}

}  // namespace

TEST(places_a_solid) {
  if (!engine()) SKIP("no Vulkan device");
  Plan plan;
  plan.root.width = 6;
  plan.root.height = 4;
  plan.root.layers.push_back(solid(2, 2, {1, 0, 0}, 3, 1));
  std::vector<uint8_t> rgba;
  uint32_t w, h;
  CHECK(render(plan, rgba, w, h));
  CHECK(w == 6 && h == 4);
  CHECK(pixel(rgba, w, 3, 1)[0] == 255 && pixel(rgba, w, 3, 1)[3] == 255);
  CHECK(pixel(rgba, w, 4, 2)[0] == 255 && pixel(rgba, w, 4, 2)[1] == 0);
  CHECK(pixel(rgba, w, 2, 1)[3] == 0);
  CHECK(pixel(rgba, w, 5, 3)[3] == 0);
}

TEST(blends_and_fades) {
  if (!engine()) SKIP("no Vulkan device");
  Plan plan;
  plan.root.width = 4;
  plan.root.height = 4;
  plan.root.layers.push_back(solid(4, 4, {1, 1, 1}, 0, 0));
  Layer multiply = solid(4, 4, {0.5f, 0.25f, 1}, 0, 0);
  multiply.blendMode = 5216;
  plan.root.layers.push_back(std::move(multiply));
  Layer faded = solid(2, 4, {0, 0, 0}, 0, 0);
  faded.opacity = 0.5f;
  plan.root.layers.push_back(std::move(faded));
  std::vector<uint8_t> rgba;
  uint32_t w, h;
  CHECK(render(plan, rgba, w, h));
  const uint8_t* right = pixel(rgba, w, 3, 0);
  CHECK(std::abs(right[0] - 128) <= 1 && std::abs(right[1] - 64) <= 1 && right[2] == 255 && right[3] == 255);
  const uint8_t* left = pixel(rgba, w, 0, 0);
  CHECK(std::abs(left[0] - 64) <= 1 && std::abs(left[1] - 32) <= 1 && std::abs(left[2] - 128) <= 1);
}

TEST(masks_cover_exact_areas) {
  if (!engine()) SKIP("no Vulkan device");
  Plan plan;
  plan.root.width = 10;
  plan.root.height = 10;
  Layer layer = solid(10, 10, {1, 1, 1}, 0, 0);
  layer.masks.push_back(rectangle(2, 2, 6.5f, 6));
  plan.root.layers.push_back(std::move(layer));
  std::vector<uint8_t> rgba;
  uint32_t w, h;
  CHECK(render(plan, rgba, w, h));
  CHECK(pixel(rgba, w, 3, 3)[3] == 255);
  CHECK(pixel(rgba, w, 1, 3)[3] == 0);
  CHECK(pixel(rgba, w, 3, 7)[3] == 0);
  // Half of pixel 6 lies inside x < 6.5.
  CHECK(pixel(rgba, w, 6, 3)[3] == 128);
}

TEST(track_matte_and_subtracted_mask) {
  if (!engine()) SKIP("no Vulkan device");
  Plan plan;
  plan.root.width = 8;
  plan.root.height = 8;
  Layer layer = solid(8, 8, {0, 1, 0}, 0, 0);
  layer.matteMode = matte::AlphaInverted;
  layer.matte = std::make_unique<Layer>(solid(4, 8, {1, 1, 1}, 0, 0));
  Mask cut = rectangle(0, 0, 8, 2);
  cut.mode = 6814;
  layer.masks.push_back(cut);
  plan.root.layers.push_back(std::move(layer));
  std::vector<uint8_t> rgba;
  uint32_t w, h;
  CHECK(render(plan, rgba, w, h));
  CHECK(pixel(rgba, w, 1, 5)[3] == 0);    // under the matte: inverted away
  CHECK(pixel(rgba, w, 6, 5)[3] == 255);  // beside it
  CHECK(pixel(rgba, w, 6, 1)[3] == 0);    // subtracted by the mask
}

TEST(renders_nested_comps_and_images) {
  if (!engine()) SKIP("no Vulkan device");
  Plan plan;
  plan.root.width = 4;
  plan.root.height = 4;
  Layer nested;
  nested.content.kind = ContentKind::Comp;
  nested.content.width = 2;
  nested.content.height = 2;
  nested.content.comp = std::make_unique<Comp>();
  nested.content.comp->width = 2;
  nested.content.comp->height = 2;
  nested.content.comp->layers.push_back(solid(1, 2, {0, 0, 1}, 1, 0));
  nested.matrix = translation(kPad, kPad);
  plan.root.layers.push_back(std::move(nested));
  Layer image;
  image.content.kind = ContentKind::Image;
  image.content.width = 1;
  image.content.height = 1;
  image.matrix = translation(3 + kPad, 3 + kPad);
  plan.root.layers.push_back(std::move(image));
  plan.images.push_back({1, 1, {255, 0, 0, 128}});
  std::vector<uint8_t> rgba;
  uint32_t w, h;
  CHECK(render(plan, rgba, w, h));
  CHECK(pixel(rgba, w, 1, 1)[2] == 255 && pixel(rgba, w, 1, 1)[3] == 255);
  CHECK(pixel(rgba, w, 0, 1)[3] == 0);
  CHECK(pixel(rgba, w, 3, 3)[0] == 255 && pixel(rgba, w, 3, 3)[3] == 128);
}

TEST(renders_the_sample_plan) {
  if (!engine()) SKIP("no Vulkan device");
  std::ifstream in(std::string(AEVK_TEST_DATA) + "/sample.aevp", std::ios::binary);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  Plan plan;
  std::string error;
  CHECK(decodePlan(bytes.data(), bytes.size(), plan, error));
  std::vector<uint8_t> rgba;
  uint32_t w, h;
  CHECK(render(plan, rgba, w, h));
  CHECK(w == 8 && h == 6 && rgba.size() == 8 * 6 * 4);
}

TEST(player_caches_and_replaces_frames) {
  if (!engine()) SKIP("no Vulkan device");
  std::ifstream in(std::string(AEVK_TEST_DATA) + "/sample.aevp", std::ios::binary);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  Player player(*engine(), 1 << 20);
  std::string error;
  CHECK(player.queue("comp#1", 0, bytes.data(), bytes.size(), error));
  CHECK(player.queue("comp#1", 1, bytes.data(), bytes.size(), error));
  CHECK(!player.queue("comp#1", 2, bytes.data(), 7, error));
  CHECK(player.renderAhead(1000, error) == 2);
  CHECK(player.cached("comp#1", 0) && player.cached("comp#1", 1));
  CHECK(player.frame("comp#1", 1, error) != nullptr);
  CHECK(player.frame("comp#1", 5, error) == nullptr);
  // A new plan for a frame drops what was rendered from the old one.
  CHECK(player.queue("comp#1", 1, bytes.data(), bytes.size(), error));
  CHECK(!player.cached("comp#1", 1));
  player.invalidate("comp#1");
  CHECK(!player.queued("comp#1", 0) && !player.cached("comp#1", 0));
  CHECK(player.cache().bytes() == 0);
}

TEST(flattens_curves_within_tolerance) {
  // A circle of radius 10 from four cubic arcs.
  const float k = 10 * 0.5522847f;
  const std::vector<float> circle = {10, 0, -k, 0, k, 0, 20, 10, 0, -k, 0, k, 10, 20, k, 0, -k, 0, 0, 10, 0, k, 0, -k};
  const Outline outline = flattenPath(circle, true, 2, 1, 1);
  CHECK(outline.edges.size() > 16);
  CHECK(outline.stroked == outline.edges.size());
  for (const Edge& e : outline.edges) {
    const double r = std::hypot(e.x0 - 21, e.y0 - 21);
    CHECK_NEAR(r, 20, 0.02);
  }
  CHECK_NEAR(outline.minX, 1, 1e-4);
  CHECK_NEAR(outline.maxY, 41, 1e-4);
  const Outline open = flattenPath({0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 4, 4, 0, 0, 0, 0}, false, 1, 0, 0);
  CHECK(open.stroked == 2 && open.edges.size() == 3);
}

TEST(paints_shape_fills_strokes_and_gradients) {
  if (!engine()) SKIP("no Vulkan device");
  ShapePaint fill = painted({1, 0, 0, 1}, {polyline({{2, 2}, {8, 2}, {8, 8}, {2, 8}}, true)});
  ShapePaint stroke = painted({0, 1, 0, 1}, {polyline({{12, 5}, {18, 5}}, false)});
  stroke.stroke = true;
  stroke.width = 2;
  Plan plan;
  plan.root.width = 20;
  plan.root.height = 10;
  plan.root.layers.push_back(shapeLayer(20, 10, {fill, stroke}));
  std::vector<uint8_t> rgba;
  uint32_t w, h;
  CHECK(render(plan, rgba, w, h));
  CHECK(pixel(rgba, w, 5, 5)[0] == 255 && pixel(rgba, w, 5, 5)[3] == 255);
  CHECK(pixel(rgba, w, 2, 5)[3] == 255);
  CHECK(pixel(rgba, w, 1, 5)[3] == 0);
  // A 2 px pen along y = 5 covers rows 4 and 5; butt caps stop at the ends.
  CHECK(pixel(rgba, w, 12, 4)[1] == 255 && pixel(rgba, w, 17, 5)[3] == 255);
  CHECK(pixel(rgba, w, 15, 3)[3] == 0 && pixel(rgba, w, 15, 6)[3] == 0);
  CHECK(pixel(rgba, w, 18, 5)[3] == 0);

  // Square caps reach half the width past the ends; round joins and caps stay within the pen.
  plan.root.layers[0].content.paints[1].cap = uint32_t(LineCap::Square);
  CHECK(render(plan, rgba, w, h));
  CHECK(pixel(rgba, w, 18, 5)[3] == 255 && pixel(rgba, w, 11, 4)[3] == 255);

  // Even-odd leaves a hole where two loops overlap; nonzero fills it.
  ShapePaint rings = painted({1, 1, 1, 1}, {polyline({{0, 0}, {10, 0}, {10, 10}, {0, 10}}, true), polyline({{3, 3}, {7, 3}, {7, 7}, {3, 7}}, true)});
  Plan holes;
  holes.root.width = holes.root.height = 10;
  holes.root.layers.push_back(shapeLayer(10, 10, {rings}));
  CHECK(render(holes, rgba, w, h));
  CHECK(pixel(rgba, w, 5, 5)[3] == 255);
  holes.root.layers[0].content.paints[0].evenOdd = true;
  CHECK(render(holes, rgba, w, h));
  CHECK(pixel(rgba, w, 5, 5)[3] == 0 && pixel(rgba, w, 1, 5)[3] == 255);

  // A linear gradient from black to white over 20 px, sampled at pixel corners.
  ShapePaint ramp = painted({1, 1, 1, 1}, {polyline({{0, 0}, {20, 0}, {20, 10}, {0, 10}}, true)});
  ramp.gradient = 1;
  ramp.start = {0, 0};
  ramp.end = {20, 0};
  ramp.ramp = {0, 0, 0, 1, 1, 1, 1, 1};
  Plan gradient;
  gradient.root.width = 20;
  gradient.root.height = 10;
  gradient.root.layers.push_back(shapeLayer(20, 10, {ramp}));
  CHECK(render(gradient, rgba, w, h));
  CHECK(pixel(rgba, w, 0, 5)[0] == 0);
  CHECK(pixel(rgba, w, 10, 5)[0] == 128);
  CHECK(pixel(rgba, w, 15, 5)[0] == 191);
}

TEST(strokes_wind_one_way) {
  // A closed square stroked with miter joins: every polygon of the outline winds the same way, so overlapping pieces
  // at the corners add up instead of cancelling.
  const std::vector<float> square = {0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 10, 10, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0};
  const Outline outline = strokeOutline({{&square, true}}, {1, 0, 0, 1, 0, 0}, 2, LineCap::Butt, LineJoin::Miter, 4);
  CHECK(!outline.edges.empty());
  CHECK_NEAR(outline.minX, -1, 1e-5);
  CHECK_NEAR(outline.maxY, 11, 1e-5);
  // Bevel joins cut the corners: a triangle each where a miter has a quad.
  const Outline bevel = strokeOutline({{&square, true}}, {1, 0, 0, 1, 0, 0}, 2, LineCap::Butt, LineJoin::Bevel, 4);
  CHECK(bevel.edges.size() + 4 == outline.edges.size());
  // Past the miter limit a miter join is a bevel too.
  const Outline limited = strokeOutline({{&square, true}}, {1, 0, 0, 1, 0, 0}, 2, LineCap::Butt, LineJoin::Miter, 1.2);
  CHECK(limited.edges.size() == bevel.edges.size());
}
