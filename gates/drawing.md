# Gates: masks and shapes, drawn and edited

OWNS: src/edit/masks.ts, src/edit/paths.ts, src/edit/shapes.ts, src/edit/vectorProps.ts, src/edit/data/shape-template.json, src/ui/drawTools.ts, src/ui/pathEditing.ts, src/ui/PathOverlay.tsx, src/ui/maskCommands.ts, src/ui/drawing.css, tests/masks.test.ts, tests/shapes-editing.test.ts, scripts/ae-shape-donors.ts, scripts/export-shape-template.ts, scripts/find-shape-donors.ts, scripts/property-tree.ts, scripts/ae-dump-props.ts, scripts/ours-pixel.ts, scripts/check-drawing.ts, scripts/fixtures/build_drawing.ts, refs/fixtures/donors/ae2025-shapes.aep, refs/fixtures/drawing.*, refs/frames/drawing_*/**, gates/drawing.md

Scope: masks and shape layers created and edited the way After Effects 2025 does it. The Rectangle, Rounded Rectangle, Ellipse, Polygon and Star tools and the Pen draw masks on the selected layer, shapes in the selected shape layer (or masks, with Tool Creates Mask) or new shape layers, with the Tools panel's Fill, Stroke and stroke width. The Selection, Add Vertex, Delete Vertex and Convert Vertex tools, the arrow keys and Delete edit mask and shape paths in the viewer; path values are written static or keyframed (one shap per keyframe), and keyframes added, moved and removed keep their paths. The Timeline's mask Mode popup, Inverted switch and mask and shape context menus, Layer > Mask, the Contents Add menu, and popups for shape properties work; mask and shape properties After Effects left out at their defaults are written from donors After Effects itself saved (scripts/ae-shape-donors.ts) on first edit. Shape layers are picked and boxed by what they draw. Shared files edited additively: src/edit/editor.ts, src/edit/stored-property.ts, src/edit/transform-ops.ts, src/render/shapes.ts, src/ui/App.tsx, src/ui/CompositionPanel.tsx, src/ui/TimelinePanel.tsx, src/ui/Toolbar.tsx, src/ui/MenuBar.tsx, src/ui/EffectValue.tsx, src/ui/values.tsx, src/ui/properties.ts, src/ui/viewerOverlays.tsx, src/ui/icons.tsx.

The whole-suite gate leaves out tests/system-native.test.tsx, whose "a project another app shares opens from the copy the plugin made" case fails on master without these changes as well.

- [ ] G0: this ledger passes the unlazy oracle lint
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/drawing.md
  EXPECT: LINT OK

- [x] G1: the project type-checks
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web\gates; path=92add6e87031/53 entries

- [ ] G2: editor tests pass: masks added, switched (mode, inverted, locked, colour, falloff), renamed, duplicated and deleted; Feather, Opacity and Expansion written on first edit; static and keyframed paths set, keyed, moved and removed; shape layers and Rectangle, Ellipse, Star, Polygon and Path groups with every property stored; groups renamed, duplicated and deleted; all read back from the saved file
  CHECK: npx vitest run tests/masks.test.ts tests/shapes-editing.test.ts
  EXPECT: /Test Files\s+\d+ passed \(\d+\)\s/

- [ ] G3: the rest of the vitest suite still passes
  CHECK: npx vitest run --exclude "**/system-native.test.tsx" --exclude "dist-tools/**"
  EXPECT: /Test Files\s+\d+ passed \(\d+\)\s/

- [ ] G4: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in \d/

- [ ] G5: masks and shapes the editor wrote (mask modes, feather, opacity and expansion, mask commands, an animated mask path, every kind of shape tool shape, edited shape properties and an animated shape path) open in After Effects 2025 and render as the browser renders them
  CHECK: node scripts/pixel-report.ts --suite drawing --require
  EXPECT: PIXELS-PASSED

- [ ] G6: the tools draw and edit through the running app in Edge: masks on a selected solid, vertex drag with undo, arrow nudge, Delete on a vertex, Add and Delete Vertex, the Timeline's Mode popup and Inverted switch, Star tool and Pen shape layers picked by what they draw, a Rectangle group on a selected shape layer, and File > Save writing all of it
  CHECK: node scripts/check-drawing.ts --serve
  EXPECT: DRAWING-UI-PASSED

- [ ] G7: layer handle scaling (now measured on a layer box) still matches After Effects in the layer operations suite
  CHECK: node scripts/pixel-report.ts --suite layerops --require --no-build
  EXPECT: PIXELS-PASSED
