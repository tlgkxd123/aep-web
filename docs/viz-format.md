# Avee Player templates (.viz)

What the converter (`src/viz/convert.ts`) and the exporter (`src/viz/export.ts`) know about Avee Player's visualizer
templates, learnt from four templates the user provided (Trap Nation style templates, an unpacked folder, and a
30-composition template with particles). Nothing here comes from the Avee Player app itself: it was not unpacked or
decompiled. Each fact says how sure it is:

- **seen**: read directly in both samples;
- **inferred**: the reading that makes the samples consistent, checked by converting them and looking at After
  Effects' renders;
- **unknown**: not determined; the converter's choice is named.

## Container

- **seen** A `.viz` is a ZIP archive: `scene.json` first (deflated, with a data descriptor), then the template's
  images, deflated, under bare names (`1000160814`, `1000163077`), PNG or JPEG by their bytes.
- **seen** A template can also come unpacked: a folder named `<name>.viz` holding `scene.json` and the images. Some
  images there keep an extension (`5511.gif`) that the scene leaves out (`local:5511`).
- **seen** A scene can name images the archive does not hold (`local:1000162243`), and compositions it does not have
  (`composition:20` in an 18-composition scene). The converter reports both.

## scene.json

- **seen** `{ "objType": "Root", "ver": "10", "template": 1, "compositions": [ { "objType": "Composition",
  "elements": [...] }, ... ] }`. Composition 0 is what the template shows; the others are drawn by elements of it.
- **seen** Every property is self-describing: `{ "v": value, "t": "type args…", "o": order, "tag": group }`.
  Types seen: `b` (0/1), `i min max`, `f min max`, `f2 min max` (`"x y"`), `sel a b c…`, `_child a b c…` (a choice
  with sub-properties beside `v`), `crgba`/`crgb` (packed ARGB integer, signed), `chsla4f` (`"h s l a"`, 0–1),
  `img sources…`/`pimg`, `mvarf min max` (`"Constant 1.0 1.0"`), `ptxt`/`etxt` (text, GLSL source), `ih`, `_dyn`.
- **seen** Values go past the ranges types declare (`MeasureColorBlend` A = 15 with `f 0.0 1.0`, particle scale
  -50 with `f 0.25 8.0`): the ranges are the editor's sliders. The converter keeps values as stored.
- **seen** Elements are drawn in list order, bottom first.

### Placement (every drawn element)

- **inferred** The element's box is `scale × the composition's size`, centred on `position` (fractions of the
  composition, 0.5 0.5 the centre; the range −1…1 allows placing outside). `alignmentPosition` is the point of the
  box at `position`. Evidence: the Trap Nation ring (Bars at scale 0.455, mirrored at 0.9) lands exactly on the logo's
  circle (scale 0.41), and full-frame backgrounds at scale 1 cover the frame.
- **inferred** Images fit inside their box keeping their aspect ratio (`keepAspectRatio`), cover it
  (`keepAspectRatioAndCropToFit`), or stretch to it. A `Circle` shape crops to the circle inscribed in the image; the
  converter keeps circle-shaped images' proportions even without `keepAspectRatio`, so the circle stays round.
- **unknown** Whether y grows downwards (the samples only centre elements); the converter takes screen coordinates.
- **inferred** `rotation` is in degrees (`f 0.0 300.0` is the slider's range): a template draws pairs of rings at
  89.75 and 90.25 to thicken their lines.

### Sources

- **seen** `customImage`, `MaskImage`, `TargetImage`/`targetImage`: `local:<asset>`, `composition:<n>`, or
  `internalres:<name>` (Avee's built-in images: `white`, `black`, `transparent`, particle sprites, `vignette80`,
  `lens_flare`, `rainbow128`…). Only white, black and transparent are converted.
- **seen** Effect elements draw a composition through an effect: Blur (`sourceCompositionIndex`), Mirror, Motion
  Blur, RGB Split and Custom Shader (`TargetImage`/`targetImage`).

### Colour, opacity and blending

- **inferred** `Color` tints the element (`chsla4f`: hue, saturation, lightness, alpha); its alpha is the element's
  opacity. `ColorTo` is where `MeasureColorBlend` takes it.
- **inferred** A black or white image drawn normally over what its composition already drew tints that content
  without covering what lies under the composition: it keeps the alpha it is drawn over. The Trap Nation template
  dims its ring between beats this way, and its background shows through. The converter makes these an adjustment
  layer with Fill (equal to a solid with Preserve Underlying Transparency).
- **seen** `blendMode`: Alpha, PreMulAlpha, Over (normal), Screen, Add, AddAlpha. **inferred** Add and AddAlpha both
  add colour; the converter uses Add for both.

### Measures (what animates a property)

- **seen** `MeasurePos`, `measureScale`, `measureRot`, `MeasureColorBlend`, `measureAnimationSpeed`,
  `MeasureOverallSpeed` carry `measureWhat` (`Nothing`, `Beat`, `TotalTime`, `TotalTimeBackward`,
  `TotalTimeAndBeat`, `TrackPosition`, `BeatRandomShake`, `BeatCamShakeMore/Less`, `ConstantShake…`,
  `BeatTriggerAnim`…) and amounts `A`, `B` with hints (`X Amount`, `Speed`, `Beat Amount`).
- **inferred** `Beat` scale: `scale × (1 + A·beat)` (the Trap Nation logo bounces by 0.2). `Beat` colour blend:
  `min(1, A·beat)`. `TrackPosition` colour blend: `min(1, A · time / song length)` (the Trap Nation template fades its
  ring in over the first fifteenth of the song). The beat is the song's bass level (src/quickstart/bass.ts), keyed on
  the main comp's Controls › Beat slider.
- **unknown** The speed units of `TotalTime` rotation (converter: one turn a second per unit), the shakes' reach
  (converter: wiggles of 40 px per unit of amount), and `measureAnimationSpeed` (GIF playback or texture scrolling;
  left out).

### Bars (spectrum)

- **seen** `audioProviderIndex` counts the scene's `AudioProvider` elements from 1, in scene order. An
  `AudioProvider` (`sampleProvider` Spectrum2) has `lowerHz`, `higherHz`, `audioDurationMs`, `sampleOutCount`,
  smoothing and beat-range settings. **inferred** These map onto Audio Spectrum's frequencies, Audio Duration and
  bands.
- **seen** `ShapePath` (HorizontalLine, Circle with `radius` and `gap`, SidedPolygon, Letter), `Segment1/2` (None,
  Bars, Line, SharpBars, RoundBars) with `colorFrom`/`colorTo`, `barHeightMultiplier`; `heightScale`, `flipInput`.
- **inferred** A circle's radius is `radius × half the box's shorter side`. The nine Trap Nation rings are the
  classic rainbow, white on top over the shortest audio window at the back. The element's rotation turns where the
  circle starts; `gap` leaves that share of the turn empty; the provider's `outputMultiplier` scales the heights.
