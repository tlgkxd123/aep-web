# Gates: library - an Effects & Presets library of the effects the renderer draws, written as After Effects writes them

OWNS: scripts/export-effect-library.ts, scripts/lib/effect-templates.ts, scripts/export-effect-templates.ts, scripts/effect-donor-scan.ts, scripts/check-effect-library.ts, scripts/approximations-report.ts, scripts/lib/suites.ts, scripts/fixtures/build_roundtrip.py, scripts/fixtures/apply_roundtrip.ts, scripts/render-refs.ts, src/edit/effectLibrary.ts, src/edit/data/effect-library.json, src/ui/EffectsPresetsPanel.tsx, src/ui/MenuBar.tsx, src/ui/App.tsx, src/ui/TimelinePanel.tsx, src/ui/CompositionPanel.tsx, src/ui/contextMenus.ts, src/ui/editing.tsx, src/ui/styles.css, src/render/registry.ts, tests/effect-library.test.tsx, refs/fixtures/roundtrip.*, refs/frames/roundtrip_*/**, gates/library.md

Scope: every effect this codebase renders whose definition an After Effects-saved project (or an aerender-rendered fixture) holds becomes a library template with its display name and Effects & Presets category; the Effects & Presets panel, the Effect menu and drag and drop apply them to layers through the editor; a project the editor writes with each library effect (defaults and non-default values) opens in After Effects 2025, which renders it as the app does. Effects whose renderers are not pixel-verified on their own (Deep Glow, and the Particular and Sound Keys look-alikes) are still written, opened and rendered by After Effects, and measured outside the pixel gate (refs/fixtures/roundtrip.approximations.json), as the fxextra suite does.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/library.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] G4: the inspector UI smoke test and the effect library UI test pass
  CHECK: npx vitest run tests/ui.test.tsx tests/effect-library.test.tsx
  EXPECT: /Test Files\s+2 passed/

- [ ] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/

- [ ] L1: the committed library is what the export produces now from the registered renderers and the donors; it holds every renderable effect a donor defines (the others are listed with a reason), and each template, applied through the editor to a new project, saves and re-parses as that effect with its parameters
  CHECK: node scripts/check-effect-library.ts
  EXPECT: /EFFECT-LIBRARY-CURRENT: \d+ effects with templates/

- [ ] L2: in the app, double-clicking an effect in Effects & Presets (and pressing Enter, and choosing it in the Effect menu, and dropping it on a Timeline layer row) applies it to the layer as one undoable step; it shows in Effect Controls, and a saved and reopened project still has it
  CHECK: npx vitest run tests/effect-library.test.tsx
  EXPECT: /Test Files\s+1 passed/

- [ ] L3: After Effects 2025 opens the editor-saved roundtrip.aep (these exact bytes) and aerender renders every one of its comps without reporting an unavailable effect or an error
  CHECK: node scripts/render-refs.ts --suite roundtrip --strict
  EXPECT: ALL-COMPS-RENDERED

- [ ] L4: every library effect with a pixel-verified renderer, applied through the editor with defaults and with non-default values, renders in the app as After Effects renders the saved file (pixel criterion; accepted approximations within a mean error of 1/255)
  CHECK: node scripts/pixel-report.ts --suite roundtrip --require
  EXPECT: PIXELS-PASSED

- [ ] L6: the round-trip comps of effects whose renderers only approximate After Effects (Deep Glow, Particular, Sound Keys) have After Effects references for every listed frame and are measured against them
  CHECK: node scripts/approximations-report.ts roundtrip
  EXPECT: APPROXIMATIONS-MEASURED

- [ ] L5: nothing regressed: the core pixel suite passes, and the editing, effect, UI and Particle Match template tests pass
  CHECK: node scripts/pixel-report.ts --suite fixtures --require && npx vitest run tests/effects-editing.test.ts tests/effects-ui.test.tsx tests/ui.test.tsx tests/project-ops-ui.test.tsx tests/layer-ops-ui.test.tsx tests/particular-layers.test.ts && echo NO-REGRESSION
  EXPECT: NO-REGRESSION
