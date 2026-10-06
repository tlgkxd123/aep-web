// Superpose 2 (Keller.io) blends a layer with its own recent frames. On the
// user's project footage and on moving test content (fxextra_superpose_sweep:
// start/end range, every n-th frame, divergence and rating), After Effects'
// renders show the layer unchanged, so the browser draws it unchanged too.
import { registerEffect } from "../registry.ts";

registerEffect("Keller.io Superpose 2", (input) => input);
