# The native Vulkan engine (aevk): the compositor and playback core the Android app runs, and a headless renderer
# for checking it against After Effects' reference frames (scripts/reports/native-report.ts).
#
#   cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build && ctest --test-dir native/build
#
# Android builds it through android/app/build.gradle (externalNativeBuild), with the NDK's Vulkan headers.
#
# aepcore (native/core) is the project side in C++: it parses .aep files, evaluates properties and builds the plans the
# engine draws, with no GPU dependency (docs/native-port.md, milestone M1). aepplayer (native/app) plays a project in a
# native window on both, for the desktop viewer (aep-viewer) and the Android app (milestone M2).
cmake_minimum_required(VERSION 3.18)
project(aevk LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

option(AEVK_TOOLS "Build the headless renderer and the tests" ON)

add_library(aevk STATIC
  src/capi.cpp
  src/effects/audio_spectrum.cpp
  src/effects/box_blur.cpp
  src/effects/channel.cpp
  src/effects/deep_glow.cpp
  src/effects/generate.cpp
  src/effects/registry.cpp
  src/effects/simple.cpp
  src/effects/stock.cpp
  src/effects/stylize.cpp
  src/engine.cpp
  src/fx.cpp
  src/geometry.cpp
  src/media.cpp
  src/plan.cpp
  src/playback.cpp
  src/spectrum.cpp
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
  # Desktop windows: Win32 always, xcb on Linux when its headers are installed (libxcb1-dev).
  set(AEVK_DESKTOP_WINDOW OFF)
  if(WIN32)
    set(AEVK_DESKTOP_WINDOW ON)
  elseif(UNIX AND NOT APPLE)
    find_path(AEVK_XCB_INCLUDE_DIR xcb/xcb.h)
    find_library(AEVK_XCB_LIBRARY xcb)
    if(AEVK_XCB_INCLUDE_DIR AND AEVK_XCB_LIBRARY)
      target_compile_definitions(aevk PRIVATE AEVK_XCB=1)
      target_include_directories(aevk PRIVATE ${AEVK_XCB_INCLUDE_DIR})
      set(AEVK_DESKTOP_WINDOW ON)
    endif()
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

# Expressions run the app's own expression engine (native/core/expressions/bundle.js, built from src/ by
# scripts/native/build-expressions.ts) in an embedded QuickJS-ng (MIT), fetched at configure time.
option(AEP_EXPRESSIONS "Evaluate expressions in the native core (embeds QuickJS-ng)" OFF)
if(AEP_EXPRESSIONS)
  include(FetchContent)
  FetchContent_Declare(quickjs
    GIT_REPOSITORY https://github.com/quickjs-ng/quickjs.git
    GIT_TAG d7215b0ad3fc2c562e8317fd9bca058fd4863804 # v0.18.0
  )
  FetchContent_GetProperties(quickjs)
  if(NOT quickjs_POPULATED)
    FetchContent_Populate(quickjs)
    set(QJS_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
    add_subdirectory(${quickjs_SOURCE_DIR} ${quickjs_BINARY_DIR} EXCLUDE_FROM_ALL)
  endif()
  set(AEP_BUNDLE ${CMAKE_CURRENT_SOURCE_DIR}/core/expressions/bundle.js)
  set(AEP_BUNDLE_CPP ${CMAKE_CURRENT_BINARY_DIR}/expression_bundle.cpp)
  add_custom_command(
    OUTPUT ${AEP_BUNDLE_CPP}
    COMMAND ${CMAKE_COMMAND} -DINPUT=${AEP_BUNDLE} -DOUTPUT=${AEP_BUNDLE_CPP} -DNAME=g_ExpressionBundle
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed.cmake
    DEPENDS ${AEP_BUNDLE} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed.cmake
    COMMENT "Embedding the expression script"
  )
  target_sources(aepcore PRIVATE core/expressions.cpp ${AEP_BUNDLE_CPP})
  target_link_libraries(aepcore PUBLIC qjs)
  target_compile_definitions(aepcore PUBLIC AEP_EXPRESSIONS=1)
endif()
if(MSVC)
  target_compile_options(aepcore PRIVATE /W4)
else()
  target_compile_options(aepcore PRIVATE -Wall -Wextra -Wno-missing-field-initializers)
endif()

# A project playing in a native window (native/app): the shared loop of the desktop viewer and the Android player
# (docs/native-port.md, milestone M2).
add_library(aepplayer STATIC app/session.cpp)
target_include_directories(aepplayer PUBLIC app)
target_link_libraries(aepplayer PUBLIC aepcore aevk)
if(MSVC)
  target_compile_options(aepplayer PRIVATE /W4)
else()
  target_compile_options(aepplayer PRIVATE -Wall -Wextra -Wno-missing-field-initializers)
endif()

# The app's interface (native/ui): one Dear ImGui (MIT) interface for the desktop app and the Android app, drawn by the
# engine over the comp (Engine::presentUi). Dear ImGui is fetched at configure time.
option(AEP_UI "Build the app's interface (fetches Dear ImGui)" ON)
if(AEP_UI)
  include(FetchContent)
  FetchContent_Declare(imgui
    GIT_REPOSITORY https://github.com/ocornut/imgui.git
    GIT_TAG f5befd2d29e66809cd1110a152e375a7f1981f06 # v1.91.9b
  )
  FetchContent_GetProperties(imgui)
  if(NOT imgui_POPULATED)
    FetchContent_Populate(imgui)
  endif()
  add_library(imgui STATIC
    ${imgui_SOURCE_DIR}/imgui.cpp
    ${imgui_SOURCE_DIR}/imgui_draw.cpp
    ${imgui_SOURCE_DIR}/imgui_tables.cpp
    ${imgui_SOURCE_DIR}/imgui_widgets.cpp
  )
  # ui/aep_imconfig.h: 32-bit indices (a long timeline draws more than 65536 vertices in one window), no obsolete API.
  target_include_directories(imgui PUBLIC ${imgui_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/ui)
  target_compile_definitions(imgui PUBLIC IMGUI_USER_CONFIG="aep_imconfig.h")
  # The interface font: Roboto Medium (Apache 2.0), which Dear ImGui ships in misc/fonts.
  set(AEP_UI_FONT ${imgui_SOURCE_DIR}/misc/fonts/Roboto-Medium.ttf)
  set(AEP_UI_FONT_CPP ${CMAKE_CURRENT_BINARY_DIR}/ui_font.cpp)
  add_custom_command(
    OUTPUT ${AEP_UI_FONT_CPP}
    COMMAND ${CMAKE_COMMAND} -DINPUT=${AEP_UI_FONT} -DOUTPUT=${AEP_UI_FONT_CPP} -DNAME=g_UiFont
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed.cmake
    DEPENDS ${AEP_UI_FONT} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed.cmake
    COMMENT "Embedding the interface font"
  )
  add_library(aepui STATIC ui/app.cpp ui/files.cpp ui/render.cpp ${AEP_UI_FONT_CPP})
  target_include_directories(aepui PUBLIC ui)
  target_link_libraries(aepui PUBLIC aepplayer imgui)
  if(MSVC)
    target_compile_options(aepui PRIVATE /W4)
  else()
    target_compile_options(aepui PRIVATE -Wall -Wextra -Wno-missing-field-initializers)
  endif()
endif()

if(ANDROID)
  add_library(aevk_jni SHARED android/aevk_jni.cpp android/aep_player_jni.cpp)
  target_link_libraries(aevk_jni PRIVATE aevk aepplayer)
  set_target_properties(aevk aepcore aepplayer aevk_jni PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
  # The app's native screen (NativeAppActivity): the interface in native/ui on the display's frame clock.
  if(AEP_UI)
    target_sources(aevk_jni PRIVATE android/aep_app_jni.cpp)
    target_link_libraries(aevk_jni PRIVATE aepui)
    set_target_properties(aepui imgui PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
  endif()
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

  # The desktop player: a window that plays a project's comps on the C++ core.
  if(AEVK_DESKTOP_WINDOW)
    add_executable(aep-viewer tools/aep_viewer.cpp)
    target_link_libraries(aep-viewer PRIVATE aepplayer)
    if(WIN32)
      set_target_properties(aep-viewer PROPERTIES WIN32_EXECUTABLE OFF)
    else()
      target_include_directories(aep-viewer PRIVATE ${AEVK_XCB_INCLUDE_DIR})
      target_link_libraries(aep-viewer PRIVATE ${AEVK_XCB_LIBRARY})
    endif()
  endif()

  # The desktop app: the interface in native/ui in a window, on Linux and Windows.
  if(AEVK_DESKTOP_WINDOW AND AEP_UI)
    add_executable(aep-app tools/aep_app.cpp)
    target_link_libraries(aep-app PRIVATE aepui)
    if(WIN32)
      set_target_properties(aep-app PROPERTIES WIN32_EXECUTABLE OFF)
    else()
      target_include_directories(aep-app PRIVATE ${AEVK_XCB_INCLUDE_DIR})
      target_link_libraries(aep-app PRIVATE ${AEVK_XCB_LIBRARY})
    endif()
    if(MSVC)
      target_compile_options(aep-app PRIVATE /W4)
    else()
      target_compile_options(aep-app PRIVATE -Wall -Wextra -Wno-missing-field-initializers)
    endif()
  endif()

  enable_testing()
  add_executable(aevk-tests tests/main.cpp tests/plan_test.cpp tests/media_test.cpp tests/playback_test.cpp tests/render_test.cpp)
  target_link_libraries(aevk-tests PRIVATE aevk)
  target_compile_definitions(aevk-tests PRIVATE AEVK_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
  add_test(NAME aevk-tests COMMAND aevk-tests)
endif()
