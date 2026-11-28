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
  double f64() {
    const uint64_t lo = u32(), hi = u32();
    const uint64_t bits = lo | hi << 32;
    double v;
    std::memcpy(&v, &bits, 8);
    return v;
  }
  std::string str() {
    const uint32_t n = count(1);
    std::string s(n, '\0');
    if (n) bytes(reinterpret_cast<uint8_t*>(s.data()), n);
    return s;
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
    case uint32_t(ContentKind::Footage): {
      content.kind = ContentKind::Footage;
      FootageFrame& f = content.footage;
      f.file = r.str();
      f.sourceWidth = r.side();
      f.sourceHeight = r.side();
      const uint32_t flags = r.u32();
      f.hasAlpha = (flags & 1) != 0;
      f.invertAlpha = (flags & 2) != 0;
      f.alphaMode = r.u32();
      if (f.alphaMode > 2) r.fail("unknown footage alpha mode");
      for (float& c : f.matte) c = r.f32();
      f.videoTime = r.f64();
      break;
    }
    default:
      r.fail("unknown content kind");
  }
}

void readMasks(Reader& r, std::vector<Mask>& masks) {
  masks.resize(r.count(28));
  for (Mask& mask : masks) {
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
}

void readEffect(Reader& r, Effect& effect, int depth) {
  if (depth > kMaxDepth) r.fail("plan nested too deep");
  effect.matchName = r.str();
  effect.params.resize(r.count(12));
  for (EffectParam& param : effect.params) {
    param.index = r.u32();
    if (param.index > 9999) r.fail("effect parameter index beyond 9999");
    if (!param.index) param.matchName = r.str();
    param.value.resize(r.count(8));
    for (double& v : param.value) v = r.f64();
    param.menu.resize(r.count(4));
    for (uint8_t& m : param.menu) m = r.u32() != 0;
  }
  effect.sources.resize(r.count(8));
  for (EffectSource& source : effect.sources) {
    source.param = r.u32();
    if (source.param == 0 || source.param > 9999) r.fail("effect source parameter index out of range");
    source.drawn = r.u32() != 0;
    if (!source.drawn) continue;
    readContent(r, source.content, depth + 1);
    source.layer.width = r.f32();
    source.layer.height = r.f32();
    source.layer.kind = r.u32();
    if (source.layer.kind > 2) r.fail("unknown effect source layer kind");
  }
  const uint32_t flags = r.u32();
  if (flags & ~31u) r.fail("unknown effect flags");
  effect.hasAudio = (flags & 1) != 0;
  if (effect.hasAudio) {
    effect.audio.resize(r.count(36));
    for (AudioSource& a : effect.audio) {
      a.file = r.str();
      a.scale = r.f64();
      a.offset = r.f64();
      a.from = r.f64();
      a.to = r.f64();
    }
  }
  effect.hasPath = (flags & 2) != 0;
  if (effect.hasPath) {
    effect.path.closed = r.u32() != 0;
    effect.path.vertices.resize(size_t(r.count(24)) * 6);
    for (float& v : effect.path.vertices) v = r.f32();
  }
  if (flags & 4) {
    effect.inputs.resize(r.count(12));
    for (EffectInput& input : effect.inputs) {
      input.time = r.f64();
      input.drawn = r.u32() != 0;
      if (!input.drawn) continue;
      readContent(r, input.content, depth + 1);
      readMasks(r, input.masks);
      input.effects.resize(r.count(12));
      for (Effect& inner : input.effects) readEffect(r, inner, depth + 1);
    }
  }
  if (flags & 8) {
    effect.data.resize(r.count(8));
    for (EffectData& data : effect.data) {
      data.param = r.u32();
      data.bytes.resize(r.count(1));
      if (!data.bytes.empty()) r.bytes(data.bytes.data(), data.bytes.size());
    }
  }
  effect.hasParticles = (flags & 16) != 0;
  if (effect.hasParticles) {
    for (std::vector<float>* splats : {&effect.particles.glow, &effect.particles.core}) {
      splats->resize(size_t(r.count(20)) * 5);
      for (float& v : *splats) v = r.f32();
    }
    for (float& c : effect.particles.color) c = r.f32();
    effect.particles.glowBlend = r.u32();
    effect.particles.particleBlend = r.u32();
    if (effect.particles.glowBlend - 1 > 3 || effect.particles.particleBlend - 1 > 3) r.fail("unknown particle blend mode");
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
  readMasks(r, layer.masks);
  const uint32_t effects = r.count(12);
  if (effects) {
    EffectLayer& info = layer.effectLayer;
    info.time = r.f64();
    info.startTime = r.f64();
    info.stretch = r.f64();
    info.width = r.f32();
    info.height = r.f32();
    info.kind = r.u32();
    if (info.kind > 2) r.fail("unknown effect layer kind");
    layer.effects.resize(effects);
    for (Effect& effect : layer.effects) readEffect(r, effect, depth);
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

void checkImages(const Comp& comp, size_t images, const Reader& r);

/** Image content anywhere under `content` and `effects` (sources and time inputs included) must name a decoded image. */
void checkImages(const Content& content, const std::vector<Effect>& effects, size_t images, const Reader& r) {
  if (content.kind == ContentKind::Image && content.image >= images) r.fail("image content refers to a missing image");
  if (content.kind == ContentKind::Comp) checkImages(*content.comp, images, r);
  for (const Effect& effect : effects) {
    for (const EffectSource& source : effect.sources)
      if (source.drawn) checkImages(source.content, {}, images, r);
    for (const EffectInput& input : effect.inputs)
      if (input.drawn) checkImages(input.content, input.effects, images, r);
  }
}

void checkImages(const Comp& comp, size_t images, const Reader& r) {
  for (const Layer& layer : comp.layers)
    for (const Layer* l = &layer; l; l = l->matte.get()) checkImages(l->content, l->effects, images, r);
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
