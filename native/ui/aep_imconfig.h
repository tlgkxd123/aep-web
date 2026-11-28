/**
 * Dear ImGui's build options for the app (IMGUI_USER_CONFIG, native/CMakeLists.txt).
 */
#pragma once

/** 32-bit indices: a long timeline draws more than 65536 vertices in one window. */
#define ImDrawIdx unsigned int
#define IMGUI_DISABLE_OBSOLETE_FUNCTIONS
/** The app opens no URLs or files through the shell. */
#define IMGUI_DISABLE_DEFAULT_SHELL_FUNCTIONS
