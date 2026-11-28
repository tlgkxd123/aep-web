// Still images the engine decodes itself for footage layers (src/media/store.ts decodeImage, tiff.ts): PNG, BMP and
// baseline TIFF, to straight 8-bit RGBA, top row first, samples as the file stores them (Interpret Footage decides
// what the alpha means).
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace aevk {

/** Straight RGBA, top row first. */
struct ImageData {
  uint32_t width = 0, height = 0;
  std::vector<uint8_t> pixels;
};

/** A zlib stream (RFC 1950, its checksum unchecked) inflated onto `out`; false when it is damaged. */
bool inflateZlib(const uint8_t* data, size_t size, std::vector<uint8_t>& out);
/** A raw deflate stream (RFC 1951) inflated onto `out`; false when it is damaged. */
bool inflateRaw(const uint8_t* data, size_t size, std::vector<uint8_t>& out);

/** Whether the file name's extension is one decodeImage reads (.png, .bmp, .tif, .tiff), case aside. */
bool isDecodableImageName(const std::string& name);

/** Decodes a PNG, BMP or TIFF file by its leading bytes; false with `error` set for anything else or a damaged file. */
bool decodeImage(const uint8_t* bytes, size_t size, ImageData& out, std::string& error);

}  // namespace aevk
