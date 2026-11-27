# The native Vulkan engine (aevk): the compositor and playback core the Android app runs, and a headless renderer
# for checking it against After Effects' reference frames (scripts/reports/native-report.ts).
#
#   cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build && ctest --test-dir native/build
#
# Android builds it through android/app/build.gradle (externalNativeBuild), with the NDK's Vulkan headers.
#
# aepcore (native/core) is the project side in C++: it parses .aep files, evaluates properties and builds the plans the
# engine draws, with no GPU dependency (docs/native-port.md, milestone M1).
cmake_minimum_required(VERSION 3.18)
project(aevk LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

option(AEVK_TOOLS "Build the headless renderer and the tests" ON)

add_library(aevk STATIC
  src/capi.cpp
  src/engine.cpp
  src/geometry.cpp
  src/plan.cpp
  src/playback.cpp
  src/vk.cpp
)
target_include_directories(aevk PUBLIC include src)

if(ANDROID)
  # The NDK's sysroot holds the Vulkan headers; the loader is opened at run time.
  target_link_libraries(aevk PUBLIC android log)
  set(AEVK_TOOLS OFF)
else()
  find_package(Vulkan QUIET)
  if(TARGET Vulkan::Headers)
    target_link_libraries(aevk PUBLIC Vulkan::Headers)
  elseif(Vulkan_INCLUDE_DIRS)
    target_include_directories(aevk PUBLIC ${Vulkan_INCLUDE_DIRS})
  else()
    include(FetchContent)
    FetchContent_Declare(VulkanHeaders GIT_REPOSITORY https://github.com/KhronosGroup/Vulkan-Headers.git GIT_TAG v1.3.275 GIT_SHALLOW TRUE)
    FetchContent_MakeAvailable(VulkanHeaders)
    target_link_libraries(aevk PUBLIC Vulkan::Headers)
  endif()
  if(UNIX)
    target_link_libraries(aevk PUBLIC ${CMAKE_DL_LIBS})
  endif()
endif()

if(MSVC)
  target_compile_options(aevk PRIVATE /W4)
  # std::getenv is read once, at startup, from one thread.
  target_compile_definitions(aevk PRIVATE _CRT_SECURE_NO_WARNINGS)
else()
  # VkFoo info{VK_STRUCTURE_TYPE_FOO} zero-initializes the other members on purpose.
  target_compile_options(aevk PRIVATE -Wall -Wextra -Wno-missing-field-initializers)
endif()

add_library(aepcore STATIC
  core/evaluate.cpp
  core/model.cpp
  core/parse.cpp
  core/planner.cpp
  core/riff.cpp
  core/shapes.cpp
  core/transform.cpp
  core/wire.cpp
)
target_include_directories(aepcore PUBLIC core)
if(MSVC)
  target_compile_options(aepcore PRIVATE /W4)
else()
  target_compile_options(aepcore PRIVATE -Wall -Wextra -Wno-missing-field-initializers)
endif()

if(ANDROID)
  add_library(aevk_jni SHARED android/aevk_jni.cpp)
  target_link_libraries(aevk_jni PRIVATE aevk)
  set_target_properties(aevk aevk_jni PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
  # 16 KB pages: Android 15 devices may use them, and Google Play requires libraries aligned for them.
  target_link_options(aevk_jni PRIVATE -Wl,--exclude-libs,ALL -Wl,--gc-sections -Wl,-z,max-page-size=16384)
endif()

if(AEVK_TOOLS)
  add_executable(aevk-render tools/aevk_render.cpp)
  target_link_libraries(aevk-render PRIVATE aevk)

  # Plans built in C++ for a list of jobs, for the parity check against the TypeScript planner.
  add_executable(aep-plan tools/aep_plan.cpp)
  target_link_libraries(aep-plan PRIVATE aepcore)

  # A comp parsed, planned and rendered end to end, with the time each stage takes.
  add_executable(aep-play tools/aep_play.cpp)
  target_link_libraries(aep-play PRIVATE aepcore aevk)

  enable_testing()
  add_executable(aevk-tests tests/main.cpp tests/plan_test.cpp tests/playback_test.cpp tests/render_test.cpp)
  target_link_libraries(aevk-tests PRIVATE aevk)
  target_compile_definitions(aevk-tests PRIVATE AEVK_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
  add_test(NAME aevk-tests COMMAND aevk-tests)
endif()
