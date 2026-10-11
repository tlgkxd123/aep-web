/*
 * C interface to the native engine, for hosts that cannot use C++ directly (JNI, FFI).
 *
 * Plans are the bytes src/native/wire.ts writes. Pixels are straight RGBA, rows top first. Functions returning int
 * return 1 on success and 0 on failure, with aevk_last_error() saying why. An engine is used from one thread at a time.
 */
#ifndef AEVK_AEVK_H
#define AEVK_AEVK_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct aevk_engine aevk_engine;

/** Opens the best Vulkan device; null when there is none (aevk_last_error says why). */
aevk_engine* aevk_create(void);
void aevk_destroy(aevk_engine* engine);

/** The device's name, and its Vulkan version as VK_MAKE_API_VERSION. */
const char* aevk_device_name(const aevk_engine* engine);
uint32_t aevk_device_api_version(const aevk_engine* engine);

/** Renders a plan; `*rgba` (width * height * 4 bytes) is freed with aevk_free. */
int aevk_render(aevk_engine* engine, const uint8_t* plan, size_t size, uint8_t** rgba, uint32_t* width, uint32_t* height);
void aevk_free(void* pointer);

/** Why the last call on this thread failed. */
const char* aevk_last_error(void);

#ifdef __cplusplus
}
#endif

#endif
