/**
 * The binary form of a plan (src/native/wire.ts), written from an in-memory aevk::Plan. The native engine never needs
 * it on the native path; it exists so plans built in C++ can be compared byte for byte with the TypeScript planner's.
 */
#pragma once

#include <vector>

#include "../src/plan.h"
#include "types.h"

namespace aep
{

/** `plan` in the engine's wire format, little-endian 32-bit fields. */
std::vector<u8> EncodePlan(const aevk::Plan& plan);

} /** namespace aep */
