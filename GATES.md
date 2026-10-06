# Gates: phase 1 - open .aep projects in the browser and inspect them

OWNS: src/**, tests/**, scripts/**, package.json, tsconfig.json, vite.config.ts, index.html, GATES.md

Scope: a TypeScript .aep parser plus a browser inspector that shows project items, compositions, layers, properties, keyframes, effects and raw chunks, checked against After Effects' own ExtendScript exports in the py-aep sample corpus.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: pending

- [ ] G2: every .aep file in the sample corpus parses without an exception, and the corpus holds at least 500 files
  CHECK: node scripts/corpus-report.ts --require-parse
  EXPECT: CORPUS-PARSE-PASSED
  EVIDENCE: pending

- [ ] G3: parsed items, layers, property values and keyframes agree with the ExtendScript JSON exports (items and layers at least 99.5 percent, property values and keyframes at least 98 percent, every exported layer found)
  CHECK: node scripts/corpus-report.ts --require-match
  EXPECT: CORPUS-MATCH-PASSED
  EVIDENCE: pending

- [ ] G4: loading a sample .aep in the inspector UI renders its composition, a layer and a transform property
  CHECK: npx vitest run tests/ui.test.tsx
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: pending

- [ ] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/
  EVIDENCE: pending

- [ ] G7: layer world matrices, parenting and camera rays reproduce After Effects' sourcePointToComp and compPointToSource results within 0.005 px (2D, parented, 3D, keyframed layers; one-node, two-node, keyed-zoom and default cameras)
  CHECK: node scripts/geometry-report.ts --require
  EXPECT: GEOMETRY-PASSED
  EVIDENCE: pending

- [ ] G6: valueAtTime reproduces After Effects' per-frame values for every animated property in the value_at_time exports (0.001 tolerance, 0.015 px on motion paths, every property found)
  CHECK: node scripts/vat-report.ts --require
  EXPECT: VALUE-AT-TIME-PASSED
  EVIDENCE: pending
