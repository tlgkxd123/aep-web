# Gates: project-ops - AE project operations (New Project / Composition / Folder, Composition Settings, rename, move, delete, duplicate, import, replace footage, save) that are undoable and saved into .aep files After Effects 2025 opens

OWNS: src/edit/templates.ts, src/edit/items.ts, src/edit/footage.ts, src/edit/project.ts, src/edit/editor.ts, src/edit/encode.ts, src/aep/parse.ts, src/media/probe.ts, src/media/localFootage.ts, server/local-footage.ts, src/ui/App.tsx, src/ui/MenuBar.tsx, src/ui/ProjectPanel.tsx, src/ui/Panel.tsx, src/ui/HomeScreen.tsx, src/ui/CompSettingsDialog.tsx, src/ui/Dialog.tsx, src/ui/ImportDialog.tsx, src/ui/projectFiles.ts, src/ui/useProjectOps.tsx, src/ui/projectOps.css, scripts/projectops-*.ts, scripts/check-project-ops-app.ts, scripts/pixel-vs-master.ts, scripts/lib/projectops-layers.ts, scripts/fixtures/projectops_templates.py, scripts/fixtures/build_projectops.ts, scripts/fixtures/projectops_summary.py, refs/fixtures/projectops.*, refs/frames/projectops_*/**, tests/project-ops.test.ts, tests/project-ops-ui.test.tsx, gates/project-ops.md

Scope: the app creates, edits, organizes, imports into and saves projects the way After Effects 2025 does, every operation is one undo step, the saved .aep opens and renders in aerender and parses identically in py-aep, and no frame that passes on master stops passing.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/project-ops.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=e8456ba0923a1911865126f5d0e73ee63f8f349e46a0364a1c72295fca804480; exit=0; EXPECT=matched; output-sha256=5f7dd70acbb6fd1bb5c3b210c9d314235685e78c1f7a8ba71462cfd621865616; output-bytes=163; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\project-ops; path=a39720789bd5/52 entries

- [x] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\project-ops; path=a39720789bd5/52 entries

- [x] G2: the editor operations and the UI flows (menus, shortcuts, dialogs, Project panel rename/drag/delete/import/replace, save, undo/redo of each) pass their tests
  CHECK: npx vitest run tests/project-ops.test.ts tests/project-ops-ui.test.tsx
  EXPECT: /Test Files\s+2 passed \(2\)/
  EVIDENCE: automatic-evidence=v1; definition-sha256=ce71cf24648b6553db11aeecb5a19926399d312d6b8c87a567780647425d12d5; exit=0; EXPECT=matched; output-sha256=02c2110b4b59d99ea10f84f5968b27ed0b9ced1729d4ca1932a6a6c78dbd7249; output-bytes=1192; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\project-ops; path=a39720789bd5/52 entries

- [ ] G3: every test in the repository passes
  CHECK: npx vitest run
  EXPECT: /Test Files\s+\d+ passed \(\d+\)\s*\r?\n\s*Tests\s+\d+ passed/
  EVIDENCE: pending

- [ ] G4: in the real app in headless Edge, a project made through the UI (New Project, New Composition, local-file import with absolute paths, folder, drag, Replace Footage, Duplicate + undo, Save As) is saved, re-parsed, and rendered by aerender at the comp's size
  CHECK: node scripts/check-project-ops-app.ts --aerender
  EXPECT: PROJECT-OPS-APP-PASSED
  EVIDENCE: pending

- [x] G5: py-aep reads the editor-built fixture and the UI-saved project with the same items and layers as aep-web, and both write back byte-identically
  CHECK: node scripts/projectops-check.ts refs/fixtures/projectops.aep refs/probe-projectops-ui.aep
  EXPECT: py-aep and aep-web agree
  EVIDENCE: automatic-evidence=v1; definition-sha256=4726ffd75fbd0b24ebe44b83b183eda437357d2389f7fa51c87aac705e15291d; exit=0; EXPECT=matched; output-sha256=f2da614b7e0ccf1fe994e09de7909f87710c8c5faf635232fff1161492065164; output-bytes=157; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\project-ops; path=a39720789bd5/52 entries

- [x] G6: aerender's frames of the editor-built projectops fixture match the browser renderer
  CHECK: node scripts/pixel-report.ts --suite projectops --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=1b5559456796692a16aab0bee85d82a2bac57cef49384644e2b2aeaf7ea0423d; exit=0; EXPECT=matched; output-sha256=575230c7f9d600a3bfa0f5a8981d28b270508fef72bfa1d319c7acde0f097b4d; output-bytes=1257; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\project-ops; path=a39720789bd5/52 entries

- [x] G7: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/
  EVIDENCE: automatic-evidence=v1; definition-sha256=202b6423274a1e776d6ddcc8d133917c5c706a45d1cd69c285f24b4a854abbd3; exit=0; EXPECT=matched; output-sha256=262992eb1b1fd47399986bb556da36a03f6e5f9e4cfcd9f18c505b5eba1b8986; output-bytes=684; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\project-ops; path=a39720789bd5/52 entries

- [x] G8: every frame of the full pixel regression that passes on master still passes on this branch
  CHECK: node scripts/pixel-vs-master.ts master
  EXPECT: NO-PIXEL-REGRESSION-VS-MASTER
  EVIDENCE: automatic-evidence=v1; definition-sha256=a9f7ebda697e7281107e993b719b7d7c695ff4a0ca200324a7fd35ffe3a51785; exit=0; EXPECT=matched; output-sha256=44f03b9be36ef3e5171783a1edc9deec429b7b408d07da721b1b2071c718ef0f; output-bytes=114; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\project-ops; path=a39720789bd5/52 entries

- [x] G9: the impeccable detector finds no anti-patterns in the new and changed UI
  CHECK: C:/Users/schxm/.claude/skills/impeccable/scripts/impeccable.cmd detect --json src/ui/CompSettingsDialog.tsx src/ui/Dialog.tsx src/ui/ImportDialog.tsx src/ui/projectOps.css src/ui/ProjectPanel.tsx src/ui/MenuBar.tsx src/ui/Panel.tsx
  EXPECT: /^\[\]\s*$/m
  EVIDENCE: automatic-evidence=v1; definition-sha256=210cad60e7adb341c231defce1be914884eb4b22211675322c928b32fc20f6fd; exit=0; EXPECT=matched; output-sha256=37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570; output-bytes=3; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\project-ops; path=a39720789bd5/52 entries

- [x] G10: the dialogs, submenus and Project panel states look like the After Effects Default workspace they sit in
  EVIDENCE: manual review 2026-10-06 of the screenshots G4 writes (refs/probe-projectops-dialog.png, -import.png, -workspace.png, gitignored) at 1600x1000 against the incumbent workspace styling: Composition Settings follows AE's layout (name row, Basic/Advanced/3D Renderer tabs with the latter two disabled, right-aligned labels, Lock Aspect Ratio line, frame aspect and "0.2 MB per 8bpc frame" readouts, "is 0:00:02:00 Base 24" timecode echoes, background swatch with eyedropper, Cancel/OK pill buttons) in the panel greys and accent blue; Import File is a modal of the same window chrome with path field, Up button, size column, multi-selection and "Import As: Footage"; the Project panel shows a yellow-labelled folder with the moved footage indented under it and the focus ring the other panels use. The impeccable detector (G9) reports no anti-patterns. Not compared pixel-for-pixel with an AE screenshot; no Adobe assets are used.
