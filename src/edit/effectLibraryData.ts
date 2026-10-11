// The Effects & Presets library's data (data/effect-library.json), as a module of its own so the app loads it on
// first use. The JSON is imported statically: a dynamic import() keeps its import attribute in the browser, which
// then rejects the JavaScript the Vite dev server serves JSON modules as.
import library from "./data/effect-library.json" with { type: "json" };

export default library;
