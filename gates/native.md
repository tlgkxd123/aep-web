# Gates: native - the C++ Vulkan engine and the Android app's use of it

OWNS: native/**, src/native/**, src/render/composition.ts, src/playback/previewRenderer.ts, scripts/native-report.ts, scripts/native-shaders.ts, scripts/lib/native.ts, scripts/lib/pixel-criterion.ts, android/app/src/main/java/com/zionschxma/aev3/NativeEngine.java, android/app/src/main/java/com/zionschxma/aev3/NativeEnginePlugin.java, tests/native-plan.test.ts, tests/native-engine.test.ts, gates/native.md

Scope: the page builds a frame plan (src/native/plan.ts) from the project model, the evaluator and the expression engine; the C++ engine (native/) composites it with Vulkan as the WebGL renderer does: solids, nested comps, images, shape layers (fills with either rule, strokes with every cap and join, linear and radial gradients, after groups, trim paths and repeaters), masks (all modes, feather, expansion), track mattes, blend modes, adjustment layers without effects, 2D and 3D placement with cameras; and playback's timing and RAM cache. In the Android app, Composition > Preview Renderer > Vulkan renders playback's frames with it; content it cannot render yet (text layers, footage, effects, dashed strokes) stays the WebGL renderer's.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/native.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] N1: plans hold what the fixtures render, their binary form matches the one the C++ tests read, the embedded SPIR-V is compiled from the current shaders, and playback renders natively only what the engine supports, falling back to WebGL on refusals and failures
  CHECK: npx vitest run tests/native-plan.test.ts tests/native-engine.test.ts
  EXPECT: /Test Files\s+2 passed/

- [ ] N2: the engine builds without warnings and its tests pass on the machine's Vulkan device (plan decoding, damaged plans, playback timing, the frame cache, compositing, masks, mattes, nested comps, shape fills, strokes and gradients, the player)
  CHECK: cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build --config Release && ctest --test-dir native/build -C Release --output-on-failure
  EXPECT: 100% tests passed

- [ ] N3: every core fixture frame, shape layers included, renders through the Vulkan engine as aerender rendered it (pixel criterion; mask_feather@0 within the accepted approximation)
  CHECK: node scripts/native-report.ts --suite fixtures --require --min 68
  EXPECT: NATIVE-PIXELS-PASSED

- [ ] N4: the footage, layerops, projectops and adjust frames the engine renders match their aerender references
  CHECK: node scripts/native-report.ts --suite footage --require --min 61 && node scripts/native-report.ts --suite layerops --require --min 9 && node scripts/native-report.ts --suite projectops --require --min 3 && node scripts/native-report.ts --suite adjust --require --min 1 && echo NATIVE-SUITES-PASSED
  EXPECT: NATIVE-SUITES-PASSED

- [ ] N5: the expr frames the engine renders match their aerender references (needs the expr reference frames)
  CHECK: node scripts/native-report.ts --suite expr --require --min 56
  EXPECT: NATIVE-PIXELS-PASSED

- [ ] N6: the Android app builds with the engine for arm64-v8a, armeabi-v7a and x86_64
  CHECK: npx vite build && npx cap sync android && cd android && ./gradlew :app:assembleDebug && unzip -l app/build/outputs/apk/debug/app-debug.apk | grep -c "lib/.*/libaevk_jni.so"
  EXPECT: /^3$/m

- [ ] N7: the WebGL renderer, which now shares its draw order, matte rules and pixel criterion with the native path, still matches every core fixture frame
  CHECK: node scripts/pixel-report.ts --suite fixtures --require
  EXPECT: PIXELS-PASSED
