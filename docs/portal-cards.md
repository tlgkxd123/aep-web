# Portal Cards

Select an image, video, or precomposition layer and apply **AEP Web > Portal Cards** from Effects & Presets or the Effect menu. Place a logo or foreground graphics on separate layers above it.

The effect repeats the source image as centered, nested rectangular planes, inspired by the background in [INZO – ANGST](https://www.youtube.com/watch?v=SgaFHvsYDJ8). New planes appear at the vanishing point and grow outward with shallow seeded tilt and small offsets. The nearest plane straightens as it leaves the frame, keeping the transition continuous. Each plane preserves the source image's proportions and opaque interiors; both sides display the image when rotated. It uses your image; the reference's logo and particles are separate foreground elements.

- **Cards / Depth Spacing:** number of cards in front of the background and how quickly they shrink into the distance (percent). At zero Randomness, each card's size is this percentage of the previous one.
- **Speed:** travel in cards per second × 100. Negative values reverse travel; zero stops automatic motion. A new plane reaches the front every `100 / abs(Speed)` seconds (5 seconds at Speed 20). Successive planes have different seeded tilt and offsets; the full sequence repeats after 32 such intervals (160 seconds at Speed 20). At Randomness 0, the regular stack repeats after one interval. These loops require static controls and a still source.
- **Evolution:** manual travel, 360 degrees per card; animate this for precise timing.
- **Y Rotation / X Rotation / Twist:** rotation strengths, in degrees. At full Randomness, rotations are restrained to keep the planes nested like the reference.
- **Randomness:** blends the regular stack's wave motion into shallow seeded tilt, small offsets and size variation, from 0 to 100. The default is 100. Timing and the shared vanishing point stay regular. Existing saved effects without this control start at zero.
- **Random Seed:** change this integer to generate another arrangement. The same seed and controls reproduce the same frames when scrubbing, reopening or exporting; the layout moves smoothly rather than being regenerated on each frame.
- **Drift / Zoom / Center X / Center Y:** positioning and scale, in percent. The default center is 50, 50.
- **Shadow / Edge Light:** separation between overlapping cards.
- **Background:** original image opacity beneath the cards. When enabled, the nearest plane extends across the frame with no visible border during handoff. Zero leaves transparent space outside the cards; reduce Zoom to expose that space if the nearest card fills the frame. Card interiors retain the source brightness.
- **Pulse:** extra zoom, from 0 to 100. Keyframe it or link it to a Bass slider with an expression such as `thisComp.layer("Audio Controls").effect("Bass")(1)`. It does not analyze audio automatically. Animated controls and moving footage must also repeat for an exported video to loop.

All controls support keyframes, expressions, undo, and saving/reopening in AEP Web. Rendering uses WebGL2 and supports reduced preview resolution and video export. This is an AEP Web effect; After Effects does not have a corresponding plugin to render it. Export video from AEP Web when you need the rendered result elsewhere.

Verification: `node scripts/check-portal-cards.ts` writes a generated sample project and landscape, portrait and spawn-sequence frames to `refs/probe/portal-cards/`. It checks source mapping, independent axis rotation, reverse faces, seeds, smooth spawning, animated Randomness, continuous loops, scrubbing, pulse, transparency, and half resolution. `gates/portal-cards.md` records the checks.
