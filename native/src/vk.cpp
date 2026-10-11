#include "vk.h"

#include <initializer_list>

#if defined(_WIN32)
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace aevk::vk {

#define AEVK_DEFINE(name) PFN_##name name = nullptr;
AEVK_GLOBAL_FUNCTIONS(AEVK_DEFINE)
AEVK_INSTANCE_FUNCTIONS(AEVK_DEFINE)
AEVK_PLATFORM_INSTANCE_FUNCTIONS(AEVK_DEFINE)
AEVK_DEVICE_FUNCTIONS(AEVK_DEFINE)
#undef AEVK_DEFINE

static PFN_vkGetInstanceProcAddr getInstanceProcAddr = nullptr;

bool loadLibrary(const char** error) {
  if (getInstanceProcAddr) return true;
#if defined(_WIN32)
  HMODULE library = LoadLibraryA("vulkan-1.dll");
  if (library) getInstanceProcAddr = reinterpret_cast<PFN_vkGetInstanceProcAddr>(GetProcAddress(library, "vkGetInstanceProcAddr"));
#else
  void* library = nullptr;
  for (const char* name : {"libvulkan.so.1", "libvulkan.so", "libvulkan.1.dylib", "libMoltenVK.dylib"}) {
    library = dlopen(name, RTLD_NOW | RTLD_LOCAL);
    if (library) break;
  }
  if (library) getInstanceProcAddr = reinterpret_cast<PFN_vkGetInstanceProcAddr>(dlsym(library, "vkGetInstanceProcAddr"));
#endif
  if (!getInstanceProcAddr) {
    if (error) *error = "this system has no Vulkan loader";
    return false;
  }
#define AEVK_LOAD(name) name = reinterpret_cast<PFN_##name>(getInstanceProcAddr(nullptr, #name));
  AEVK_GLOBAL_FUNCTIONS(AEVK_LOAD)
#undef AEVK_LOAD
  if (!vkCreateInstance) {
    if (error) *error = "the Vulkan loader has no vkCreateInstance";
    return false;
  }
  return true;
}

void loadInstance(VkInstance instance) {
#define AEVK_LOAD(name) name = reinterpret_cast<PFN_##name>(getInstanceProcAddr(instance, #name));
  AEVK_INSTANCE_FUNCTIONS(AEVK_LOAD)
  AEVK_PLATFORM_INSTANCE_FUNCTIONS(AEVK_LOAD)
#undef AEVK_LOAD
}

void loadDevice(VkDevice device) {
#define AEVK_LOAD(name) name = reinterpret_cast<PFN_##name>(vkGetDeviceProcAddr(device, #name));
  AEVK_DEVICE_FUNCTIONS(AEVK_LOAD)
#undef AEVK_LOAD
}

}  // namespace aevk::vk
