#include "fx.h"

#include <cstdlib>
#include <cstring>

namespace aevk {
namespace {

uint32_t components(FxType type) {
  switch (type) {
    case FxType::Float: case FxType::Int: case FxType::UInt: case FxType::Bool: return 1;
    case FxType::Vec2: case FxType::IVec2: case FxType::UVec2: return 2;
    case FxType::Vec3: case FxType::IVec3: case FxType::UVec3: return 3;
    case FxType::Vec4: case FxType::IVec4: case FxType::UVec4: case FxType::Mat2: return 4;
    case FxType::Mat3: return 9;
    case FxType::Mat4: return 16;
  }
  return 0;
}

bool isFloat(FxType type) {
  return type == FxType::Float || type == FxType::Vec2 || type == FxType::Vec3 || type == FxType::Vec4 || type == FxType::Mat2 || type == FxType::Mat3 ||
         type == FxType::Mat4;
}

/** "u_weights[3]" -> "u_weights" and 3. */
std::string baseName(const char* name, uint32_t& element) {
  element = 0;
  const char* bracket = std::strchr(name, '[');
  if (!bracket) return name;
  element = uint32_t(std::strtoul(bracket + 1, nullptr, 10));
  return std::string(name, bracket);
}

}  // namespace

const FxUniform* FxUniforms::find(const char* name) const {
  for (uint32_t i = 0; i < shader_.uniformCount; i++)
    if (!std::strcmp(shader_.uniforms[i].name, name)) return &shader_.uniforms[i];
  return nullptr;
}

void FxUniforms::write(const char* name, const void* values, uint32_t count, uint32_t perElement, bool integer) {
  uint32_t element = 0;
  const std::string base = baseName(name, element);
  for (uint32_t i = 0; i < shader_.samplerCount; i++) {
    if (base == shader_.samplers[i]) {
      // A sampler takes the texture unit (input) it reads, as with gl.uniform1i.
      if (integer && perElement == 1 && count >= 1) units_[i] = uint32_t(static_cast<const int32_t*>(values)[0]);
      return;
    }
  }
  const FxUniform* u = find(base.c_str());
  if (!u || element >= u->count) return;
  const uint32_t n = components(u->type);
  // Matrices are columns: mat3 columns are 16 bytes apart in std430.
  const uint32_t column = u->type == FxType::Mat3 ? 3 : u->type == FxType::Mat2 ? 2 : u->type == FxType::Mat4 ? 4 : n;
  const uint32_t columnBytes = u->type == FxType::Mat2 ? 8 : 16;
  if (perElement != n) return;  // WebGL rejects a call of the wrong size
  if (u->type != FxType::Bool && integer == isFloat(u->type)) return;
  for (uint32_t e = 0; e < count && element + e < u->count; e++) {
    uint8_t* at = params_ + u->offset + (element + e) * u->stride;
    for (uint32_t c = 0; c < n; c++) {
      uint8_t* slot = at + (c / column) * columnBytes + (c % column) * 4;
      const size_t k = size_t(e) * n + c;
      if (u->type == FxType::Bool) {
        const uint32_t v = integer ? static_cast<const int32_t*>(values)[k] != 0 : static_cast<const float*>(values)[k] != 0;
        std::memcpy(slot, &v, 4);
      } else {
        std::memcpy(slot, integer ? static_cast<const void*>(static_cast<const int32_t*>(values) + k) : static_cast<const void*>(static_cast<const float*>(values) + k), 4);
      }
    }
  }
}

void FxUniforms::i(const char* name, int32_t x) { write(name, &x, 1, 1, true); }
void FxUniforms::i(const char* name, int32_t x, int32_t y) {
  const int32_t v[] = {x, y};
  write(name, v, 1, 2, true);
}
void FxUniforms::i(const char* name, int32_t x, int32_t y, int32_t z) {
  const int32_t v[] = {x, y, z};
  write(name, v, 1, 3, true);
}
void FxUniforms::i(const char* name, int32_t x, int32_t y, int32_t z, int32_t w) {
  const int32_t v[] = {x, y, z, w};
  write(name, v, 1, 4, true);
}
void FxUniforms::f(const char* name, float x) { write(name, &x, 1, 1, false); }
void FxUniforms::f(const char* name, float x, float y) {
  const float v[] = {x, y};
  write(name, v, 1, 2, false);
}
void FxUniforms::f(const char* name, float x, float y, float z) {
  const float v[] = {x, y, z};
  write(name, v, 1, 3, false);
}
void FxUniforms::f(const char* name, float x, float y, float z, float w) {
  const float v[] = {x, y, z, w};
  write(name, v, 1, 4, false);
}
void FxUniforms::fv(const char* name, const float* values, uint32_t count, uint32_t perElement) { write(name, values, count, perElement, false); }
void FxUniforms::iv(const char* name, const int32_t* values, uint32_t count, uint32_t perElement) { write(name, values, count, perElement, true); }
void FxUniforms::matrix(const char* name, const float* columns) {
  uint32_t element = 0;
  const FxUniform* u = find(baseName(name, element).c_str());
  if (u) write(name, columns, 1, components(u->type), false);
}

double fxNumber(const Effect& effect, uint32_t index, double fallback) {
  const EffectParam* p = effect.param(index);
  return p && !p->value.empty() ? p->value[0] : fallback;
}

std::vector<double> fxVector(const Effect& effect, uint32_t index, const std::vector<double>& fallback) {
  const EffectParam* p = effect.param(index);
  return p && !p->value.empty() ? p->value : fallback;
}

}  // namespace aevk
