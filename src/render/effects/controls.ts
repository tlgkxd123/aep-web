// Expression controls and pseudo effects (parameter sets saved from presets,
// e.g. the Dropdown Menu Control) hold values for expressions and draw nothing.
import { registerEffect, registerEffectPrefix } from "../registry.ts";

registerEffectPrefix("Pseudo/", (input) => input, { cacheable: true, scalable: true });

for (const matchName of [
  "ADBE Slider Control",
  "ADBE Point Control",
  "ADBE Point3D Control",
  "ADBE Angle Control",
  "ADBE Checkbox Control",
  "ADBE Color Control",
  "ADBE Dropdown Control",
  "ADBE Layer Control",
]) {
  registerEffect(matchName, (input) => input, { cacheable: true, scalable: true });
}
