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
 `registerEffect(matchName, fn, options)`. Feature modules register from `features.ts`, one import line
 per feature area. Declare an effect's options when they hold; undeclared effects stay correct but render
 every frame at full resolution:
 - `cacheable`: its output depends only on its input image, its own parameter values and the layer (not on
 the time itself, audio, footage or other layers), so layers using it are reused between frames under the
 keys of `layerKeys.ts`;
 - `scalable`: at a reduced resolution it multiplies what its parameters say in layer pixels by
 `input.scale` (as After Effects effects follow the downsample factor).
 - Reduced resolutions (`render(..., { scale })`, the viewer's Half/Third/Quarter and Fast Previews) render
 nested comps, content, masks and scalable effects at that scale; Full resolution is unaffected.
  - `shapes.ts`: shape layers in Canvas2D.
  - `harness.ts`: `window.aepHarness` for the headless pixel tests.
- `src/ui/` - the After Effects 2025-style workspace. `CompositionPanel.tsx` renders the viewer
  through `useCompRender`.
- `scripts/` - verification and tooling. Run each with `node scripts/<name>.ts` (Node runs
 TypeScript directly).
- `ml/pmatch/` - the Particle Match world model (Extra > Particle Match) in PyTorch, a uv project
 (CUDA wheels; `uv run --project ml/pmatch ...`).
 - The browser analyses the reference video (detection, tracking, sprite crops, shake) and writes
 a safetensors dataset (`src/extra/pmatch/dataset.ts`).
 - PyTorch learns the clock, the audio network, the particle flow, the sprites and the
 appearance, and exports the effect's model format (`src/extra/pmatch/model.ts`; the app runs the
 audio network in `tcn.ts`).
 - The browser then calibrates the model by synthesis.
 - The dev server runs the trainer for the dialog (`server/pmatch-trainer.ts`). From the command line:
 `node scripts/pmatch-train.ts` (`--dataset` exports the analysis for
 `uv run --project ml/pmatch python -m pmatch train`).
 - The window exports a model as Trapcode Particular layers, into a comp of the open project or as a new
 `.aep` with its soundtrack (`src/extra/pmatch/particularExport.ts`).
 - Gates: `gates/pmatch-torch.md`; `gates/pmatch-fast.md` (detail and speed: `scripts/pmatch-report.ts`,
 `pmatch-profile.ts`, `pmatch-inference.ts`); `gates/pmatch-ux.md` (the window and the export:
 `scripts/check-pmatch-ui.ts`, `check-pmatch-export.ts`).

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

`npm run check` runs G1, the full vitest suite and G5 in that order (same as CI).

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

## Automation (`.github/`)

- `ci.yml` runs G1, the vitest suite and G5 on Ubuntu, with the py-aep corpus pinned in
 `.github/actions/setup`. The After Effects and GPU gates have no runner there; run them on this machine.
- `agent.yml` runs a Cursor agent (`.github/agent/run.ts`) on a GitHub runner for an issue labelled
 `agent`, an `/agent ...` comment or `gh workflow run agent.yml -f task="..."`. It repeats the CI
 checks, hands failures back to the agent, and opens a pull request (a draft when the checks still fail).
- `release.yml` builds the signed APK when a GitHub release is published and attaches it to the release.
 The keystore is kept outside the repository, in `~/.android-keys/`.
- The Android app's native side is the `AppShell` plugin (`android/app/src/main/java/.../AppShellPlugin.java`): `.aep`
 files from Open with and Share, and the back button. Its page side, with the installed web app's file handler, is
 `src/ui/system.ts`. Building the APK locally needs JDK 21.

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

  - Effects: py-aep can only add effects the project already defines.
    1. Call `install_effects(suite, ["ADBE Fill", ...])` once. It clones each definition from
       a project that After Effects itself saved (the donors are cached in
       `refs/fixtures/effect-donors.json`).
    2. Then call `add_effect(layer, match_name, p1=..., p2=...)`. It switches the effect on,
       because copied definitions are often stored switched off. It also clears layer
       parameters that would still point at the donor's layers.
    3. Set every parameter the fixture depends on. The copied defaults are the donor's
       stored values, not After Effects' factory defaults (for example, Gaussian Blur comes
       in at 25).

 When py-aep cannot author something, check whether a corpus sample already has it and AE 2025
 can open that file (copy it into `refs/fixtures/`), or extend the authoring in `aepfix.py`.
- **Effect library** (Effects & Presets panel, Effect menu): `src/edit/data/effect-library.json`
 holds a template for every effect with a registered renderer whose definition an AE-saved project
 (or a rendered fixture) holds. After adding renderers, re-run the export and the round trip, which
 applies every library effect through the editor and has AE render the saved file (`gates/library.md`):
 1. `node scripts/export-effect-library.ts` (it lists the effects left out, and why);
 2. `uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_roundtrip.py`;
 3. `node scripts/fixtures/apply_roundtrip.ts` (add `SETTINGS` for the new effects);
 4. `node scripts/render-refs.ts --suite roundtrip --strict`, then
 `node scripts/pixel-report.ts --suite roundtrip --require`.

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

- Rendering runs on the GPU. Masks, effects and layer content must not read pixels back
  (`readPixels`, `getImageData`) or loop over pixels in JavaScript per frame.
  - Use `ctx.pass`/`ctx.program` shaders, instanced draws, or scissored clears.
 - Profile with `node scripts/profile-render.ts <project> [--comps a,b] [--cpu] [--scale 0.5] [--layers]
 [--discrete]`. It runs on the machine's GPU and reports ms per frame, per stage and per top-level layer.
 - Chrome's `gl.finish()` only flushes. Time GPU work with `finishGpu` (`gl.ts`), which reads a pixel back.
 - Browsers on this laptop default to the integrated Intel GPU (`powerPreference` does not change that);
 scripts take `--discrete` for the RTX.
 - Playback in the app: `node scripts/check-video-playback.ts <project> <comps> [s] [start] --serve
 [--require-fps n] [--require-audio] [--require-smooth ms] [--bench frames]`.
 - The stock effects (`gates/stockfx.md`) run in any WebGL2 browser, SwiftShader included:
 `node scripts/check-stock-effects.ts [--chrome <path>] [--out dir]` checks they compile, follow their formulas
 and scale; it does not compare with After Effects.
 - The frame caches must not change a pixel: `node scripts/check-render-cache.ts <project>
 "<comp>@<start>:<frames>" --require`; reduced resolutions against Full: `node scripts/check-render-scale.ts`.

- Never copy Adobe code, assets or binaries. Never decompile or disassemble plugins (third-party or
  Adobe's): that breaks their licenses.
  - Reading the parameters a project stores in the `.aep` is fine.
  - So is a black-box look-alike reimplementation validated against AE renders.
- Untrusted `.aep` files can contain expressions, and expressions are code. They must not get
  access to the DOM, network or storage.
- Match the surrounding code style. Comments state constraints, not history.
- PowerShell mangles inline `node -e` and regexes. Put logic in script files under `scripts/`.
