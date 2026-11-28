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
