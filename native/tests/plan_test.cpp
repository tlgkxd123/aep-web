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
  CHECK(solid.effects.size() == 1 && solid.effects[0].matchName == "ADBE Box Blur2");
  CHECK_NEAR(solid.effectLayer.time, 1.0 / 3, 0);
  CHECK_NEAR(solid.effectLayer.startTime, -0.5, 0);
  CHECK(solid.effectLayer.width == 4 && solid.effectLayer.kind == 0);
  const Effect& blur = solid.effects[0];
  CHECK(blur.params.size() == 3);
  CHECK(blur.param(1) && blur.param(1)->value.size() == 1);
  CHECK_NEAR(blur.param(1)->value[0], 2.5, 0);
  CHECK(blur.params[1].index == 0 && blur.params[1].matchName == "Custom Param" && blur.params[1].value.size() == 4);
  CHECK(blur.param(3) && blur.param(3)->menu.size() == 3 && blur.param(3)->menu[1] == 1 && blur.param(3)->menu[0] == 0);
  CHECK(!blur.param(2));
  CHECK(blur.sources.size() == 2 && blur.source(4) && blur.source(5) && !blur.source(3));
  CHECK(blur.source(4)->drawn && blur.source(4)->content.kind == ContentKind::Solid && blur.source(4)->content.height == 3);
  CHECK(blur.source(4)->layer.width == 2 && blur.source(4)->layer.height == 3 && blur.source(4)->layer.kind == 0);
  CHECK(!blur.source(5)->drawn);
  CHECK(plan.root.layers[1].effects.empty());
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
  version[4] = 99;  // kPlanVersion is 2
  CHECK(!decodePlan(version.data(), version.size(), plan, error));
  // A layer count far beyond what the bytes could hold.
  std::vector<uint8_t> count = bytes;
  count[16] = 0xff;
  count[17] = 0xff;
  CHECK(!decodePlan(count.data(), count.size(), plan, error));
}
