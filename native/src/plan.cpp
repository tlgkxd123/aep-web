#include "plan.h"

#include <cstring>
#include <initializer_list>
#include <stdexcept>

namespace aevk {
namespace {

/** Images and comps larger than this on a side are refused (no GPU has textures that large). */
constexpr uint32_t kMaxSide = 16384;
/** Nesting the reader follows at most (plans nest comps 16 deep, plus their mattes). */
constexpr int kMaxDepth = 64;

class Reader {
 public:
  Reader(const uint8_t* data, size_t size) : data_(data), size_(size) {}

  uint32_t u32() {
    need(4);
    uint32_t v = uint32_t(data_[at_]) | uint32_t(data_[at_ + 1]) << 8 | uint32_t(data_[at_ + 2]) << 16 | uint32_t(data_[at_ + 3]) << 24;
    at_ += 4;
    return v;
  }
  float f32() {
    uint32_t bits = u32();
    float v;
    std::memcpy(&v, &bits, 4);
    return v;
  }
  /** A count of items at least `itemBytes` long each, checked against what is left. */
  uint32_t count(size_t itemBytes) {
    uint32_t n = u32();
    if (itemBytes && n > (size_ - at_) / itemBytes) fail("count larger than the plan");
    return n;
  }
  uint32_t side() {
    uint32_t v = u32();
    if (v > kMaxSide) fail("image side larger than 16384");
    return v;
  }
  void bytes(uint8_t* out, size_t n) {
    need(n);
    std::memcpy(out, data_ + at_, n);
    at_ += n;
  }
  bool done() const { return at_ == size_; }
  size_t offset() const { return at_; }
  [[noreturn]] void fail(const char* what) const { throw std::runtime_error(std::string(what) + " at byte " + std::to_string(at_)); }

 private:
  void need(size_t n) const {
    if (n > size_ - at_) fail("plan truncated");
  }
  const uint8_t* data_;
  size_t size_;
  size_t at_ = 0;
};

void readComp(Reader& r, Comp& comp, int depth);

void readPaint(Reader& r, ShapePaint& paint) {
  const uint32_t flags = r.u32();
  paint.stroke = flags & 1;
  paint.evenOdd = flags & 2;
  for (float& v : paint.matrix) v = r.f32();
  paint.width = r.f32();
  paint.cap = r.u32();
  paint.join = r.u32();
  paint.miterLimit = r.f32();
  for (float& c : paint.color) c = r.f32();
  paint.gradient = r.u32();
  if (paint.gradient > 2) r.fail("unknown gradient type");
  if (paint.gradient) {
    for (auto* point : {&paint.start, &paint.end, &paint.focus})
      for (float& v : *point) v = r.f32();
    const uint32_t stops = r.count(16);
    if (stops < 2) r.fail("gradient ramp with fewer than two stops");
    paint.ramp.resize(size_t(stops) * 4);
    for (float& v : paint.ramp) v = r.f32();
  }
  paint.paths.resize(r.count(8));
  for (ShapePath& path : paint.paths) {
    path.closed = r.u32() != 0;
    path.vertices.resize(size_t(r.count(24)) * 6);
    for (float& v : path.vertices) v = r.f32();
  }
}

void readContent(Reader& r, Content& content, int depth) {
  uint32_t kind = r.u32();
  content.width = r.side();
  content.height = r.side();
  content.originX = r.f32();
  content.originY = r.f32();
  content.scale = r.f32();
  if (!(content.scale > 0)) r.fail("content scale is not positive");
  switch (kind) {
    case uint32_t(ContentKind::Solid):
      content.kind = ContentKind::Solid;
      for (float& c : content.color) c = r.f32();
      break;
    case uint32_t(ContentKind::Comp):
      content.kind = ContentKind::Comp;
      content.comp = std::make_unique<Comp>();
      readComp(r, *content.comp, depth + 1);
      break;
    case uint32_t(ContentKind::Image):
      content.kind = ContentKind::Image;
      content.image = r.u32();
      break;
    case uint32_t(ContentKind::Shape): {
      content.kind = ContentKind::Shape;
      content.paints.resize(r.count(68));
      for (ShapePaint& paint : content.paints) readPaint(r, paint);
      break;
    }
    default:
      r.fail("unknown content kind");
  }
}

void readLayer(Reader& r, Layer& layer, int depth) {
  if (depth > kMaxDepth) r.fail("plan nested too deep");
  uint32_t flags = r.u32();
  layer.adjustment = (flags & 1) != 0;
  layer.blendMode = r.u32();
  layer.opacity = r.f32();
  for (float& m : layer.matrix) m = r.f32();
  layer.zoom = r.f32();
  readContent(r, layer.content, depth);
  uint32_t masks = r.count(28);
  layer.masks.resize(masks);
  for (Mask& mask : layer.masks) {
    mask.mode = r.u32();
    mask.inverted = r.u32() != 0;
    mask.opacity = r.f32();
    mask.feather = r.f32();
    mask.expansion = r.f32();
    mask.closed = r.u32() != 0;
    uint32_t vertices = r.count(24);
    mask.vertices.resize(size_t(vertices) * 6);
    for (float& v : mask.vertices) v = r.f32();
  }
  layer.matteMode = r.u32();
  if (layer.matteMode > matte::LumaInverted) r.fail("unknown track matte mode");
  if (layer.matteMode != matte::None) {
    layer.matteOpacity = r.f32();
    if (r.u32()) {
      layer.matte = std::make_unique<Layer>();
      readLayer(r, *layer.matte, depth + 1);
    }
  }
}

void readComp(Reader& r, Comp& comp, int depth) {
  if (depth > kMaxDepth) r.fail("plan nested too deep");
  comp.width = r.side();
  comp.height = r.side();
  if (!comp.width || !comp.height) r.fail("comp has no pixels");
  uint32_t layers = r.count(96);
  comp.layers.resize(layers);
  for (Layer& layer : comp.layers) readLayer(r, layer, depth);
}

void checkImages(const Comp& comp, size_t images, const Reader& r) {
  for (const Layer& layer : comp.layers) {
    for (const Layer* l = &layer; l; l = l->matte.get()) {
      if (l->content.kind == ContentKind::Image && l->content.image >= images) r.fail("image content refers to a missing image");
      if (l->content.kind == ContentKind::Comp) checkImages(*l->content.comp, images, r);
    }
  }
}

}  // namespace

bool decodePlan(const uint8_t* data, size_t size, Plan& plan, std::string& error) {
  try {
    Reader r(data, size);
    if (r.u32() != kPlanMagic) r.fail("not a render plan");
    uint32_t version = r.u32();
    if (version != kPlanVersion) r.fail(("render plan version " + std::to_string(version)).c_str());
    plan = Plan();
    readComp(r, plan.root, 0);
    uint32_t images = r.count(8);
    plan.images.resize(images);
    for (Image& image : plan.images) {
      image.width = r.side();
      image.height = r.side();
      image.pixels.resize(size_t(image.width) * image.height * 4);
      r.bytes(image.pixels.data(), image.pixels.size());
    }
    if (!r.done()) r.fail("trailing bytes");
    checkImages(plan.root, plan.images.size(), r);
    return true;
  } catch (const std::exception& e) {
    error = e.what();
    return false;
  }
}

}  // namespace aevk
