/**
 * The effects the native engine renders (src/native/effects.ts holds the same list for the TypeScript planner):
 * AEVK_EFFECT(match name, scalable, pass-through). Pass-through effects (expression controls) draw nothing; match
 * names starting "Pseudo/" (presets' parameter sets) count as pass-through too.
 */
AEVK_EFFECT("ADBE Box Blur2", true, false)
AEVK_EFFECT("ADBE Slider Control", true, true)
AEVK_EFFECT("ADBE Point Control", true, true)
AEVK_EFFECT("ADBE Point3D Control", true, true)
AEVK_EFFECT("ADBE Angle Control", true, true)
AEVK_EFFECT("ADBE Checkbox Control", true, true)
AEVK_EFFECT("ADBE Color Control", true, true)
AEVK_EFFECT("ADBE Dropdown Control", true, true)
AEVK_EFFECT("ADBE Layer Control", true, true)
