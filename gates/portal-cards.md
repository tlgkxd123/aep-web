# Gates: Portal Cards

Scope: Apply an animated perspective stack of the layer image from Effects & Presets, inspired by the background cards in https://www.youtube.com/watch?v=CMhT49zLgrc. Preserve editable controls through undo and project save/reopen. This is an app effect; After Effects has no matching plugin.

- [ ] G1: Types and production bundle compile.
  CHECK: npm run build
  EXPECT: built in
  EVIDENCE: pending

- [ ] G2: Portal Cards applies from the library, exposes editable animated controls, survives save/reopen and undo; existing effect UI tests pass.
  CHECK: npx vitest run tests/portal-cards.test.ts tests/effect-library.test.tsx tests/effect-library-load.test.tsx
  EXPECT: Test Files\s+3 passed
  EVIDENCE: pending

- [ ] G3: GPU renders textured perspective cards, deterministic animation, pulse, reduced resolution and transparent input without warnings; the user's settings preserve brightness and repeat exactly every 5 seconds with continuous loop boundaries.
  CHECK: node scripts/check-portal-cards.ts
  EXPECT: Portal Cards GPU checks passed
  EVIDENCE: pending

- [ ] G4: Rendered frames visually show nested image cards with perspective and changing motion, matching the reference's background mechanism.
  EVIDENCE: pending
