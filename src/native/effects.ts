// The effects the native engine renders (native/src/effects), by match name. A layer with an enabled effect missing
// here is left to the WebGL renderer. native/src/effects/list.inc holds the same list for the C++ planner and engine;
// tests/native-plan.test.ts checks that the two agree.
export interface NativeEffect {
  /** Renders at a reduced resolution (EffectOptions.scalable); without it, a plan below full resolution is left to WebGL. */
  scalable: boolean;
  /** Draws nothing (expression controls): planned as if it were not there. */
  passThrough: boolean;
}

const effect = (scalable: boolean, passThrough = false): NativeEffect => ({ scalable, passThrough });

export const NATIVE_EFFECTS: ReadonlyMap<string, NativeEffect> = new Map([
  ["ADBE Box Blur2", effect(true)],
  ["ADBE Channel Blur", effect(true)],
  ["CS CrossBlur", effect(true)],
  ["ADBE Gradient Wipe", effect(true)],
  ["CC Image Wipe", effect(true)],
  ["CC Scale Wipe", effect(true)],
  ["CC Radial ScaleWipe", effect(true)],
  ["CC Light Wipe", effect(true)],
  ["CC Jaws", effect(true)],
  ["CS LineSweep", effect(true)],
  ["ADBE IRIS_WIPE", effect(true)],
  ["ADBE Block Dissolve", effect(true)],
  ["ADBE Strobe", effect(true)],
  ["PEDG2", effect(true)],
  ["ADBE Checkerboard", effect(true)],
  ["ADBE Circle", effect(true)],
  ["ADBE Grid", effect(true)],
  ["ADBE ELLIPSE", effect(true)],
  ["ADBE Laser", effect(true)],
  ["CC Light Sweep", effect(true)],
  ["ADBE Fill", effect(true)],
  ["ADBE Polar Coordinates", effect(true)],
  ["ADBE Mirror", effect(true)],
  ["ADBE Ramp", effect(true)],
  ["CC Threshold", effect(true)],
  ["CC Threshold RGB", effect(true)],
  ["ADBE Find Edges", effect(true)],
  ["ADBE Emboss", effect(true)],
  ["ADBE Color Emboss", effect(true)],
  ["CC RepeTile", effect(true)],
  ["CC Kaleida", effect(true)],
  ["CS HexTile", effect(true)],
  ["CS BlockLoad", effect(true)],
  ["ADBE Set Channels", effect(true)],
  ["ADBE Channel Combiner", effect(true)],
  ["ADBE Arithmetic", effect(true)],
  ["ADBE Compound Arithmetic", effect(true)],
  ["ADBE Blend", effect(true)],
  ["ADBE Calculations", effect(true)],
  ["ADBE Solid Composite", effect(true)],
  ["CC Composite", effect(true)],
  ["ADBE GROW BOUNDS", effect(true)],
  ["ADBE Cineon Converter2", effect(true)],
  ["ADBE Compander", effect(true)],
  ["ADBE HDR ToneMap", effect(true)],
  // Draw their input unchanged (superpose.ts, channelUtility.ts).
  ["CC Overbrights", effect(true, true)],
  ["ADBE AudSpect", effect(true, false)],
  ["Keller.io Superpose 2", effect(true, true)],
  ["ADBE Slider Control", effect(true, true)],
  ["ADBE Point Control", effect(true, true)],
  ["ADBE Point3D Control", effect(true, true)],
  ["ADBE Angle Control", effect(true, true)],
  ["ADBE Checkbox Control", effect(true, true)],
  ["ADBE Color Control", effect(true, true)],
  ["ADBE Dropdown Control", effect(true, true)],
  ["ADBE Layer Control", effect(true, true)],
]);

/** The native engine's entry for an effect; pseudo effects (presets' parameter sets) draw nothing, like controls. */
export function nativeEffect(matchName: string): NativeEffect | undefined {
  return NATIVE_EFFECTS.get(matchName) ?? (matchName.startsWith("Pseudo/") ? effect(true, true) : undefined);
}
