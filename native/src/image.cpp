// PNG, BMP and baseline TIFF decoding for footage layers (see image.h). TIFF follows src/media/tiff.ts sample for
// sample; PNG and BMP follow what the browser's decoder returns with premultiplyAlpha "none" and no colour conversion:
// 16-bit samples rounded to 8 bits, low bit depths scaled to 0..255, tRNS keys and palette alpha applied.
#include "image.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstring>

namespace aevk {
namespace {

// --- inflate (RFC 1951) ----------------------------------------------------------------------------------------------

constexpr int kMaxBits = 15;
constexpr int kFastBits = 10;

struct BitReader {
  const uint8_t* data = nullptr;
  size_t size = 0, pos = 0;
  uint64_t buffer = 0;
  int count = 0;
  bool bad = false;

  void refill() {
    while (count <= 56 && pos < size) {
      buffer |= uint64_t(data[pos++]) << count;
      count += 8;
    }
  }
  uint32_t peek(int n) {
    if (count < n) refill();
    return uint32_t(buffer & ((uint64_t(1) << n) - 1));
  }
  void consume(int n) {
    if (count < n) refill();
    if (count < n) {
      bad = true;
      count = 0;
      buffer = 0;
      return;
    }
    buffer >>= n;
    count -= n;
  }
  uint32_t bits(int n) {
    if (n == 0) return 0;
    const uint32_t v = peek(n);
    consume(n);
    return v;
  }
  /** Drops the bits left of the current byte (before a stored block). */
  void alignToByte() { consume(count & 7); }
};

/** A canonical Huffman code: counts per length and symbols in code order (zlib's puff), with a table for short codes. */
struct Huffman {
  std::array<uint16_t, kMaxBits + 1> counts{};
  std::array<uint16_t, 288> symbols{};
  /** Per kFastBits-bit prefix (bits as read): code length << 9 | symbol, or 0 when the code is longer. */
  std::array<uint16_t, 1 << kFastBits> fast{};

  bool build(const uint8_t* lengths, int n) {
    counts.fill(0);
    fast.fill(0);
    for (int s = 0; s < n; s++) counts[lengths[s]]++;
    if (counts[0] == n) return true;
    int left = 1;
    for (int len = 1; len <= kMaxBits; len++) {
      left <<= 1;
      left -= counts[len];
      if (left < 0) return false;
    }
    std::array<uint16_t, kMaxBits + 2> offsets{};
    for (int len = 1; len <= kMaxBits; len++) offsets[len + 1] = uint16_t(offsets[len] + counts[len]);
    for (int s = 0; s < n; s++)
      if (lengths[s]) symbols[offsets[lengths[s]]++] = uint16_t(s);
    // Canonical codes, reversed for the bit order they are read in, fill the fast table.
    uint32_t code = 0;
    int index = 0;
    for (int len = 1; len <= kMaxBits; len++) {
      for (int i = 0; i < counts[len]; i++, index++, code++) {
        if (len > kFastBits) continue;
        uint32_t reversed = 0;
        for (int b = 0; b < len; b++) reversed |= ((code >> b) & 1u) << (len - 1 - b);
        for (uint32_t fill = reversed; fill < (1u << kFastBits); fill += 1u << len) fast[fill] = uint16_t(len << 9 | symbols[index]);
      }
      code <<= 1;
    }
    return true;
  }

