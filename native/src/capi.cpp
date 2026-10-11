#include "aevk/aevk.h"

#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>

#include "engine.h"
#include "plan.h"

struct aevk_engine {
  std::unique_ptr<aevk::Engine> engine;
};

namespace {
thread_local std::string lastError;

int fail(const std::string& error) {
  lastError = error;
  return 0;
}
}  // namespace

extern "C" {

aevk_engine* aevk_create(void) {
  std::string error;
  std::unique_ptr<aevk::Engine> engine = aevk::Engine::create(aevk::EngineOptions(), error);
  if (!engine) {
    fail(error);
    return nullptr;
  }
  return new aevk_engine{std::move(engine)};
}

void aevk_destroy(aevk_engine* engine) { delete engine; }

const char* aevk_device_name(const aevk_engine* engine) { return engine->engine->device().name.c_str(); }

uint32_t aevk_device_api_version(const aevk_engine* engine) { return engine->engine->device().apiVersion; }

int aevk_render(aevk_engine* engine, const uint8_t* plan, size_t size, uint8_t** rgba, uint32_t* width, uint32_t* height) {
  aevk::Plan decoded;
  std::string error;
  if (!aevk::decodePlan(plan, size, decoded, error)) return fail(error);
  std::vector<uint8_t> pixels;
  if (!engine->engine->render(decoded, pixels, *width, *height, error)) return fail(error);
  *rgba = static_cast<uint8_t*>(std::malloc(pixels.size()));
  if (!*rgba) return fail("out of memory");
  std::memcpy(*rgba, pixels.data(), pixels.size());
  return 1;
}

void aevk_free(void* pointer) { std::free(pointer); }

const char* aevk_last_error(void) { return lastError.c_str(); }

}  // extern "C"
