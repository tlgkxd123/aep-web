# Gates: quickstart - Quick Start templates (Trap Nation 2018, Trap Nation 2020) built around the user's song

OWNS: src/quickstart/**, src/edit/masks.ts, src/edit/data/mask-template.json, scripts/export-mask-template.ts, scripts/quickstart-sample.ts, src/ui/QuickStart.tsx, src/ui/quickStart.css, src/ui/HomeScreen.tsx, tests/quick-start.test.ts, tests/quick-start-ui.test.tsx, tests/masks.test.ts, tests/effect-names.test.ts, gates/quickstart.md

Scope: the Home screen's Quick Start cards and File > New > New Project from Template build a 1920×1080 project as long as the chosen song (an audio file or a movie with sound), with an optional background and logo: stacked Audio Spectrums of the song bent into a ring (a half-circle mask in 2018, Polar Coordinates in 2020), mirrored, around the logo in a circle, over Trapcode Particular particles and the blurred background; a Bass slider keyed from the song's low end drives the bounce, the shake and the particles' speed through expressions. The project opens unsaved and without undo history, and After Effects 2025 opens and renders it.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/quickstart.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] Q1: both templates save and re-read with their layers, parenting, effects, masks, layer and mask references, Bass keys within 0.5 of the per-frame bass level, and expressions that evaluate; masks the editor writes read back as written; library effects carry their parameters' own names
  CHECK: npx vitest run tests/quick-start.test.ts tests/masks.test.ts tests/effect-names.test.ts
  EXPECT: /Test Files\s+3 passed/

- [ ] Q2: in the app, a Home screen card and File > New > New Project from Template open the window, refuse a song without sound in it, ask to save the open project's changes, and open the built project
  CHECK: npx vitest run tests/quick-start-ui.test.tsx tests/project-ops-ui.test.tsx
  EXPECT: /Test Files\s+2 passed/

- [ ] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/

- [ ] Q3: After Effects 2025 opens both templates' projects and renders a frame of each without an error or a missing effect, the ring's white bars showing around the circle
  CHECK: node scripts/quickstart-sample.ts --aerender
  EXPECT: QUICKSTART-AE-PASSED
