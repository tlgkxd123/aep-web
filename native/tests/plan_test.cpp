// Decoding: the sample plan tests/native-plan.test.ts encodes (tests/data/sample.aevp), and damaged plans.
#include <fstream>
#include <iterator>

#include "check.h"
#include "plan.h"

using namespace aevk;

namespace {
std::vector<uint8_t> sample() {
  std::ifstream in(std::string(AEVK_TEST_DATA) + "/sample.aevp", std::ios::binary);
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}
}  // namespace

TEST(decodes_the_sample_plan) {
  const std::vector<uint8_t> bytes = sample();
  CHECK(!bytes.empty());
  Plan plan;
  std::string error;
  CHECK(decodePlan(bytes.data(), bytes.size(), plan, error));
  if (!error.empty()) std::printf("  %s\n", error.c_str());
  CHECK(plan.root.width == 8 && plan.root.height == 6);
  CHECK(plan.root.layers.size() == 3);
  const Layer& solid = plan.root.layers[0];
  CHECK(solid.content.kind == ContentKind::Solid);
  CHECK(solid.content.width == 4 && solid.content.height == 4);
  CHECK_NEAR(solid.content.color[0], 1, 0);
  CHECK_NEAR(solid.content.color[1], 0.25, 0);
  CHECK_NEAR(solid.matrix[3], 2, 0);
  CHECK(solid.masks.size() == 1);
  CHECK(solid.masks[0].mode == 6813 && solid.masks[0].closed && !solid.masks[0].inverted);
  CHECK(solid.masks[0].vertices.size() == 24);
  CHECK_NEAR(solid.masks[0].feather, 1.5, 0);
  CHECK_NEAR(solid.masks[0].vertices[6], 3, 0);
  const Layer& nested = plan.root.layers[1];
  CHECK(nested.content.kind == ContentKind::Comp && nested.content.comp);
  CHECK(nested.blendMode == 5216);
  CHECK_NEAR(nested.opacity, 0.5, 0);
  CHECK(nested.content.comp->layers.size() == 1 && nested.content.comp->width == 2);
  CHECK(nested.matteMode == matte::Alpha && nested.matte);
  CHECK_NEAR(nested.matteOpacity, 0.75, 0);
  CHECK(nested.matte->content.kind == ContentKind::Solid);
  const Layer& image = plan.root.layers[2];
  CHECK(image.adjustment == false && image.content.kind == ContentKind::Image && image.content.image == 0);
  CHECK_NEAR(image.zoom, 1066.67, 0.01);
  CHECK(image.matteMode == matte::LumaInverted && !image.matte);
  CHECK(plan.images.size() == 1 && plan.images[0].width == 1 && plan.images[0].pixels.size() == 4);
  CHECK(plan.images[0].pixels[0] == 10 && plan.images[0].pixels[3] == 255);
}

TEST(refuses_damaged_plans) {
  const std::vector<uint8_t> bytes = sample();
  Plan plan;
  std::string error;
  for (size_t cut : {size_t(0), size_t(4), size_t(8), bytes.size() / 2, bytes.size() - 1}) {
    error.clear();
    CHECK(!decodePlan(bytes.data(), cut, plan, error));
    CHECK(!error.empty());
  }
  std::vector<uint8_t> longer = bytes;
  longer.push_back(0);
  CHECK(!decodePlan(longer.data(), longer.size(), plan, error));
  std::vector<uint8_t> version = bytes;
  version[4] = 99;
  CHECK(!decodePlan(version.data(), version.size(), plan, error));
  // A layer count far beyond what the bytes could hold.
  std::vector<uint8_t> count = bytes;
  count[16] = 0xff;
  count[17] = 0xff;
  CHECK(!decodePlan(count.data(), count.size(), plan, error));
}
