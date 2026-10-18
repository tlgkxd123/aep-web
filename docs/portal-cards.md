# Portal Cards

Select an image, video, or precomposition layer and apply **AEP Web > Portal Cards** from Effects & Presets or the Effect menu. Place a logo or foreground graphics on separate layers above it.

The effect repeats the source image as nested rectangular cards with perspective, inspired by the background in [RL Grime & Juelz – Formula](https://www.youtube.com/watch?v=CMhT49zLgrc). It uses your image; it does not include the video's artwork, logo or particles.

- **Cards / Depth Spacing:** number of cards in front of the background and each card's size relative to the previous one (percent).
- **Speed:** travel in cards per second × 100. Negative values reverse travel; zero stops automatic motion. With static controls and a still source, the exact loop duration is `100 / abs(Speed)` seconds (5 seconds at Speed 20). Rotation and drift repeat with that same loop.
- **Evolution:** manual travel, 360 degrees per card; animate this for precise timing.
- **Y Rotation / X Rotation / Twist:** maximum animated rotations, in degrees.
- **Drift / Zoom / Center X / Center Y:** positioning and scale, in percent. The default center is 50, 50.
- **Shadow / Edge Light:** separation between overlapping cards.
- **Background:** original image opacity beneath the stack; zero leaves transparent space outside the cards. When enabled, the backmost card extends across the frame with no visible border. Card interiors retain the source brightness.
- **Pulse:** extra zoom, from 0 to 100. Keyframe it or link it to a Bass slider with an expression such as `thisComp.layer("Audio Controls").effect("Bass")(1)`. It does not analyze audio automatically. Animated controls and moving footage must also repeat for an exported video to loop.

All controls support keyframes, expressions, undo, and saving/reopening in AEP Web. Rendering uses WebGL2 and supports reduced preview resolution and video export. This is an AEP Web effect; After Effects does not have a corresponding plugin to render it. Export video from AEP Web when you need the rendered result elsewhere.

Verification: `node scripts/check-portal-cards.ts` writes a generated sample project and rendered frames to `refs/probe/portal-cards/` and checks source mapping, animation, scrubbing, pulse, transparency, and half resolution. `gates/portal-cards.md` records the remaining checks.
