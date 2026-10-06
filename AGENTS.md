# aep-web: After Effects projects in the browser

Opens real After Effects `.aep` files in the browser and renders them with WebGL2, checked
frame by frame against After Effects 2025's own renders. React + TypeScript + Vite.

## Layout

- `src/aep/` - the project model and parser.
  - `riff.ts`: RIFX chunk tree.
  - `decode.ts`: binary chunk decoders (`idta`, `cdta`, `ldta`, `tdb4`, `cdat`, `ldat`, `sspc`, `opti`, `pard`...).
  - `parse.ts`: builds `Project` from chunks. `synthesize.ts` fills in properties AE omits, from
    the py-aep spec tables in `data/`.
  - `model.ts`: types.
  - `evaluate.ts`:
    - `valueAtTime` gives the pre-expression value at a comp time (keyframe interpolation, spatial
      paths, Orientation slerp, path morphing, gradients).
    - `currentValue` gives the post-expression value, once an engine is installed with
      `setExpressionEvaluator`.
  - `transform.ts`: `localTransform`, `worldMatrix` (parenting, 3D, orientation), cameras,
    `sourcePointToComp`.
- `src/render/` - the WebGL2 compositor.
  - `renderer.ts`, `Renderer.render(project, comp, time)`, works per layer:
    1. content (provider registry, then solids, precomps, shapes);
    2. masks (`masks.ts`, Canvas2D coverage);
    3. effects (effect registry);
    4. placement through the layer matrix, with perspective for 3D layers;
    5. a composite pass (blend mode, track matte, opacity) in `shaders.ts`.
  - Images are premultiplied RGBA8 targets with a 1 px transparent border (PAD), in GL row order
    (row 0 is the bottom).
  - `registry.ts` holds the extension points: `registerContentProvider` (text, footage...) and
    `registerEffect(matchName, fn)`. Feature modules register from `features.ts`, one import line
    per feature area.
  - `shapes.ts`: shape layers in Canvas2D.
  - `harness.ts`: `window.aepHarness` for the headless pixel tests.
- `src/ui/` - the After Effects 2025-style workspace. `CompositionPanel.tsx` renders the viewer
  through `useCompRender`.
- `scripts/` - verification and tooling. Run each with `node scripts/<name>.ts` (Node runs
  TypeScript directly).

## Verification (the gates)

| Gate | Command | Checks |
| --- | --- | --- |
| G1 | `npx tsc --noEmit` | strict types |
| G2/G3 | `node scripts/corpus-report.ts --require-parse` / `--require-match` | parser vs py-aep ExtendScript exports (slow, ~1 min) |
| G4 | `npx vitest run tests/ui.test.tsx` | UI smoke test |
| G5 | `npx vite build` | production bundle |
| G6 | `node scripts/vat-report.ts --require` | `valueAtTime` vs AE per-frame values |
| G7 | `node scripts/geometry-report.ts --require` | matrices and cameras vs AE |
| G8 | `node scripts/pixel-report.ts --require` | renders vs AE reference frames, all suites |

The pixel criterion: a pixel differs when a premultiplied channel is off by more than 3/255. A
frame passes when two things hold:

- at most 0.1 % of non-edge pixels differ (an edge pixel is one where the reference's 3×3
  neighbourhood contrast exceeds 48);
- the mean error is at most 1/255.

A suite manifest can list accepted approximations as `"known": {"comp@frame": "reason"}`. They
must still stay within a mean error of 1/255. Diff sheets (reference | ours | diff×8) go to
`refs/diff/`.

Gate ledgers follow the unlazy skill (`C:/Users/schxm/.claude/skills/unlazy/SKILL.md`):

- check a ledger with `node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-check.mjs --approve <ledger>`;
- add `--reverify` to re-run already-checked gates.

`GATES.md` is the core ledger. Feature areas keep their own `gates/<area>.md`.

## Ground truth

- **py-aep** (MIT) is at `C:/Users/schxm/projects/_ref/py-aep`; override with the `PY_AEP` env
  variable. Its `samples/` corpus holds `.aep` files plus ExtendScript JSON exports. See
  `scripts/lib/paths.ts`.
- **After Effects 2025** `aerender` renders reference frames. Always go through
  `scripts/aerender.ts` / `scripts/render-refs.ts`:
  - they take a machine-wide lock (`scripts/lib/ae-lock.ts`), so parallel worktrees never run
    two renders at once;
  - they handle render-only mode;
  - the engine runs in the Spanish locale, so the TIFF template is "Secuencia TIFF con alfa".
  - AE 2025 cannot open files saved by AE 2026.
- **Fixtures** are authored with py-aep through `scripts/fixtures/aepfix.py`. A `Suite("<area>")`
  writes `refs/fixtures/<area>.aep` plus `<area>.manifest.json`. The core suite is
  `build_fixtures.py` → `fixtures.aep` / `manifest.json`; leave it alone.
  - Build: `uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_<area>.py`
  - Render references: `node scripts/render-refs.ts --suite <area>`, which writes
    `refs/frames/<comp>/frame_#####.tif`. Commit those frames.
  - Compare: `node scripts/pixel-report.ts --suite <area> --require [--only comp,comp] [--no-build]`
  - Comp names are global across suites, so prefix them with the area (`text_basic`, ...).
  - Known py-aep authoring quirks are listed at the top of `aepfix.py`:
    - AE ignores static 2D positions of shape items;
    - masks on sourceless layers are in pixels;
    - stroke dashes can't be authored.

  When py-aep cannot author something, check whether a corpus sample already has it and AE 2025
  can open that file (copy it into `refs/fixtures/`), or extend the authoring in `aepfix.py`.

## AE rules found so far (from references)

- **Blending:** Add is a premultiplied sum; Linear Dodge is separable.
- **Masks:**
  - Add = a + c − a·c; Subtract = a·(1 − c); Intersect = a·c; Lighten = max; Darken = min;
    Difference = |a − c|.
  - The stack starts full when the first mode is Subtract, Intersect or Darken.
  - Feather is a Gaussian with σ = feather / 2.4, truncated at the feather radius.
- **Shapes:**
  - Gradients are sampled at pixel corners.
  - Repeater opacity steps by k/copies.
  - Skew = Rot(−axis)·ShearX(tan(−skew))·Rot(axis).
- **Cameras:** the default camera zoom = width × pixelAspect / 0.72.

## Rules

- Never copy Adobe code, assets or binaries. Never decompile or disassemble plugins (third-party or
  Adobe's): that breaks their licenses.
  - Reading the parameters a project stores in the `.aep` is fine.
  - So is a black-box look-alike reimplementation validated against AE renders.
- Untrusted `.aep` files can contain expressions, and expressions are code. They must not get
  access to the DOM, network or storage.
- Match the surrounding code style. Comments state constraints, not history.
- PowerShell mangles inline `node -e` and regexes. Put logic in script files under `scripts/`.