- **inferred** The provider's samples go round the whole circle; a Mirror Effect then shows one half twice, so a
  mirrored ring shows the lower half of the frequencies (the converter draws that half of the range on the left half
  of the circle; the exporter doubles it back). `mirrorSamples` runs the samples up both halves, `repeatSamples`
  round the circle again.
- **inferred** Avee's spectra move along their whole length where After Effects' Audio Spectrum, drawing raw
  magnitudes, moves mostly at the low end (music's bass is far louder). The converter cuts a ring into 8 pieces of its
  frequencies, each its own Audio Spectrum whose Max Height is raised by how much quieter that piece typically is in
  the song (src/viz/spectrumGains.ts, measured with the app's Audio Spectrum analysis, at most 12×).
- **unknown** Where a circle starts at rotation 0: the converter takes the top, anticlockwise. Bar height units: the
  converter scales Audio Spectrum's Max Height so the Trap Nation template's 2.75 × 0.1 peaks like the Quick Start
  ring.

### Effects

- **seen** Blur: `blurRadius` × `blurMultiplier`, `showUnblurredContent` (and `…Under`), `blendModeContent`, extra
  scaled layers (`1/2/3layerScale`, `…Color`). **unknown** The blur's unit: the converter uses 4 px of Gaussian Blur
  per unit, set by eye.
- **seen** Mirror: `mirrorMode` (Horizontal, Vertical, both), `flipMirror`. **inferred** Horizontal mirrors the left
  half onto the right, as After Effects' Mirror does at 0°.
- **seen** Custom Shader: GLSL (`shaderFragment`, `shaderVertex`) with variables driven by measures. Not converted;
  the Trap Nation template's three "shake" shaders displace by the beat, which the converter approximates with a
  wiggle.
- **seen** Particles: count limit, spawn time, lifetime, speed and its randomness, start / fade-in / end sizes,
  fade-in-and-out time, colours, gravity, a spawn area (Rectangle or HorizontalLine, random vectors), perspective
  depth, mirror X / Y, a custom sprite, and a speed measure. **inferred** They map onto Trapcode Particular: a Box
  emitter the size of the element's box and as deep as the perspective depth, Particles/sec from the spawn time (no
  more than the count limit over a life), Uniform emission for random vectors, Life, Velocity (60 px/s per unit of
  speed), Size (2 px per unit) and Size Random, Size and Opacity over Life from the sizes and fade, Gravity and Wind,
  Mirror effects for the mirrors, and Physics Time Factor `1 + amount · beat` (at most 5×) for a beat speed measure.
  Sprites are drawn as Glow Spheres.
- **seen** FOV: draws a composition with a curvature (`curvature`, `aspectRatio`, `repeatTexture`, all `mvarf`).
  DummyElement: a shader element like Custom Shader. Both are drawn as the composition they draw; other unknown
  elements that draw a composition are too.

## Export (After Effects to Avee)

- **inferred** The exporter writes elements with every property Avee Player stores, in its order and groups
  (src/viz/data/schema.json, written by scripts/viz-schema.ts from templates' structure, their content cleared), as a
  ZIP of scene.json and the images. Every comp of the project goes in: the exported comp as composition 0, then the
  others. Whether Avee Player opens what it writes has not been tried in Avee Player.
- **seen** A Custom Shader is GLSL ES 1.00 (`texture2D`, `gl_FragColor`): the fragment shader samples the composition it
  draws as `uniform sampler2D u_texture` at `varying vec2 vTexCoord`; the vertex shader gets `uniform mat4 u_projView`
  and the attributes `Position`, `TexCoord` and `Color`. Its `varGroup` (`_dyn`) lists variables `var0`, `var1`…, each
  `Value` (also `Checkbox`, `Texture`) with a `name` (the uniform) and a `value` (`mvarf`: a measure and two numbers,
  `"Constant 0.2 1.0"` for the constant 0.2), and ends with an empty `newVariable`.
- **inferred** Effects Avee has no element for are exported as Custom Shaders written for them (src/viz/shaders.ts,
  their formulas ported from the app's renderer): scalar settings are variables, colours and points constants, and the
  first line names the effect and its settings so convert.ts restores the effect. `scripts/check-viz-shaders.ts`
  compiles and draws them all as WebGL 1. **unknown** Which way `vTexCoord`'s y runs: taken as GL's (0 at the bottom),
  which only matters for effects with a direction or points (Gradient Ramp, Offset, Directional Blur, Drop Shadow,
  Polar Coordinates).
