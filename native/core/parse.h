/**
 * Builds a CProject from the bytes of an .aep file, as src/aep/parse.ts does, keeping what evaluation and rendering
 * need: items, comps, layers with their property trees, keyframes, masks, shape paths and gradients.
 */
#pragma once

#include <string>
#include <vector>

#include "model.h"

namespace aep
{

/**
 * Parses a project; the project keeps its own copy of the bytes. False with `error` set when the file is not a
 * project; recoverable problems go to CProject::m_Warnings.
 */
bool ParseProject(std::vector<u8> bytes, CProject& project, std::string& error);

/** Reads a whole file into `bytes`; false with `error` set when it cannot. */
bool ReadFileBytes(const std::string& path, std::vector<u8>& bytes, std::string& error);

} /** namespace aep */
