# Gates: viz - Avee Player templates (.viz) opened as After Effects projects

OWNS: src/viz/**, src/ui/VizDialog.tsx, scripts/viz-sample.ts, scripts/viz-schema.ts, scripts/check-viz-shaders.ts, docs/viz-format.md, tests/viz.test.ts, tests/viz-export.test.ts, tests/vizTemplate.ts, gates/viz.md

Scope: File > Open, drag and drop, the mobile file picker (the template's files picked together) and Android's Open with open an Avee Player template, as a .viz archive or an unpacked folder, ask for a song, and convert it into a new unsaved project built through the editor: each composition the template shows becomes a comp, images become footage, Bars become Audio Spectrums of the song, effects become their After Effects counterparts or are drawn as they are, and a Beat slider keyed from the song's bass drives what follows the beat. What has no counterpart is listed in a report. After Effects 2025 opens and renders the converted project from the layout Save As Zip with Footage writes, finding the footage through the relative links alone.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/viz.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] V1: scene.json and the .viz container read as Avee Player writes them; an authored template converts to comps, layers, footage, Audio Spectrums, Mirror, track mattes, Fill adjustment layers and beat expressions that evaluate, and reads back from the saved file; the templates in Downloads convert with nothing failing
  CHECK: npx vitest run tests/viz.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] V2: in the app, a dropped .viz opens the song dialog, converts into a new project whose images are located, and shows the report; File > Export > Avee Player Template writes the comp back as a .viz holding its picture
  CHECK: npx vitest run tests/project-ops-ui.test.tsx
  EXPECT: /Test Files\s+1 passed/

- [ ] V5: a converted template exports back element for element (its ring's whole frequency range, mirror, masks, measures, every schema property, unique ids) and converts again; a Quick Start project exports its stacked rings, mirror, beat measures, particles and its gradient and brightness as shaders; effects Avee has no element for are Custom Shaders in stack order with their settings as variables, an effect with no shader is reported, expression controls are not, every comp of the project is in the template, and converting it back restores the effects themselves
  CHECK: npx vitest run tests/viz-export.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] V7: every shader the exporter writes (each effect, each branch its settings choose) compiles and links as WebGL 1 (GLSL ES 1.00) with Avee's vertex interface, declares a variable for each uniform float, and changes a test image
  CHECK: node scripts/check-viz-shaders.ts
  EXPECT: VIZ-SHADERS-PASSED

- [ ] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/

- [ ] V3: After Effects 2025 opens the converted Trap Nation template from its collected layout and renders a frame without an error or missing footage
  CHECK: node scripts/viz-sample.ts "C:/Users/schxm/Downloads/Trap Nation Template New.viz" --aerender
  EXPECT: VIZ-AE-PASSED

- [ ] V4: After Effects 2025 does the same for the unpacked SummerVibe template, with its image masks as track mattes
  CHECK: node scripts/viz-sample.ts "C:/Users/schxm/Downloads/SummerVibe2026.viz" --aerender
  EXPECT: VIZ-AE-PASSED

- [ ] V6: After Effects 2025 renders the 30-composition East Dreams template (FOV, shader elements, three particle systems) without an error or missing footage
  CHECK: node scripts/viz-sample.ts "C:/Users/schxm/Downloads/East_Dreams_visual_by_HELLWRAITH.viz" --aerender
  EXPECT: VIZ-AE-PASSED
