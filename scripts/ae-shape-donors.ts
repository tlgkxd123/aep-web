// Generates the shape and mask donors: refs/fixtures/donors/ae2025-shapes.aep, a project After Effects 2025
// itself builds and saves (an ExtendScript run through scripts/ae-script.ts, no UI). Every property of its
// shape groups (Rectangle, Ellipse, Star, Polygon, Path with Stroke, Fill and Transform) and of its masks is
// set away from its default, so After Effects stores them all; static and keyframed Path and Mask Path
// values are both present. scripts/export-shape-template.ts reads it into src/edit/data/shape-template.json.
//
//   node scripts/ae-shape-donors.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runScript } from "./ae-script.ts";
import { ROOT } from "./lib/suites.ts";

const DIR = join(ROOT, "fixtures", "donors");
export const SHAPE_DONORS = join(DIR, "ae2025-shapes.aep");

const forJsx = (path: string) => resolve(path).replace(/\\/g, "/");

function script(projectPath: string, logPath: string): string {
  return `
var logFile = new File(${JSON.stringify(forJsx(logPath))});
logFile.encoding = "UTF-8";
logFile.open("w");
logFile.close();
function log(text) {
  logFile.open("a");
  logFile.writeln(text);
  logFile.close();
}
log("started");
function put(owner, matchName, value) {
  try {
    owner.property(matchName).setValue(value);
  } catch (err) {
    log("cannot set " + matchName + ": " + String(err));
  }
}
function path(vertices, inT, outT, closed) {
  var s = new Shape();
  s.vertices = vertices;
  s.inTangents = inT;
  s.outTangents = outT;
  s.closed = closed;
  return s;
}
// Adding a property invalidates references to its siblings, so everything is looked up again by index.
function contentsOf(layer) { return layer.property("ADBE Root Vectors Group"); }
function groupAt(layer, gi) { return contentsOf(layer).property(gi); }
function vectorsAt(layer, gi) { return groupAt(layer, gi).property("ADBE Vectors Group"); }
/** A group holding [shape, stroke, fill], every property set away from its default. */
function addGroup(layer, name, shapeMatch, setShape) {
  contentsOf(layer).addProperty("ADBE Vector Group");
  var gi = contentsOf(layer).numProperties;
  groupAt(layer, gi).name = name;
  vectorsAt(layer, gi).addProperty(shapeMatch);
  vectorsAt(layer, gi).addProperty("ADBE Vector Graphic - Stroke");
  vectorsAt(layer, gi).addProperty("ADBE Vector Graphic - Fill");
  put(groupAt(layer, gi), "ADBE Vector Blend Mode", 3);
  setShape(vectorsAt(layer, gi).property(1));
  put(vectorsAt(layer, gi).property(1), "ADBE Vector Shape Direction", 3);
  var stroke = vectorsAt(layer, gi).property(2);
  put(stroke, "ADBE Vector Blend Mode", 3);
  put(stroke, "ADBE Vector Composite Order", 2);
  put(stroke, "ADBE Vector Stroke Color", [0.2, 0.4, 0.6, 1]);
  put(stroke, "ADBE Vector Stroke Opacity", 81);
  put(stroke, "ADBE Vector Stroke Width", 7);
  put(stroke, "ADBE Vector Stroke Line Cap", 2);
  // Miter Limit is hidden unless the join is Miter (1).
  put(stroke, "ADBE Vector Stroke Line Join", 1);
  put(stroke, "ADBE Vector Stroke Miter Limit", 5);
  put(stroke, "ADBE Vector Stroke Line Join", 3);
  var fill = vectorsAt(layer, gi).property(3);
  put(fill, "ADBE Vector Blend Mode", 3);
  put(fill, "ADBE Vector Composite Order", 2);
  put(fill, "ADBE Vector Fill Rule", 2);
  put(fill, "ADBE Vector Fill Color", [0.9, 0.3, 0.1, 1]);
  put(fill, "ADBE Vector Fill Opacity", 83);
  var t = groupAt(layer, gi).property("ADBE Vector Transform Group");
  put(t, "ADBE Vector Anchor", [1, 2]);
  put(t, "ADBE Vector Position", [3, 4]);
  put(t, "ADBE Vector Scale", [91, 92]);
  put(t, "ADBE Vector Skew", 5);
  put(t, "ADBE Vector Skew Axis", 6);
  put(t, "ADBE Vector Rotation", 7);
  put(t, "ADBE Vector Group Opacity", 93);
  log("group " + name);
}
try {
var square = path([[-50, -50], [50, -50], [50, 50], [-50, 50]], [[0, 0], [-10, 0], [0, 0], [0, 10]], [[10, 0], [0, 0], [0, -10], [0, 0]], true);
var wedge = path([[-40, 30], [0, -60], [40, 30]], [[0, 0], [-20, 0], [0, 0]], [[0, 0], [20, 0], [0, 0]], false);

app.newProject();
var comp = app.project.items.addComp("shape donors", 400, 300, 1, 10, 30);

var stored = comp.layers.addShape();
stored.name = "Stored";
addGroup(stored, "Rectangle 1", "ADBE Vector Shape - Rect", function (s) {
  put(s, "ADBE Vector Rect Size", [120, 80]);
  put(s, "ADBE Vector Rect Position", [5, 6]);
  put(s, "ADBE Vector Rect Roundness", 9);
});
addGroup(stored, "Ellipse 1", "ADBE Vector Shape - Ellipse", function (s) {
  put(s, "ADBE Vector Ellipse Size", [110, 70]);
  put(s, "ADBE Vector Ellipse Position", [7, 8]);
});
addGroup(stored, "Polystar 1", "ADBE Vector Shape - Star", function (s) {
  put(s, "ADBE Vector Star Type", 1);
  put(s, "ADBE Vector Star Points", 6);
  put(s, "ADBE Vector Star Position", [9, 10]);
  put(s, "ADBE Vector Star Rotation", 11);
  put(s, "ADBE Vector Star Inner Radius", 30);
  put(s, "ADBE Vector Star Outer Radius", 60);
  put(s, "ADBE Vector Star Inner Roundess", 12);
  put(s, "ADBE Vector Star Outer Roundess", 13);
});
addGroup(stored, "Polygon 1", "ADBE Vector Shape - Star", function (s) {
  put(s, "ADBE Vector Star Type", 2);
  put(s, "ADBE Vector Star Points", 7);
  put(s, "ADBE Vector Star Position", [11, 12]);
  put(s, "ADBE Vector Star Rotation", 13);
  put(s, "ADBE Vector Star Outer Radius", 55);
  put(s, "ADBE Vector Star Outer Roundess", 14);
});
addGroup(stored, "Shape 1", "ADBE Vector Shape - Group", function (s) {
  s.property("ADBE Vector Shape").setValue(square);
});

var animated = comp.layers.addShape();
animated.name = "Animated";
addGroup(animated, "Shape 1", "ADBE Vector Shape - Group", function (s) {
  s.property("ADBE Vector Shape").setValueAtTime(0, square);
  s.property("ADBE Vector Shape").setValueAtTime(1, wedge);
});

var solid = comp.layers.addSolid([0.5, 0.5, 0.5], "Masked", 400, 300, 1);
solid.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
solid.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
var still = solid.property("ADBE Mask Parade").property(1);
still.name = "Still";
still.property("ADBE Mask Shape").setValue(square);
put(still, "ADBE Mask Feather", [3, 4]);
put(still, "ADBE Mask Opacity", 90);
put(still, "ADBE Mask Offset", 5);
still.maskMode = MaskMode.SUBTRACT;
still.inverted = true;
var moving = solid.property("ADBE Mask Parade").property(2);
moving.name = "Moving";
moving.property("ADBE Mask Shape").setValueAtTime(0, square);
moving.property("ADBE Mask Shape").setValueAtTime(1, wedge);
put(moving, "ADBE Mask Feather", [6, 6]);
log("masks");

app.project.save(new File(${JSON.stringify(forJsx(projectPath))}));
log("saved");
} catch (err) {
  log("error at line " + err.line + ": " + err);
}
`;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  mkdirSync(DIR, { recursive: true });
  const log = join(DIR, "ae2025-shapes.log");
  rmSync(SHAPE_DONORS, { force: true });
  rmSync(log, { force: true });
  if (process.env.AE_DUMP) {
    writeFileSync(process.env.AE_DUMP, script(SHAPE_DONORS, log));
    process.exit(0);
  }
  const result = await runScript(script(SHAPE_DONORS, log), { timeoutMs: 10 * 60_000 });
  const lines = readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) console.log(line);
  if (result.timedOut || !lines.includes("saved")) {
    console.log(result.output.trim());
    console.log(`After Effects ${result.timedOut ? "timed out" : "did not save the project"}`);
    process.exit(1);
  }
  rmSync(log, { force: true });
  console.log(`wrote ${SHAPE_DONORS}`);
}
