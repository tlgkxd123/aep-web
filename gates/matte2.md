# Gates: track mattes from any layer (AE 23+)

OWNS: src/aep/parse.ts, src/render/composition.ts, src/render/renderer.ts, src/render/layerKeys.ts, src/native/plan.ts, src/edit/layers.ts, src/edit/editor.ts, src/ui/layerRowMenus.ts, src/aep/transform.ts, scripts/fixtures/build_matte2.py, refs/fixtures/matte2.*, tests/track-matte.test.ts, scripts/matte-usage.ts, gates/matte2.md

Scope: the matte layer of AE 23+ files is named by id, so it can sit anywhere in the stack (below, behind other layers, shared, left visible); the Timeline's TrkMat menu picks any layer. A matte naming no layer (0 or a deleted id) leaves the layer unmatted; a matte outside its time span is empty; a matte's own matte is not applied to it. Files before AE 23 use the layer above.

- [ ] G1: The renderer reproduces After Effects 2025 for mattes below the layer, behind other layers, shared, left visible, chained, naming no layer, out of their span, and parented with animated opacity and masks.
  CHECK: node scripts/pixel-report.ts --suite matte2 --require
  EXPECT: PIXELS-PASSED
  CWD: ..

- [ ] G2: The editor picks any layer as the matte, saves it, and refuses a matte loop; mattes naming no layer resolve to none; files before AE 23 use the layer above.
  CHECK: set NO_COLOR=1&& set FORCE_COLOR=0&& npx vitest run tests/track-matte.test.ts
  EXPECT: /Tests\s+\d+ passed/
  CWD: ..

- [ ] G3: The Vulkan engine matches After Effects on the same frames.
  CHECK: node scripts/native-report.ts --suite matte2 --require
  EXPECT: /passing: 12 /
  CWD: ..
