# Gates: mobile - the whole app on phones and tablets, touch first

OWNS: index.html, src/ui/**, src/main.tsx, scripts/check-mobile.ts, tests/mobile.test.tsx, gates/mobile.md

Scope: on phones (portrait and landscape) and tablets the app fits the screen without page scrolling or zooming: one workspace with the Composition viewer, playback controls and a tab bar switching Project, Timeline, Effect Controls, Effects & Presets, Render Queue and the other panels; menus and context menus open as bottom sheets (long-press opens a context menu); a long press on a project item, an effect or a Timeline layer picks it up for a drag, which opens another tab's panel when held on its tab; the viewer pinches to zoom and drags layers with one finger; the Timeline scrubs and selects by touch; effects apply without drag and drop; desktop layouts and behaviour stay as they were.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/mobile.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=35c748bb4c076063e9621439c5dd485ec360932b5f02256e6c12ae39de6df40f; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [ ] M1: in headless Edge with touch emulation on an iPhone-sized portrait screen, an Android portrait screen, three phones in landscape (an iPhone, an Android phone, an iPhone SE-sized one) and an iPad in portrait, an opened project fits the screen with no page overflow; every tab shows its panel inside the screen; the tab bar, top bar, playback controls and sheet rows are at least 44 px tall; a tap selects a Timeline layer; a one-finger drag in the viewer moves the selected layer; a two-finger pinch changes the magnification; dragging on the time ruler moves the current time; the playback strip shows its buttons whole in the viewer's column; a finger scrolls the viewer's bar sideways; Composition Settings fits the screen and a finger scrolls it down to its OK button; Play starts and stops playback; a long-press on a layer opens its menu as a sheet; the menu button's sheet runs Edit > Undo; an effect applies from Effects & Presets with taps only; a finger swiping over the project rows scrolls them; a project item long-pressed and dragged onto the viewer becomes a layer; a drag held on the Timeline tab opens the Timeline and the project item dropped on a layer's row becomes a layer; on an iPad in landscape the desktop workspace fits the screen; no page errors
  CHECK: node scripts/check-mobile.ts --serve
  EXPECT: MOBILE-PASSED

- [x] M2: with a phone-sized screen the app renders the mobile workspace (tab bar switching the panels, menu and context menus as sheets with drill-down submenus), and File > Add Footage to Comp adds the selected project item to the open composition
  CHECK: npx vitest run tests/mobile.test.tsx
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=7a2258695fe9d2ac9818e629717d04a3c51cefa942d7babee53f750bd3add490; exit=0; EXPECT=matched; output-sha256=ed9efb510e4019a574e8d7e18b9b459c5f546c1d6f5a01315c910d4e9ea6a82f; output-bytes=562; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] M3: the desktop UI behaves as before: the inspector, effect library, effect controls, project operations, layer operations, footage and Particle Match UI tests pass
  CHECK: npx vitest run tests/ui.test.tsx tests/effect-library.test.tsx tests/effects-ui.test.tsx tests/project-ops-ui.test.tsx tests/layer-ops-ui.test.tsx tests/footage-ui.test.tsx tests/particle-match-ui.test.tsx
  EXPECT: /Test Files\s+7 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=8aec89b4405d7e48692c08a45d76da364509a8a98dfee9e119d0627396f6785d; exit=0; EXPECT=matched; output-sha256=e443d985cd64fcf1fe0fe3ff9807d63e633febcc24e919c01e452cdad6774bd0; output-bytes=3354; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] M4: on a desktop screen in a real browser, Effects & Presets still searches, and effects dragged onto a Timeline row, the viewer and Effect Controls still apply
  CHECK: node scripts/check-effects-panel.ts --serve
  EXPECT: EFFECTS-PANEL-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=83e28cdaba1972a0ca1313e1961d1ee6e542a9c0a140d668a34fb3598cd49360; exit=0; EXPECT=matched; output-sha256=2200771e561f152c84edb327917cf3e6108dba4da16a93aa3b02cecb343e9457; output-bytes=1044; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] M5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/
  EVIDENCE: automatic-evidence=v1; definition-sha256=202b6423274a1e776d6ddcc8d133917c5c706a45d1cd69c285f24b4a854abbd3; exit=0; EXPECT=matched; output-sha256=889f7efab7bb5794e0ae59ae914fb239676c7b930b2f1fde6a1553f5c1ae1b27; output-bytes=1278; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries
