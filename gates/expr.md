# Gates: expressions - After Effects expressions evaluated in the browser

OWNS: src/expressions/**, tests/expressions.test.ts, scripts/expr-report.ts, scripts/expr-bench.ts, scripts/fixtures/build_expr.py, refs/fixtures/expr*, refs/frames/expr_*/**, gates/expr.md

Scope: an expression engine installed with setExpressionEvaluator. Expressions run in an AST-guarded sandbox (acorn parse, allowlist rewrite, verified output, run-time member guards) against the After Effects object model, and rendering reads post-expression values. Truth comes from After Effects itself: the py-aep ExtendScript exports (post-expression values, markers) and aerender references of the expr, expr_legacy and expr_random fixture projects, whose probe comps encode exact numbers in pixel colours. AE's random generators (random, gaussRandom, wiggle, noise) are a known gap: they are measured by expr-report but never counted as passing.

- [ ] E0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/expr.md
  EXPECT: LINT OK

- [ ] E1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] E2: sandbox escapes fail (constructor chains, Function, import(), fetch, globals, prototype and function writes, runaway loops) and the language, API and marker tests pass, markers matching the ExtendScript exports
  CHECK: npx vitest run tests/expressions.test.ts
  EXPECT: /Tests\s+\d+ passed \(\d+\)/

- [ ] E3: every deterministic expression value matches After Effects - corpus post-expression values within 0.001 with the same error state, and every probe cell of the expr and expr_legacy references within 2/1024
  CHECK: node scripts/expr-report.ts --require
  EXPECT: EXPRESSIONS-MATCH-AE

- [ ] E4: the expr fixture comps (JavaScript engine) render like After Effects under the G8 pixel criterion
  CHECK: node scripts/pixel-report.ts --suite expr --require
  EXPECT: PIXELS-PASSED

- [ ] E5: the expr_legacy fixture comps (Legacy ExtendScript engine) render like After Effects under the G8 pixel criterion
  CHECK: node scripts/pixel-report.ts --suite expr_legacy --require
  EXPECT: PIXELS-PASSED

- [ ] E6: every fixture frame of every suite still passes the G8 pixel criterion
  CHECK: node scripts/pixel-report.ts --require
  EXPECT: PIXELS-PASSED

- [ ] E7: G6 still holds - valueAtTime reproduces After Effects' per-frame values for every animated property in the value_at_time exports
  CHECK: node scripts/vat-report.ts --require
  EXPECT: VALUE-AT-TIME-PASSED

- [ ] E8: G7 still holds - layer world matrices, parenting and camera rays reproduce After Effects' results within 0.005 px
  CHECK: node scripts/geometry-report.ts --require
  EXPECT: GEOMETRY-PASSED

- [ ] E9: the inspector UI still opens a project and shows its composition, layers and properties
  CHECK: npx vitest run tests/ui.test.tsx
  EXPECT: /Test Files\s+1 passed/

- [ ] E10: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/