  int decode(BitReader& r) const {
    const uint16_t entry = fast[r.peek(kFastBits)];
    if (entry) {
      r.consume(entry >> 9);
      return r.bad ? -1 : (entry & 511);
    }
    int code = 0, first = 0, index = 0;
    for (int len = 1; len <= kMaxBits; len++) {
      code |= int(r.bits(1));
      if (r.bad) return -1;
      const int count = counts[len];
      if (code - count < first) return symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    return -1;
  }
};

const uint16_t kLengthBase[29] = {3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258};
const uint8_t kLengthExtra[29] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
const uint16_t kDistBase[30] = {1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577};
const uint8_t kDistExtra[30] = {0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13};

bool inflateBlocks(BitReader& r, std::vector<uint8_t>& out) {
  size_t o = out.size();
  const auto room = [&out, &o](size_t n) {
    if (o + n > out.size()) out.resize(std::max(out.size() * 2, o + n + 65536));
  };
  Huffman lit, dist;
  for (bool last = false; !last;) {
    last = r.bits(1) != 0;
    const uint32_t type = r.bits(2);
    if (r.bad) return false;
    if (type == 0) {
      r.alignToByte();
      const uint32_t len = r.bits(16);
      const uint32_t nlen = r.bits(16);
      if (r.bad || (len ^ 0xffffu) != nlen) return false;
      room(len);
      for (uint32_t i = 0; i < len; i++) out[o++] = uint8_t(r.bits(8));
      if (r.bad) return false;
      continue;
    }
    if (type == 1) {
      uint8_t lengths[288 + 30];
      std::fill(lengths, lengths + 144, uint8_t(8));
      std::fill(lengths + 144, lengths + 256, uint8_t(9));
      std::fill(lengths + 256, lengths + 280, uint8_t(7));
      std::fill(lengths + 280, lengths + 288, uint8_t(8));
      std::fill(lengths + 288, lengths + 318, uint8_t(5));
      lit.build(lengths, 288);
      dist.build(lengths + 288, 30);
    } else if (type == 2) {
      const int nlen = int(r.bits(5)) + 257, ndist = int(r.bits(5)) + 1, ncode = int(r.bits(4)) + 4;
      if (r.bad || nlen > 286 || ndist > 30) return false;
      static const uint8_t order[19] = {16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15};
      uint8_t lengths[320] = {};
      for (int i = 0; i < ncode; i++) lengths[order[i]] = uint8_t(r.bits(3));
      Huffman lencode;
      if (r.bad || !lencode.build(lengths, 19)) return false;
      std::fill(lengths, lengths + 19, uint8_t(0));
      for (int i = 0; i < nlen + ndist;) {
        const int symbol = lencode.decode(r);
        if (symbol < 0) return false;
        if (symbol < 16) {
          lengths[i++] = uint8_t(symbol);
          continue;
        }
        uint8_t value = 0;
        int repeat;
        if (symbol == 16) {
          if (i == 0) return false;
          value = lengths[i - 1];
          repeat = 3 + int(r.bits(2));
        } else if (symbol == 17) {
          repeat = 3 + int(r.bits(3));
        } else {
          repeat = 11 + int(r.bits(7));
        }
        if (r.bad || i + repeat > nlen + ndist) return false;
        while (repeat--) lengths[i++] = value;
      }
      if (lengths[256] == 0) return false;
      if (!lit.build(lengths, nlen) || !dist.build(lengths + nlen, ndist)) return false;
    } else {
      return false;
    }
    for (;;) {
      int symbol = lit.decode(r);
      if (symbol < 0) return false;
      if (symbol < 256) {
        room(1);
        out[o++] = uint8_t(symbol);
        continue;
      }
      if (symbol == 256) break;
      symbol -= 257;
      if (symbol >= 29) return false;
      const size_t length = kLengthBase[symbol] + r.bits(kLengthExtra[symbol]);
      const int d = dist.decode(r);
      if (d < 0 || d >= 30) return false;
      const size_t distance = kDistBase[d] + r.bits(kDistExtra[d]);
      if (r.bad || distance > o) return false;
      room(length);
      uint8_t* p = out.data() + o;
      const uint8_t* from = p - distance;
      for (size_t i = 0; i < length; i++) p[i] = from[i];
      o += length;
    }
  }
  out.resize(o);
  return true;
}

// --- PNG -------------------------------------------------------------------------------------------------------------

uint32_t be32(const uint8_t* p) { return uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16 | uint32_t(p[2]) << 8 | p[3]; }

uint8_t paeth(int a, int b, int c) {
  const int p = a + b - c, pa = std::abs(p - a), pb = std::abs(p - b), pc = std::abs(p - c);
  return uint8_t(pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
}

/** Undoes the row filters of a `rows` x `stride` image whose pixels are `bpp` bytes apart, in place. */
bool unfilter(uint8_t* data, size_t rows, size_t stride, size_t bpp) {
  uint8_t* prior = nullptr;
  for (size_t y = 0; y < rows; y++) {
    const uint8_t filter = data[0];
    uint8_t* row = data + 1;
    for (size_t x = 0; x < stride; x++) {
      const int a = x >= bpp ? row[x - bpp] : 0, b = prior ? prior[x] : 0, c = prior && x >= bpp ? prior[x - bpp] : 0;
      switch (filter) {
        case 0: break;
        case 1: row[x] = uint8_t(row[x] + a); break;
        case 2: row[x] = uint8_t(row[x] + b); break;
        case 3: row[x] = uint8_t(row[x] + ((a + b) >> 1)); break;
        case 4: row[x] = uint8_t(row[x] + paeth(a, b, c)); break;
        default: return false;
      }
    }
    prior = row;
    data += stride + 1;
  }
  return true;
}

uint8_t to8(uint32_t v, int depth) {
  if (depth == 8) return uint8_t(v);
  if (depth == 16) return uint8_t((2 * v + 257) / 514);
  return uint8_t(v * 255 / ((1u << depth) - 1));
}

bool decodePng(const uint8_t* bytes, size_t size, ImageData& out, std::string& error) {
  static const uint8_t signature[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  if (size < 8 || std::memcmp(bytes, signature, 8) != 0) return (error = "not a PNG file"), false;
  uint32_t width = 0, height = 0;
  int depth = 0, colorType = 0, interlace = 0;
  std::vector<uint8_t> idat, palette, trns;
  bool header = false;
  for (size_t at = 8; at + 12 <= size;) {
    const uint32_t length = be32(bytes + at);
    const uint8_t* type = bytes + at + 4;
    const uint8_t* body = bytes + at + 8;
    if (length > size - at - 12) return (error = "the PNG file is cut short"), false;
    if (!std::memcmp(type, "IHDR", 4) && length >= 13) {
      width = be32(body);
      height = be32(body + 4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
      header = true;
    } else if (!std::memcmp(type, "PLTE", 4)) {
      palette.assign(body, body + length);
    } else if (!std::memcmp(type, "tRNS", 4)) {
      trns.assign(body, body + length);
    } else if (!std::memcmp(type, "IDAT", 4)) {
      idat.insert(idat.end(), body, body + length);
    } else if (!std::memcmp(type, "IEND", 4)) {
      break;
    }
    at += 12 + size_t(length);
  }
  if (!header || !width || !height || width > 32768 || height > 32768) return (error = "the PNG file has no usable header"), false;
  const int channels = colorType == 0 ? 1 : colorType == 2 ? 3 : colorType == 3 ? 1 : colorType == 4 ? 2 : colorType == 6 ? 4 : 0;
  const bool depthOk = colorType == 0 ? (depth == 1 || depth == 2 || depth == 4 || depth == 8 || depth == 16)
                       : colorType == 3 ? (depth == 1 || depth == 2 || depth == 4 || depth == 8)
                                        : (depth == 8 || depth == 16);
  if (!channels || !depthOk || interlace > 1) return (error = "the PNG file's pixel format is not one PNG allows"), false;
  if (colorType == 3 && palette.size() < 3) return (error = "the PNG file has no palette"), false;
  std::vector<uint8_t> raw;
  raw.reserve(size_t(width) * height * channels * depth / 8 + height);
  if (!inflateZlib(idat.data(), idat.size(), raw)) return (error = "the PNG file's image data is damaged"), false;

  const size_t bitsPerPixel = size_t(channels) * depth;
  const size_t bpp = std::max<size_t>(1, bitsPerPixel / 8);
  out.width = width;
  out.height = height;
  out.pixels.assign(size_t(width) * height * 4, 0);

  // A sample of a filtered row at pixel x, channel c.
  const auto sample = [depth, channels](const uint8_t* row, size_t x, int c) -> uint32_t {
    if (depth == 8) return row[x * channels + c];
    if (depth == 16) return uint32_t(row[(x * channels + c) * 2]) << 8 | row[(x * channels + c) * 2 + 1];
    const size_t bit = (x * channels + c) * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1u << depth) - 1);
  };
  const auto trns16 = [&trns](size_t i) -> uint32_t { return i * 2 + 1 < trns.size() ? (uint32_t(trns[i * 2]) << 8 | trns[i * 2 + 1]) : 0x10000u; };
  const auto put = [&](const uint8_t* row, size_t x, uint8_t* dst) {
    switch (colorType) {
      case 0: {
        const uint32_t g = sample(row, x, 0);
        dst[0] = dst[1] = dst[2] = to8(g, depth);
        dst[3] = trns.size() >= 2 && g == trns16(0) ? 0 : 255;
        break;
      }
      case 2: {
        const uint32_t r = sample(row, x, 0), g = sample(row, x, 1), b = sample(row, x, 2);
        dst[0] = to8(r, depth);
        dst[1] = to8(g, depth);
        dst[2] = to8(b, depth);
        dst[3] = trns.size() >= 6 && r == trns16(0) && g == trns16(1) && b == trns16(2) ? 0 : 255;
        break;
      }
      case 3: {
        const uint32_t i = sample(row, x, 0);
        if (i * 3 + 2 < palette.size()) {
          dst[0] = palette[i * 3];
          dst[1] = palette[i * 3 + 1];
          dst[2] = palette[i * 3 + 2];
        } else {
          dst[0] = dst[1] = dst[2] = 0;
        }
        dst[3] = i < trns.size() ? trns[i] : 255;
        break;
      }
      case 4:
        dst[0] = dst[1] = dst[2] = to8(sample(row, x, 0), depth);
        dst[3] = to8(sample(row, x, 1), depth);
        break;
      default:
        for (int c = 0; c < 4; c++) dst[c] = to8(sample(row, x, c), depth);
        break;
    }
  };

  // Adam7 passes (one pass covering every pixel when not interlaced): start x, start y, step x, step y.
  static const int passes[7][4] = {{0, 0, 8, 8}, {4, 0, 8, 8}, {0, 4, 4, 8}, {2, 0, 4, 4}, {0, 2, 2, 4}, {1, 0, 2, 2}, {0, 1, 1, 2}};
  static const int whole[1][4] = {{0, 0, 1, 1}};
  const int (*plan)[4] = interlace ? passes : whole;
  const int count = interlace ? 7 : 1;
  size_t at = 0;
  for (int p = 0; p < count; p++) {
    const size_t pw = width > uint32_t(plan[p][0]) ? (width - plan[p][0] + plan[p][2] - 1) / plan[p][2] : 0;
    const size_t ph = height > uint32_t(plan[p][1]) ? (height - plan[p][1] + plan[p][3] - 1) / plan[p][3] : 0;
    if (!pw || !ph) continue;
    const size_t stride = (pw * bitsPerPixel + 7) / 8;
    if (at + ph * (stride + 1) > raw.size()) return (error = "the PNG file's image data is cut short"), false;
    if (!unfilter(raw.data() + at, ph, stride, bpp)) return (error = "the PNG file's image data is damaged"), false;
    for (size_t y = 0; y < ph; y++) {
      const uint8_t* row = raw.data() + at + y * (stride + 1) + 1;
      const size_t oy = plan[p][1] + y * plan[p][3];
      for (size_t x = 0; x < pw; x++) {
        const size_t ox = plan[p][0] + x * plan[p][2];
        put(row, x, out.pixels.data() + (oy * width + ox) * 4);
      }
    }
    at += ph * (stride + 1);
  }
  return true;
}

// --- BMP -------------------------------------------------------------------------------------------------------------

uint32_t le32(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }
uint16_t le16(const uint8_t* p) { return uint16_t(p[0] | p[1] << 8); }

/** The value of `mask`'s bits in `v`, scaled to 0..255. */
uint8_t masked(uint32_t v, uint32_t mask) {
  if (!mask) return 0;
  int shift = 0;
  while (!((mask >> shift) & 1)) shift++;
  const uint32_t max = mask >> shift;
  return uint8_t(((v & mask) >> shift) * 255 / max);
}

bool decodeBmp(const uint8_t* bytes, size_t size, ImageData& out, std::string& error) {
  if (size < 26 || bytes[0] != 'B' || bytes[1] != 'M') return (error = "not a BMP file"), false;
  const uint32_t dataAt = le32(bytes + 10);
  const uint32_t headerSize = le32(bytes + 14);
  if (headerSize < 40 || size < 14 + size_t(headerSize)) return (error = "the BMP file's header is not one this reads"), false;
  const int32_t w = int32_t(le32(bytes + 18)), h = int32_t(le32(bytes + 22));
  const uint16_t bits = le16(bytes + 28);
  const uint32_t compression = le32(bytes + 30);
  uint32_t colors = le32(bytes + 46);
  if (w <= 0 || h == 0 || w > 32768 || std::abs(h) > 32768) return (error = "the BMP file has no usable size"), false;
  const bool topDown = h < 0;
  const uint32_t width = uint32_t(w), height = uint32_t(std::abs(h));
  uint32_t masks[4] = {0, 0, 0, 0};
  const bool bitfields = compression == 3 || compression == 6;
  if (compression != 0 && !bitfields) return (error = "compressed BMP files are not supported"), false;
  if (bitfields) {
    // The masks follow a 40-byte header, or are part of a larger one.
    for (int i = 0; i < (compression == 6 || headerSize >= 56 ? 4 : 3); i++)
      if (14 + 40 + size_t(i) * 4 + 4 <= size) masks[i] = le32(bytes + 54 + i * 4);
  } else if (bits == 16) {
    masks[0] = 0x7c00;
    masks[1] = 0x03e0;
    masks[2] = 0x001f;
  }
  const uint8_t* palette = bytes + 14 + headerSize + (bitfields && headerSize == 40 ? 12 : 0);
  if (bits <= 8 && !colors) colors = 1u << bits;
  if (bits <= 8 && palette + size_t(colors) * 4 > bytes + size) return (error = "the BMP file's palette is cut short"), false;
  if (bits != 1 && bits != 4 && bits != 8 && bits != 16 && bits != 24 && bits != 32) return (error = "the BMP file's bit depth is not supported"), false;
  const size_t stride = ((size_t(width) * bits + 31) / 32) * 4;
  if (dataAt + stride * height > size) return (error = "the BMP file is cut short"), false;
  out.width = width;
  out.height = height;
  out.pixels.assign(size_t(width) * height * 4, 255);
  for (uint32_t y = 0; y < height; y++) {
    const uint8_t* row = bytes + dataAt + stride * (topDown ? y : height - 1 - y);
    uint8_t* dst = out.pixels.data() + size_t(y) * width * 4;
    for (uint32_t x = 0; x < width; x++, dst += 4) {
      if (bits <= 8) {
        const size_t bit = size_t(x) * bits;
        const uint32_t i = (row[bit >> 3] >> (8 - bits - (bit & 7))) & ((1u << bits) - 1);
        const uint8_t* c = i < colors ? palette + i * 4 : palette;
        dst[0] = c[2];
        dst[1] = c[1];
        dst[2] = c[0];
      } else if (bits == 24) {
        dst[0] = row[x * 3 + 2];
        dst[1] = row[x * 3 + 1];
        dst[2] = row[x * 3];
      } else if (bits == 32 && !bitfields) {
        dst[0] = row[x * 4 + 2];
        dst[1] = row[x * 4 + 1];
        dst[2] = row[x * 4];
      } else {
        const uint32_t v = bits == 16 ? le16(row + x * 2) : le32(row + x * 4);
        dst[0] = masked(v, masks[0]);
        dst[1] = masked(v, masks[1]);
        dst[2] = masked(v, masks[2]);
        if (masks[3]) dst[3] = masked(v, masks[3]);
      }
    }
  }
  return true;
}

// --- TIFF (src/media/tiff.ts) ------------------------------------------------------------------------------------------

bool lzwDecode(const uint8_t* input, size_t size, size_t expected, std::vector<uint8_t>& out) {
  out.assign(expected, 0);
  size_t outPos = 0;
  // Entries as a prefix entry, a last byte and a length; the first 258 are the single bytes and the two codes.
  std::vector<int32_t> prefix(4096, -1);
  std::vector<uint8_t> last(4096), first(4096);
  std::vector<uint32_t> length(4096, 1);
  for (int i = 0; i < 256; i++) {
    last[i] = first[i] = uint8_t(i);
  }
  size_t entries = 258;
  int width = 9;
  int32_t prev = -1;
  std::vector<uint8_t> scratch;
  const auto emit = [&](int32_t code) {
    scratch.resize(length[code]);
    for (int32_t c = code, i = int32_t(length[code]) - 1; c >= 0 && i >= 0; c = prefix[c], i--) scratch[i] = last[c];
    const size_t n = std::min(scratch.size(), expected - outPos);
    std::memcpy(out.data() + outPos, scratch.data(), n);
    outPos += n;
  };
  const auto add = [&](int32_t base, uint8_t byte) {
    if (entries >= 4096) return;
    prefix[entries] = base;
    last[entries] = byte;
    first[entries] = first[base];
    length[entries] = length[base] + 1;
    entries++;
  };
  const size_t totalBits = size * 8;
  for (size_t bitPos = 0; bitPos + width <= totalBits;) {
    int32_t code = 0;
    for (int i = 0; i < width; i++) code = (code << 1) | ((input[(bitPos + i) >> 3] >> (7 - ((bitPos + i) & 7))) & 1);
    bitPos += width;
    if (code == 257) break;
    if (code == 256) {
      entries = 258;
      width = 9;
      prev = -1;
      continue;
    }
    if (size_t(code) < entries) {
      if (prev >= 0) add(prev, first[code]);
      emit(code);
    } else if (prev >= 0) {
      add(prev, first[prev]);
      emit(int32_t(entries - 1));
      code = int32_t(entries - 1);
    } else {
      return false;
    }
    prev = code;
    // TIFF LZW switches code width one code early.
    if (entries + 1 >= (size_t(1) << width) && width < 12) width++;
  }
  return true;
}

void packBitsDecode(const uint8_t* input, size_t size, size_t expected, std::vector<uint8_t>& out) {
  out.assign(expected, 0);
  size_t i = 0, o = 0;
  while (i < size && o < expected) {
    const int n = int8_t(input[i++]);
    if (n >= 0) {
      const size_t count = std::min({size_t(n) + 1, size - i, expected - o});
      std::memcpy(out.data() + o, input + i, count);
      i += size_t(n) + 1;
      o += size_t(n) + 1;
    } else if (n != -128) {
      const size_t count = std::min(size_t(1 - n), expected - o);
      if (i < size) std::memset(out.data() + o, input[i], count);
      i++;
      o += size_t(1 - n);
    }
  }
}

bool isTiff(const uint8_t* b, size_t size) {
  return size >= 8 && ((b[0] == 0x49 && b[1] == 0x49 && b[2] == 42) || (b[0] == 0x4d && b[1] == 0x4d && b[3] == 42));
}

bool decodeTiff(const uint8_t* bytes, size_t size, ImageData& out, std::string& error) {
  if (!isTiff(bytes, size)) return (error = "not a TIFF file"), false;
  const bool little = bytes[0] == 0x49;
  bool overrun = false;
  const auto u16 = [&](size_t o) -> uint32_t {
    if (o + 2 > size) return overrun = true, 0;
    return little ? uint32_t(bytes[o] | bytes[o + 1] << 8) : uint32_t(bytes[o] << 8 | bytes[o + 1]);
  };
  const auto u32 = [&](size_t o) -> uint32_t {
    if (o + 4 > size) return overrun = true, 0;
    return little ? le32(bytes + o) : be32(bytes + o);
  };
  const size_t ifd = u32(4);
  std::vector<std::pair<uint32_t, std::vector<uint32_t>>> tags;
  for (uint32_t i = 0, n = u16(ifd); i < n && !overrun; i++) {
    const size_t e = ifd + 2 + size_t(i) * 12;
    const uint32_t tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const uint32_t unit = type == 3 ? 2 : type == 4 ? 4 : 1;
    if (count > size) return (error = "the TIFF file is damaged"), false;
    const size_t at = size_t(count) * unit <= 4 ? e + 8 : u32(e + 8);
    std::vector<uint32_t> values;
    for (uint32_t k = 0; k < count && !overrun; k++) {
      values.push_back(unit == 2 ? u16(at + k * 2) : unit == 4 ? u32(at + k * 4) : (at + k < size ? bytes[at + k] : (overrun = true, 0)));
    }
    tags.emplace_back(tag, std::move(values));
  }
  if (overrun) return (error = "the TIFF file is cut short"), false;
  const auto find = [&tags](uint32_t tag) -> const std::vector<uint32_t>* {
    for (const auto& t : tags)
      if (t.first == tag) return &t.second;
    return nullptr;
  };
  const auto get = [&find](uint32_t tag, uint32_t fallback) {
    const std::vector<uint32_t>* v = find(tag);
    return v && !v->empty() ? (*v)[0] : fallback;
  };
  const uint32_t width = get(256, 0), height = get(257, 0), bits = get(258, 8), compression = get(259, 1);
  const uint32_t photometric = get(262, 2), spp = get(277, 1), planar = get(284, 1), predictor = get(317, 1);
  const uint32_t rowsPerStrip = std::min(get(278, height), height);
  if (find(322)) return (error = "tiled TIFF files are not supported"), false;
  if (bits != 8 && bits != 16) return (error = "unsupported TIFF bit depth " + std::to_string(bits)), false;
  if (photometric != 1 && photometric != 2) return (error = "unsupported TIFF photometric interpretation " + std::to_string(photometric)), false;
  if (!width || !height || width > 32768 || height > 32768 || !spp || spp > 16 || !rowsPerStrip) return (error = "the TIFF file has no usable size"), false;
  static const std::vector<uint32_t> none;
  const std::vector<uint32_t>& offsets = find(273) ? *find(273) : none;
  const std::vector<uint32_t>& counts = find(279) ? *find(279) : none;
  const size_t bps = bits / 8;
  const size_t planes = planar == 2 ? spp : 1;
  const size_t samplesPerPlaneRow = size_t(planar == 2 ? 1 : spp) * width;
  const size_t stripsPerPlane = (height + rowsPerStrip - 1) / rowsPerStrip;
  std::vector<std::vector<uint8_t>> planeData(planes, std::vector<uint8_t>(samplesPerPlaneRow * height * bps));
  std::vector<uint8_t> strip;
  for (size_t s = 0; s < offsets.size(); s++) {
    const size_t plane = s / stripsPerPlane;
    if (plane >= planes) break;
    const size_t firstRow = (s % stripsPerPlane) * rowsPerStrip;
    const size_t rows = std::min<size_t>(rowsPerStrip, height - firstRow);
    const size_t expected = rows * samplesPerPlaneRow * bps;
    const size_t start = std::min<size_t>(offsets[s], size);
    const size_t length = std::min<size_t>(s < counts.size() ? counts[s] : 0, size - start);
    const uint8_t* raw = bytes + start;
    if (compression == 1) {
      strip.assign(raw, raw + std::min(length, expected));
    } else if (compression == 5) {
      if (!lzwDecode(raw, length, expected, strip)) return (error = "corrupt LZW stream"), false;
    } else if (compression == 8 || compression == 32946) {
      strip.clear();
      if (!inflateZlib(raw, length, strip)) return (error = "the TIFF file's deflated data is damaged"), false;
    } else if (compression == 32773) {
      packBitsDecode(raw, length, expected, strip);
    } else {
      return (error = "unsupported TIFF compression " + std::to_string(compression)), false;
    }
    if (strip.size() < expected) strip.resize(expected, 0);
    if (predictor == 2) {
      const size_t stride = planar == 2 ? 1 : spp;
      for (size_t r = 0; r < rows; r++) {
        if (bps == 1) {
          uint8_t* row = strip.data() + r * samplesPerPlaneRow;
          for (size_t i = stride; i < samplesPerPlaneRow; i++) row[i] = uint8_t(row[i] + row[i - stride]);
        } else {
          uint8_t* row = strip.data() + r * samplesPerPlaneRow * 2;
          const auto read = [little, row](size_t i) { return little ? uint32_t(row[i * 2] | row[i * 2 + 1] << 8) : uint32_t(row[i * 2] << 8 | row[i * 2 + 1]); };
          for (size_t i = stride; i < samplesPerPlaneRow; i++) {
            const uint32_t v = (read(i) + read(i - stride)) & 0xffff;
            row[i * 2] = uint8_t(little ? v : v >> 8);
            row[i * 2 + 1] = uint8_t(little ? v >> 8 : v);
          }
        }
      }
    }
    std::memcpy(planeData[plane].data() + firstRow * samplesPerPlaneRow * bps, strip.data(), expected);
  }
  const auto sample = [bps, little](const std::vector<uint8_t>& plane, size_t index) -> uint8_t {
    if (bps == 1) return plane[index];
    const uint32_t v = little ? uint32_t(plane[index * 2] | plane[index * 2 + 1] << 8) : uint32_t(plane[index * 2] << 8 | plane[index * 2 + 1]);
    return uint8_t((2 * v + 257) / 514);
  };
  const uint32_t color = photometric == 2 ? 3 : 1;
  if (planar != 2 && spp < color) return (error = "the TIFF file has fewer samples than its colours need"), false;
  out.width = width;
  out.height = height;
  out.pixels.assign(size_t(width) * height * 4, 0);
  for (size_t p = 0; p < size_t(width) * height; p++) {
    const auto channel = [&](uint32_t c) { return planar == 2 ? (c < planes ? sample(planeData[c], p) : uint8_t(0)) : sample(planeData[0], p * spp + c); };
    const uint8_t r = channel(0);
    uint8_t* dst = out.pixels.data() + p * 4;
    dst[0] = r;
    dst[1] = color == 3 ? channel(1) : r;
    dst[2] = color == 3 ? channel(2) : r;
    dst[3] = spp > color ? channel(color) : 255;
  }
  return true;
}

}  // namespace

bool inflateRaw(const uint8_t* data, size_t size, std::vector<uint8_t>& out) {
  BitReader r;
  r.data = data;
  r.size = size;
  return inflateBlocks(r, out);
}

bool inflateZlib(const uint8_t* data, size_t size, std::vector<uint8_t>& out) {
  if (size < 2 || (data[0] & 0x0f) != 8 || ((uint32_t(data[0]) << 8 | data[1]) % 31) != 0 || (data[1] & 0x20)) return false;
  return inflateRaw(data + 2, size - 2, out);
}

bool isDecodableImageName(const std::string& name) {
  const size_t dot = name.find_last_of('.');
  const size_t slash = name.find_last_of("/\\");
  if (dot == std::string::npos || (slash != std::string::npos && dot < slash)) return false;
  std::string ext = name.substr(dot + 1);
  for (char& c : ext) c = char(std::tolower(static_cast<unsigned char>(c)));
  return ext == "png" || ext == "bmp" || ext == "tif" || ext == "tiff";
}

bool decodeImage(const uint8_t* bytes, size_t size, ImageData& out, std::string& error) {
  if (size >= 8 && bytes[0] == 137 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G') return decodePng(bytes, size, out, error);
  if (isTiff(bytes, size)) return decodeTiff(bytes, size, out, error);
  if (size >= 2 && bytes[0] == 'B' && bytes[1] == 'M') return decodeBmp(bytes, size, out, error);
  error = "not an image the native engine decodes (PNG, BMP or TIFF)";
  return false;
}

}  // namespace aevk
