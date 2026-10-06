// Location of the py-aep checkout (sample corpus and reference parser); set
// PY_AEP to override. Absolute so scripts also work from git worktrees.
import { join } from "node:path";

export const PY_AEP = process.env.PY_AEP ?? "C:/Users/schxm/projects/_ref/py-aep";
export const SAMPLES = process.env.AEP_SAMPLES ?? join(PY_AEP, "samples");
