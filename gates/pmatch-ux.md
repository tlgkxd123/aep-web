# Gates: pmatch-ux - the Particle Match window, and export to Trapcode Particular

OWNS: src/ui/ParticleMatchDialog.tsx, src/ui/ParticleMatch*.tsx, src/ui/particle-match.css, src/ui/projectFiles.ts, src/ui/App.tsx, src/ui/icons.tsx, server/local-footage.ts, src/extra/pmatch/**, scripts/check-pmatch-*.ts, tests/particle-match-ui.test.tsx, tests/particular-export.test.ts, tests/particular-layers.test.ts, tests/pmatch-fixtures.ts, gates/pmatch-ux.md, AGENTS.md

Scope: Extra > Particle Match becomes an After Effects-style workbench window (a reference viewer with a scrub strip on which the training window is dragged, staged training progress, a side-by-side preview of the learned particles, a model summary, saving and opening models, drag and drop, a session that survives closing the window) and exports the learned model as Trapcode Particular layers, either into a composition of the open project or as a new After Effects project (.aep) with its soundtrack.

- [x] X0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/pmatch-ux.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=719060d2c4f3745e86ae6433a3d01005b973eea7a20a594b7f5429eb57524091; exit=0; EXPECT=matched; output-sha256=13130e59eb798c273220e7cae99d372f2a15d1c0004a067e39bae85bf28d0376; output-bytes=488; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] G4: loading a sample .aep in the inspector UI still renders its composition, a layer and a transform property
  CHECK: npx vitest run tests/ui.test.tsx
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=5d97d6296cee67cea0f05c2097f1f7f05ee00d17ba68762ed619f24d34fa3cb4; exit=0; EXPECT=matched; output-sha256=272bab60544021ab0d90c16c046106665d42049f08df61fd47f01519ae0a7a36; output-bytes=471; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/
  EVIDENCE: automatic-evidence=v1; definition-sha256=202b6423274a1e776d6ddcc8d133917c5c706a45d1cd69c285f24b4a854abbd3; exit=0; EXPECT=matched; output-sha256=ce1a29010379e4b3b987c0d22d4cf8bbe16aa117350a7e407f4b2812bc927078; output-bytes=1278; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] X1: the Particular settings derived from a model still build and save, and caching the sprite fit per model changes no number: settings for a second comp size from the cached fit equal those a fresh copy of the model computes
  CHECK: npx vitest run tests/particular-layers.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=3f0a7b624e82d70e42449013a6161605597ef7790e492e0346e790fc61d4b8df; exit=0; EXPECT=matched; output-sha256=bc96c6aed93903dad7bd143327cb4cc2eed3d10dab064929bd40428235562d30; output-bytes=1391; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] X2: exporting builds what After Effects needs: a new .aep re-opens with a comp of the chosen name, size, rate and duration, one Particular layer per speed class with Physics Time Factor keyed from the chosen soundtrack, and the soundtrack as a layer with its sound on and its video off that records the file's path; adding to an open project's comp aims the emission for that comp's camera, keys the time factor from one of its audio layers and undoes in one step
  CHECK: npx vitest run tests/particular-export.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=849eb61740235799e98e2029639d7b0e4e1b74f9202e9ddfeda0651ff554818c; exit=0; EXPECT=matched; output-sha256=ad54203c37e36999967bec1c89b2e7f53cd80bb80af2d0d3a6a0a246c4c6ba25; output-bytes=908; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] X3: the window behaves: Analyze & Train stays disabled until a reference video is chosen (button or drop) and the training window is valid; the window follows its fields, its strip handles and B / N at the playhead; Escape does not close it while training; a trained or opened model offers Save Model and Export to Particular; Export adds the layers to the chosen comp of the open project in one undoable step, or saves a new .aep through the file picker; closing and reopening keeps the session
  CHECK: npx vitest run tests/particle-match-ui.test.tsx
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=5017ef75b191020ad6e718f4ee620dad662458dc880a15cafc73fb833713103d; exit=0; EXPECT=matched; output-sha256=23ac20cd40018cdb377372e364a0adbc29f2f4f110a3254f67f70a2f0902c8a9; output-bytes=658; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] X4: in the running app (its own dev server, headless Edge on the high-performance GPU), Extra > Particle Match with the reference video and a trained model plays the learned particles; Export to Particular adds the layers to a new project's comp, after which the Timeline lists the Particular layers and the composition viewer draws particles; Save .aep writes a project that re-opens with the Particular layers and the reference video at its path on disk
  CHECK: node scripts/check-pmatch-export.ts --serve
  EXPECT: PMATCH-EXPORT-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=292cd09a004dfb9e7a24ba81ac4fd27673f46d434486faa3d5b6c76561ea64fc; exit=0; EXPECT=matched; output-sha256=80ca8d651581dc5888d870610ef629654678809943b9d00a5cd87c8e2747fd14; output-bytes=2689; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] X5: After Effects 2025 opens both projects the app wrote (the comp the layers were added to, and the exported .aep) with no missing effect or footage reported, and renders particles in them (a frame of each comp has at least 500 lit pixels)
  CHECK: node scripts/check-pmatch-export.ts --serve --aerender
  EXPECT: PMATCH-EXPORT-AE-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=3e216efa790572a7c964ca9a4c2f2507455ec2c5ac85c4619795a26de1a50d67; exit=0; EXPECT=matched; output-sha256=9cbdb7880419995db5e414fe049ffaedff06d28b3c95a432187db761e8e1d0d5; output-bytes=2997; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] X6: training through the window still works end to end: it analyses a reference window, trains the PyTorch model through the dev server's trainer (which refuses requests without the page's token) and shows the learned particles, with a report naming PyTorch and the GPU it trained on
  CHECK: node scripts/check-pmatch-ui.ts --serve --from 50 --to 62
  EXPECT: PMATCH-UI-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=39751b6a2a09dfb74b4a927991b5f62f19d8f52506c817b94ac46d7709675c5f; exit=0; EXPECT=matched; output-sha256=32b3fa23891dc09cb19553ddcbf0591e07b0af11146daefd6314e0dc3ccd14e4; output-bytes=1881; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] X7: the window's screenshots in every state (empty, reference chosen, training, result, export; 1600 x 1000 and 1100 x 760) were reviewed and every defect found was fixed, and the impeccable detector reports nothing left to fix in the changed UI files
  EVIDENCE: manual review 2026-10-10 of the screenshots `node scripts/check-pmatch-export.ts --serve --training` writes to dist-tools/pmatch/export-ui/ (1-empty, 2-setup, 3-training, 4-result, 5-export-comp, 7-export-file, 8-exported, each at 1600x1000 and at 1100x760 as -narrow, and 6-workspace). Found and fixed: at 1100x760 Save .aep / Add Layers fell below the fold (the export's footer scrolled with its form; it is pinned now, as in the other steps); Save .aep never reported "Saved", and a layer's or audio file's sound stayed "Reading…", under React StrictMode (the export's mounted flag was not set again on the second mount; the UI test now renders in StrictMode and fails without the fix); the setup said training takes "about 3 min" and the training step extrapolated the time left linearly over the progress share (both now use each stage's seconds measured on this machine: "about 35 s" for a 30 s window, "about 20 s left" at 39 %); the active step's looping pulse and the progress bar's width transition kept the compositor drawing and made training 2-4 times slower (removed); the reopened window's reference was black until its video loaded (the check now waits for its picture). `impeccable detect --json` on ParticleMatchDialog.tsx, ParticleMatchExport.tsx, ParticleMatchTimeline.tsx and particle-match.css: [].
