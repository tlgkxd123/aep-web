/** Footage images: inflate, PNG filters, palettes and tRNS, and the decoded image cache's errors. */
#include <cstdint>
#include <string>
#include <vector>

#include "check.h"
#include "image.h"
#include "media.h"

namespace aevk {
namespace {

/** 3x2 RGBA; row 0 Sub-filtered, row 1 Up-filtered (made with Python's zlib). */
const uint8_t kRgbaPng[] = {137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0, 157, 116, 102, 26, 0, 0, 0, 28,
                            73, 68, 65, 84, 120, 218, 99, 228, 18, 145, 251, 15, 196, 141, 64, 220, 192, 196, 202, 202, 202, 0, 196, 30, 64, 204, 5, 0, 54,
                            203, 3, 55, 109, 35, 42, 252, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130};
/** 2x2, 2-bit palette (red, green, blue) with tRNS (255, 64): red, green / blue, red. */
const uint8_t kPalettePng[] = {137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 2, 3, 0, 0, 0, 15, 216, 229, 183, 0, 0, 0, 9,
                               80, 76, 84, 69, 255, 0, 0, 0, 255, 0, 0, 0, 255, 45, 74, 205, 138, 0, 0, 0, 2, 116, 82, 78, 83, 255, 64, 147, 107, 113, 218, 0,
                               0, 0, 12, 73, 68, 65, 84, 120, 218, 99, 144, 96, 104, 0, 0, 0, 204, 0, 153, 12, 155, 186, 138, 0, 0, 0, 0, 73, 69, 78, 68, 174,
                               66, 96, 130};
/** "hello hello hello hello" in one stored block. */
const uint8_t kStored[] = {120, 1, 1, 23, 0, 232, 255, 104, 101, 108, 108, 111, 32, 104, 101, 108, 108, 111, 32, 104,
                           101, 108, 108, 111, 32, 104, 101, 108, 108, 111, 104, 3, 8, 177};

}  // namespace
}  // namespace aevk

using namespace aevk;

TEST(inflates_stored_blocks) {
  std::vector<uint8_t> out;
  CHECK(inflateZlib(kStored, sizeof kStored, out));
  CHECK(std::string(out.begin(), out.end()) == "hello hello hello hello");
  out.clear();
  CHECK(!inflateZlib(kStored, 10, out));
}

TEST(decodes_filtered_rgba_png) {
  ImageData image;
  std::string error;
  CHECK(decodeImage(kRgbaPng, sizeof kRgbaPng, image, error));
  CHECK(image.width == 3 && image.height == 2);
  const uint8_t expected[] = {10, 20, 30, 255, 20, 40, 60, 128, 30, 60, 90, 0, 15, 25, 35, 255, 25, 45, 65, 200, 35, 65, 95, 10};
  CHECK(image.pixels == std::vector<uint8_t>(expected, expected + sizeof expected));
}

TEST(decodes_palette_png_with_transparency) {
  ImageData image;
  std::string error;
  CHECK(decodeImage(kPalettePng, sizeof kPalettePng, image, error));
  CHECK(image.width == 2 && image.height == 2);
  const uint8_t expected[] = {255, 0, 0, 255, 0, 255, 0, 64, 0, 0, 255, 255, 255, 0, 0, 255};
  CHECK(image.pixels == std::vector<uint8_t>(expected, expected + sizeof expected));
}

TEST(refuses_damaged_and_unknown_images) {
  ImageData image;
  std::string error;
  std::vector<uint8_t> cut(kRgbaPng, kRgbaPng + 50);
  CHECK(!decodeImage(cut.data(), cut.size(), image, error) && !error.empty());
  const uint8_t jpeg[] = {0xff, 0xd8, 0xff, 0xe0, 0, 16};
  error.clear();
  CHECK(!decodeImage(jpeg, sizeof jpeg, image, error) && !error.empty());
  CHECK(isDecodableImageName("a/B.PNG") && isDecodableImageName("x.tiff") && !isDecodableImageName("clip.mp4") && !isDecodableImageName("dir.png/x"));
}

TEST(reports_footage_not_in_the_media_folders) {
  MediaLibrary media;
  std::string error;
  CHECK(media.image("/nowhere/missing.png", error) == nullptr);
  CHECK(!error.empty());
}
