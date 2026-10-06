# Gates: layer operations and direct manipulation

OWNS: src/edit/layers.ts, src/edit/layer-items.ts, src/edit/layer-templates.ts, src/edit/transform-ops.ts, src/edit/data/layer-templates.json, src/ui/editing.tsx, src/ui/layerCommands.ts, src/ui/SolidSettings.tsx, src/ui/TransformValue.tsx, src/ui/layer-ops.css, tests/layer-ops.test.ts, tests/layer-ops-ui.test.tsx, tests/data/layer-templates-cases.json, tests/data/transform-props-cases.json, scripts/build-layerops.ts, scripts/check-layerops-regression.ts, scripts/shot-layer-ops.ts, scripts/diff-layer-cases.ts, scripts/dump-chunks.ts, scripts/list-layers.ts, scripts/probe-profile.ts, scripts/fixtures/build_layerops.py, scripts/fixtures/export_layer_templates.py, scripts/fixtures/probe_layer_kinds.py, scripts/fixtures/probe_layers.py, refs/fixtures/layerops.*, refs/frames/layerops_*/**, gates/layer-ops.md

Scope: the After Effects layer operations (new solid/null/shape/adjustment layers and item layers from project drags, delete, duplicate, rename, restack, Layer > Transform) and Composition-panel direct manipulation (move, handle scale, rotate, Pan Behind, nudge) plus scrubbable Transform values, all undoable through the editor and written into .aep files that After Effects 2025 renders identically to the browser (suite layerops). Shared files edited additively: src/edit/editor.ts, src/ui/App.tsx, src/ui/CompositionPanel.tsx, src/ui/TimelinePanel.tsx, src/ui/MenuBar.tsx, src/ui/Toolbar.tsx, src/ui/ProjectPanel.tsx, src/ui/icons.tsx.

- [x] G0: this ledger passes the unlazy oracle lint
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/layer-ops.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=0bec012c7c2bf70aac7242e4ea4630e06e8f75aa00e253a0a9b182f947146ba9; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries

- [x] G1: the project type-checks with the layer operations in
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries

- [x] G2: editing-core unit tests pass (py-aep chunk templates byte-match AE-saved layers, new/delete/duplicate/arrange, Layer > Transform math on parented/3D/rotated layers, drag math through viewer zoom and parent matrices, undo/redo, write-and-reparse round trip)
  CHECK: npx vitest run tests/layer-ops.test.ts
  EXPECT: /Test Files\s+1 passed \(1\)/
  EVIDENCE: automatic-evidence=v1; definition-sha256=e00e85cbe3fb805e6e2b8e8f9075b339693a1f61d6d9a1068493f1e75e67ec83; exit=0; EXPECT=matched; output-sha256=63fa0d85d122e49d13ddc30f23d40fc072fd075d6d1978c551df98f383ff6ceb; output-bytes=483; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries

- [x] G3: UI tests drive every operation through the real panels (menus and shortcuts, Solid Settings with Make Comp Size, rename, Timeline drag reorder and item drop, Composition-panel item drop, move/handles/rotate/Pan Behind/nudge with one undo step per drag, Fit shortcuts, Scale link scrub, typed Opacity, stopwatch keyframe) and the existing UI suite still passes
  CHECK: npx vitest run tests/layer-ops-ui.test.tsx tests/ui.test.tsx
  EXPECT: /Test Files\s+2 passed \(2\)/
  EVIDENCE: automatic-evidence=v1; definition-sha256=0c6219dca4933912b69439212d469520fff8127ebdebea17bc767a931aac9290; exit=0; EXPECT=matched; output-sha256=5ce73d2ec51fe4299e737a6863b6709d380d9ea79eb63c0aae2e3850d8aedf2c; output-bytes=1563; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries

- [x] G4: the whole vitest suite passes
  CHECK: npx vitest run
  EXPECT: /Test Files\s+\d+ passed \(\d+\)\s/
  EVIDENCE: automatic-evidence=v1; definition-sha256=3de7a7d1fe25e2794a7581015ff0addacf0df34e22e7e07fbcd42a9e08b44b85; exit=0; EXPECT=matched; output-sha256=4b2546fa346d06a56de2fb86addbcc9ac9ae0424a61bccda044a604935d354d9; output-bytes=1984; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries

- [x] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in \d/
  EVIDENCE: automatic-evidence=v1; definition-sha256=0e670b93e0c770a39ce7323a4eb0b5121fbbb4315607825e94dd589babcdc211; exit=0; EXPECT=matched; output-sha256=54e5ec6ce1b567b4233c83f6dccdc1354fe30ae8d693d77fdf5671543322928e; output-bytes=684; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries

- [x] G6: new layers written by the editor (comp-size and small solids, null object with a solid parented to it and rotated, shape layer, adjustment layer, project items dropped at a point, Shift handle shrink) render in After Effects 2025 identically to the browser
  CHECK: node scripts/pixel-report.ts --suite layerops --only layerops_new --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=8f18562030a82a5414410f94f83f84ae41d9f731d41086fcff3998b2fbe486eb; exit=0; EXPECT=matched; output-sha256=192552870d36360900eeb29d65e20f8d7a21c277b22eeea1ae89ee6e81c5d7c3; output-bytes=354; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries

- [x] G7: Fit to Comp (after a rotate and Reset), Fit to Comp Width and Fit to Comp Height on sources of other sizes and aspect ratios, plus a corner handle drag, match After Effects' renders
  CHECK: node scripts/pixel-report.ts --suite layerops --only layerops_fit,layerops_fit_width,layerops_fit_height --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=bf903215b9b424b4e90cf893c28a890e8cfcb9fb1b44ad67809801c4b3546b15; exit=0; EXPECT=matched; output-sha256=4846d7938b1930f43701b4aa7cb8cd0a338141e23914c669cdbe35be91875cca; output-bytes=534; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries

- [x] G8: coalesced Selection-tool moves, a Shift-snapped Rotation-tool drag, side and corner handle scaling with and without Shift, a Shift-constrained move that keys a stopwatch-on Position, arrow nudges, and moves/fits/handle drags through rotated and scaled parents match After Effects' renders at both sampled times
  CHECK: node scripts/pixel-report.ts --suite layerops --only layerops_move,layerops_parent --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=50af08b829af7f418c9180dd8cfb3e3627c8412869d05fe3f9d8ea9bf935cc3d; exit=0; EXPECT=matched; output-sha256=29dee80854d88786f942704dd29c998b28e3414c464fe9dc5f92982f2e270cb6; output-bytes=534; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries

- [x] G9: Pan Behind with and without Alt on rotated layers, Center Anchor Point, Center In View, Flip Horizontal/Vertical and Send to Back match After Effects' renders
  CHECK: node scripts/pixel-report.ts --suite layerops --only layerops_anchor --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ea38eb7c180ddd34e099c8c6df95f7be5ce204c4f42695fcae8efe47adcb2953; exit=0; EXPECT=matched; output-sha256=07ce7aa1c708373f2cc8a7aaf332c4c10173ca2918bb7a1afaf4854e5a42bd3b; output-bytes=354; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries

- [x] G10: duplicate, delete (including a parent, keeping the child's transform) and Bring to Front / Bring Forward / Send to Back stacking match After Effects' renders
  CHECK: node scripts/pixel-report.ts --suite layerops --only layerops_stack --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=a1e5847009a4031cceafccd734abec663bc12d1419982c6065d0c3cf97bef65d; exit=0; EXPECT=matched; output-sha256=c357098cf1959068327d5125181cffe419b25c7e9b7fb610ffbe34b05af91949; output-bytes=354; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries

- [x] G11: no frame that passes on master regresses: every renderer, harness and pixel-tool input is byte-identical to master, refs differ only in the layerops suite, all layerops frames pass, and the full report's remaining failures (footage_tiff and footage_tiff_assoc on master c251e9b) therefore fail identically on master
  CHECK: node scripts/check-layerops-regression.ts master
  EXPECT: NO-REGRESSION-VS-MASTER OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=03dba16a62ec3f337a1725d5c7c5e4bb68b93e265e901118fb1b197a42dba9cb; exit=0; EXPECT=matched; output-sha256=156023636a9ceceed607e894cb2772b33eb79837f43bdfbf96667f95f5e1958e; output-bytes=332; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\layer-ops; path=a39720789bd5/52 entries
