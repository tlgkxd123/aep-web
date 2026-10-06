# Builds the expression fixtures:
#   refs/fixtures/expr.aep         (JavaScript engine) - visible comps and probe comps
#   refs/fixtures/expr_legacy.aep  (Legacy ExtendScript engine)
#   refs/fixtures/expr_random.aep  (AE's random generators; measured, never counted as passing)
#
# A probe comp is a grid of 10x10 cells. Each cell is a shape layer whose Fill
# Color expression evaluates one number and encodes round(v * SCALE) + OFFSET
# in the 24 bits of the colour, so scripts/expr-report.ts can read After
# Effects' exact value back from the reference frame. Cells are listed in
# refs/fixtures/<suite>.probes.json.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_expr.py
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BG, ORANGE, REFS, TEAL, Suite, add, add_mask, fill, gtr, rect, shape_group, stroke, tr  # noqa: E402

SCALE = 1024
OFFSET = 1 << 23
CELL = 10
COLUMNS = 16
WHITE = [0.95, 0.95, 0.95]
PINK = [0.9, 0.3, 0.6]


def encode(expr, pre=""):
    return (
        f"{pre}\nvar __p = ({expr});\n"
        f"__p = Math.round(__p * {SCALE}) + {OFFSET};\n"
        "[Math.floor(__p / 65536) / 255, Math.floor(__p / 256) % 256 / 255, __p % 256 / 255, 1]"
    )


class ProbeSuite:
    """A Suite whose probe comps are also recorded in <name>.probes.json."""

    def __init__(self, suite: Suite, engine: str, manifest: bool = True):
        self.suite = suite
        self.suite.project.expression_engine = engine
        self.probes = []
        self.manifest = manifest

    def probe(self, name, cells, setup=None, frames=(0,), duration=1.0, random=False):
        entry = {"comp": name, "frames": list(frames), "cells": []}
        if random:
            entry["random"] = True

        def build(comp):
            comp.add_solid([0.0, 0.0, 0.0], "probe_bg")
            if setup:
                setup(comp)
            for k, cell in enumerate(cells):
                label, expr = cell[0], cell[1]
                pre = cell[2] if len(cell) > 2 else ""
                x = (k % COLUMNS) * CELL + CELL // 2
                y = (k // COLUMNS) * CELL + CELL // 2
                layer = comp.add_shape()
                layer.name = f"p{k}"
                group = shape_group(layer, "cell")
                add(group, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [float(CELL), float(CELL)]})
                color = fill(group, [0.0, 0.0, 0.0])
                color["ADBE Vector Fill Color"].expression = encode(expr, pre)
                gtr(group, "ADBE Vector Position", [x - 80.0, y - 60.0])
                entry["cells"].append({"layer": layer.name, "label": label, "x": x, "y": y})

        self.suite.case(name, frames=frames, duration=duration)(build)
        if self.suite.manifest and self.suite.manifest[-1]["comp"] == name:
            self.probes.append(entry)

    def save(self):
        if not self.manifest:
            # Not a pixel suite: keep the comp list out of *manifest.json so pixel-report never counts it.
            self.suite.manifest_file = f"{self.suite.name}.render.json"
        self.suite.save()
        out = {"project": self.suite.project_file, "scale": SCALE, "offset": OFFSET, "comps": self.probes}
        (REFS / f"{self.suite.name}.probes.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")


def keyed(prop, *pairs):
    for t, v in pairs:
        prop.set_value_at_time(t, v)


def expr(prop, source):
    prop.expression = source


# =====================================================================================
# JavaScript engine
# =====================================================================================

js = ProbeSuite(Suite("expr"), "javascript-1.0")
case = js.suite.case
FRAMES = (0, 6, 12, 18)


@case("expr_transform", frames=FRAMES)
def _(comp):
    comp.add_solid(BG, "bg")
    box = comp.add_solid(ORANGE, "box", 40, 30)
    expr(tr(box, "ADBE Position"), "[80 + Math.sin(time * 6) * 40, 60 + Math.cos(time * 6) * 20]")
    expr(tr(box, "ADBE Rotate Z"), "time * 120")
    expr(tr(box, "ADBE Scale"), "[100 + time * 60, 100 - time * 30]")
    expr(tr(box, "ADBE Opacity"), "100 - time * 60")


@case("expr_vector_ops", frames=FRAMES)
def _(comp):
    comp.add_solid(BG, "bg")
    a = comp.add_solid(ORANGE, "a", 20, 20)
    tr(a, "ADBE Position").value = [30.0, 30.0, 0.0]
    expr(tr(a, "ADBE Position"), "value + [60, 40] * time")
    b = comp.add_solid(TEAL, "b", 20, 20)
    tr(b, "ADBE Position").value = [120.0, 90.0, 0.0]
    expr(tr(b, "ADBE Position"), "var d = [40, 20]; value - d * time * 2")
    c = comp.add_solid(WHITE, "c", 30, 12)
    tr(c, "ADBE Position").value = [80.0, 60.0, 0.0]
    expr(tr(c, "ADBE Scale"), "value * (1 + time) / 2")
    expr(tr(c, "ADBE Anchor Point"), "-value / 2 + [15, 6]")


@case("expr_cross_layer", frames=FRAMES)
def _(comp):
    comp.add_solid(BG, "bg")
    leader = comp.add_solid(ORANGE, "leader", 24, 24)
    keyed(tr(leader, "ADBE Position"), (0.0, [20.0, 30.0, 0.0]), (1.0, [140.0, 90.0, 0.0]))
    keyed(tr(leader, "ADBE Rotate Z"), (0.0, 0.0), (1.0, 180.0))
    follower = comp.add_solid(TEAL, "follower", 16, 16)
    expr(tr(follower, "ADBE Position"), 'thisComp.layer("leader").transform.position + [0, 26]')
    expr(tr(follower, "ADBE Rotate Z"), "-thisComp.layer(index + 1).rotation")
    echo = comp.add_solid(WHITE, "echo", 10, 10)
    expr(tr(echo, "ADBE Position"), 'thisComp.layer("leader").position.valueAtTime(time - 0.25)')
    expr(tr(echo, "ADBE Opacity"), 'thisComp.layer("follower").transform.opacity - 30')


@case("expr_loops", frames=(0, 8, 16, 24, 32, 40), duration=2.0)
def _(comp):
    comp.add_solid(BG, "bg")
    for i, kind in enumerate(["cycle", "pingpong", "offset", "continue"]):
        box = comp.add_solid([ORANGE, TEAL, WHITE, PINK][i], kind, 26, 14)
        tr(box, "ADBE Position").value = [24.0 + i * 37.0, 30.0, 0.0]
        keyed(tr(box, "ADBE Rotate Z"), (0.0, 0.0), (0.5, 60.0), (0.75, 30.0))
        expr(tr(box, "ADBE Rotate Z"), f'loopOut("{kind}")')
        keyed(tr(box, "ADBE Position"), (0.0, [24.0 + i * 37.0, 70.0, 0.0]), (0.5, [24.0 + i * 37.0, 100.0, 0.0]))
        expr(tr(box, "ADBE Position"), f'loopOut("{kind}")')


@case("expr_interp", frames=FRAMES)
def _(comp):
    comp.add_solid(BG, "bg")
    for i, fn in enumerate(["linear", "ease", "easeIn", "easeOut"]):
        box = comp.add_solid([ORANGE, TEAL, WHITE, PINK][i], fn, 14, 14)
        expr(tr(box, "ADBE Position"), f"[{fn}(time, 0, 0.75, 20, 140), {20 + i * 26}]")
    three = comp.add_solid(ORANGE, "three_arg", 8, 8)
    expr(tr(three, "ADBE Position"), "ease(time, [20, 115], [140, 115])")


@case("expr_parenting", frames=FRAMES)
def _(comp):
    comp.add_solid(BG, "bg")
    parent = comp.add_null()
    tr(parent, "ADBE Position").value = [60.0, 50.0, 0.0]
    keyed(tr(parent, "ADBE Rotate Z"), (0.0, 0.0), (1.0, 90.0))
    tr(parent, "ADBE Scale").value = [120.0, 80.0, 100.0]
    child = comp.add_solid(ORANGE, "child", 40, 24)
    child.parent = parent
    tr(child, "ADBE Position").value = [30.0, 10.0, 0.0]
    corner = comp.add_solid(WHITE, "corner", 6, 6)
    expr(tr(corner, "ADBE Position"), 'thisComp.layer("child").toComp([0, 0])')
    far = comp.add_solid(TEAL, "far_corner", 6, 6)
    expr(tr(far, "ADBE Position"), 'var c = thisComp.layer("child"); c.toComp([c.width, c.height])')
    back = comp.add_solid(PINK, "back", 8, 8)
    tr(back, "ADBE Position").value = [130.0, 100.0, 0.0]
    expr(tr(back, "ADBE Rotate Z"), 'var p = thisComp.layer("child").fromComp([130, 100]); p[0] + p[1]')


@case("expr_slider", frames=FRAMES)
def _(comp):
    comp.add_solid(BG, "bg")
    ctrl = comp.add_solid(TEAL, "ctrl", 20, 20)
    tr(ctrl, "ADBE Position").value = [140.0, 100.0, 0.0]
    slider = ctrl["ADBE Effect Parade"].add_property("ADBE Slider Control")
    keyed(slider["ADBE Slider Control-0001"], (0.0, 0.0), (1.0, 100.0))
    box = comp.add_solid(ORANGE, "box", 30, 20)
    own = box["ADBE Effect Parade"].add_property("ADBE Slider Control")
    own["ADBE Slider Control-0001"].value = 45.0
    expr(tr(box, "ADBE Position"), '[20 + thisComp.layer("ctrl").effect("Slider Control")("Slider") * 1.2, 40]')
    expr(tr(box, "ADBE Rotate Z"), 'effect("Slider Control")("Slider") + thisComp.layer("ctrl").effect(1)(1)')
    bar = comp.add_solid(WHITE, "bar", 100, 8)
    tr(bar, "ADBE Position").value = [70.0, 90.0, 0.0]
    expr(tr(bar, "ADBE Scale"), '[thisComp.layer("ctrl").effect("Slider Control").param("Slider"), 100]')


@case("expr_paths", frames=(0, 12))
def _(comp):
    comp.add_solid(BG, "bg")
    shape = comp.add_shape()
    shape.name = "tri"
    group = shape_group(shape, "tri")
    path = add(group, "ADBE Vector Shape - Group")
    expr(
        path["ADBE Vector Shape"],
        "var s = 30 + time * 20; createPath([[-s, s * 0.6], [0, -s], [s, s * 0.6]], [], [], true)",
    )
    fill(group, ORANGE)
    stroke(group, WHITE, 3.0)
    gtr(group, "ADBE Vector Position", [-30.0, 0.0])
    masked = comp.add_solid(TEAL, "masked", 60, 60)
    tr(masked, "ADBE Position").value = [120.0, 60.0, 0.0]
    mask = add_mask(masked, rect(0, 0, 60, 60))
    expr(
        mask["ADBE Mask Shape"],
        "createPath([[30, 5], [55, 30 + time * 20], [30, 55], [5, 30]], [[0, 0], [0, -10], [0, 0], [0, 10]], [[0, 0], [0, 10], [0, 0], [0, -10]], true)",
    )


@case("expr_posterize", frames=(0, 3, 6, 9, 12, 15, 18, 21))
def _(comp):
    comp.add_solid(BG, "bg")
    box = comp.add_solid(ORANGE, "box", 20, 20)
    expr(tr(box, "ADBE Position"), "posterizeTime(4); [20 + time * 120, 40]")
    keyed_box = comp.add_solid(TEAL, "keyed", 20, 20)
    keyed(tr(keyed_box, "ADBE Position"), (0.0, [20.0, 85.0, 0.0]), (1.0, [140.0, 85.0, 0.0]))
    expr(tr(keyed_box, "ADBE Position"), "posterizeTime(6); value")


@case("expr_errors", frames=(0, 12))
def _(comp):
    comp.add_solid(BG, "bg")
    box = comp.add_solid(ORANGE, "missing_layer", 30, 20)
    tr(box, "ADBE Position").value = [40.0, 40.0, 0.0]
    expr(tr(box, "ADBE Position"), 'thisComp.layer("nope").position')
    other = comp.add_solid(TEAL, "runtime_error", 30, 20)
    tr(other, "ADBE Position").value = [110.0, 80.0, 0.0]
    tr(other, "ADBE Rotate Z").value = 20.0
    expr(tr(other, "ADBE Rotate Z"), "undefinedFunction(1)")
    fine = comp.add_solid(WHITE, "still_runs", 16, 16)
    expr(tr(fine, "ADBE Position"), "[40 + time * 60, 90]")


# --- probes -------------------------------------------------------------------------


def api_setup(comp):
    k = comp.add_solid(ORANGE, "K", 30, 20)
    keyed(tr(k, "ADBE Position"), (0.0, [20.0, 30.0, 0.0]), (0.5, [100.0, 50.0, 0.0]), (1.0, [140.0, 90.0, 0.0]))
    keyed(tr(k, "ADBE Rotate Z"), (0.0, 0.0), (0.5, 90.0), (1.0, 45.0))
    sl = k["ADBE Effect Parade"].add_property("ADBE Slider Control")
    keyed(sl["ADBE Slider Control-0001"], (0.0, 0.0), (1.0, 100.0))
    pt = k["ADBE Effect Parade"].add_property("ADBE Point Control")
    pt["ADBE Point Control-0001"].value = [12.0, 34.0]
    ang = k["ADBE Effect Parade"].add_property("ADBE Angle Control")
    ang["ADBE Angle Control-0001"].value = 33.0
    col = k["ADBE Effect Parade"].add_property("ADBE Color Control")
    col["ADBE Color Control-0001"].value = [0.25, 0.5, 0.75, 1.0]
    chk = k["ADBE Effect Parade"].add_property("ADBE Checkbox Control")
    chk["ADBE Checkbox Control-0001"].value = 1.0
    add_mask(k, rect(2, 3, 25, 18), opacity=60.0, feather=4.0)
    k2 = comp.add_solid(TEAL, "K2", 10, 10)
    keyed(tr(k2, "ADBE Position"), (0.0, [10.0, 10.0, 0.0]), (1.0, [50.0, 10.0, 0.0]))
    expr(tr(k2, "ADBE Position"), "value + [time * 100, 0]")
    parent = comp.add_null()
    parent.name = "P"
    tr(parent, "ADBE Position").value = [40.0, 30.0, 0.0]
    tr(parent, "ADBE Rotate Z").value = 30.0
    tr(parent, "ADBE Scale").value = [150.0, 150.0, 100.0]
    child = comp.add_solid(WHITE, "C", 20, 20)
    child.parent = parent
    tr(child, "ADBE Position").value = [20.0, 10.0, 0.0]
    deep = comp.add_solid(PINK, "D", 20, 20)
    deep.three_d_layer = True
    tr(deep, "ADBE Position").value = [80.0, 60.0, 50.0]
    tr(deep, "ADBE Rotate Y").value = 30.0
    shape = comp.add_shape()
    shape.name = "S"
    group = shape_group(shape, "G")
    r = add(group, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [40.0, 20.0]})
    r.name = "R"
    fill(group, ORANGE)
    stroke(group, WHITE, 4.0)
    gtr(group, "ADBE Vector Position", [5.0, -3.0])
    gtr(group, "ADBE Vector Rotation", 10.0)


K = 'thisComp.layer("K")'
C = 'thisComp.layer("C")'
D = 'thisComp.layer("D")'
S = 'thisComp.layer("S")'
API_CELLS = [
    ("time", "time"),
    ("K position x", f"{K}.position[0]"),
    ("K position y", f"{K}.transform.position[1]"),
    ("K position velocity x", f"{K}.position.velocity[0]"),
    ("K position speed", f"{K}.position.speed"),
    ("K rotation velocity", f"{K}.rotation.velocity"),
    ("K velocityAtTime(0.25) x", f"{K}.position.velocityAtTime(0.25)[0]"),
    ("K speedAtTime(0.75)", f"{K}.position.speedAtTime(0.75)"),
    ("K valueAtTime(time - 0.2) y", f"{K}.position.valueAtTime(time - 0.2)[1]"),
    ("K valueAtTime(0.3) x", f"{K}.position.valueAtTime(0.3)[0]"),
    ("K numKeys", f"{K}.position.numKeys"),
    ("K key(2).time", f"{K}.rotation.key(2).time"),
    ("K key(3).value", f"{K}.rotation.key(3).value"),
    ("K key(2).value y", f"{K}.position.key(2).value[1]"),
    ("K nearestKey(time).index", f"{K}.rotation.nearestKey(time).index"),
    ("K nearestKey(time).time", f"{K}.rotation.nearestKey(time).time"),
    ("K smooth x", f"{K}.position.smooth(0.2, 5)[0]"),
    ("K slider", f'{K}.effect("Slider Control")("Slider")'),
    ("K effect(1)(1)", f"{K}.effect(1)(1)"),
    ("K param", f'{K}.effect("Slider Control").param("Slider")'),
    ("K slider velocity", f'{K}.effect("Slider Control")("Slider").velocity'),
    ("K point y", f'{K}.effect("Point Control")("Point")[1]'),
    ("K angle", f'{K}.effect("Angle Control")("Angle")'),
    ("K color b", f'{K}.effect("Color Control")("Color")[2]'),
    ("K checkbox", f'{K}.effect("Checkbox Control")("Checkbox")'),
    ("K mask opacity", f'{K}.mask("Mask 1").maskOpacity'),
    ("K mask feather", f'{K}.mask(1).maskFeather[0]'),
    ("K mask expansion", f'{K}.mask("Mask 1").maskExpansion'),
    ("K mask point x", f'{K}.mask("Mask 1").maskPath.points()[1][0]'),
    ("K mask closed", f'{K}.mask(1).maskPath.isClosed() ? 1 : 0'),
    ("K2 post-expression x", 'thisComp.layer("K2").position[0]'),
    ("K2 valueAtTime(0.5) x", 'thisComp.layer("K2").position.valueAtTime(0.5)[0]'),
    ("K2 velocity x", 'thisComp.layer("K2").position.velocity[0]'),
    ("C toComp x", f"{C}.toComp([0, 0])[0]"),
    ("C toComp y", f"{C}.toComp([0, 0])[1]"),
    ("C toComp anchor x", f"{C}.toComp({C}.anchorPoint)[0]"),
    ("C fromComp x", f"{C}.fromComp([80, 60])[0]"),
    ("C fromComp y", f"{C}.fromComp([80, 60])[1]"),
    ("C toCompVec x", f"{C}.toCompVec([10, 0])[0]"),
    ("C toCompVec y", f"{C}.toCompVec([10, 0])[1]"),
    ("C fromCompVec x", f"{C}.fromCompVec([10, 0])[0]"),
    ("C toWorld y", f"{C}.toWorld([5, 5])[1]"),
    ("C hasParent", f"{C}.hasParent ? 1 : 0"),
    ("C parent.index", f"{C}.parent.index"),
    ("D toComp x", f"{D}.toComp([0, 0, 0])[0]"),
    ("D toComp y", f"{D}.toComp([0, 0, 0])[1]"),
    ("D toWorld z", f"{D}.toWorld([0, 0, 0])[2]"),
    ("lookAt x", "lookAt([0, 0, 0], [100, 50, 200])[0]"),
    ("lookAt y", "lookAt([0, 0, 0], [100, 50, 200])[1]"),
    ("lookAt z", "lookAt([0, 0, 0], [100, 50, 200])[2]"),
    ("S sourceRect left", f"{S}.sourceRectAtTime().left"),
    ("S sourceRect top", f"{S}.sourceRectAtTime().top"),
    ("S sourceRect width", f"{S}.sourceRectAtTime().width"),
    ("S sourceRect height", f"{S}.sourceRectAtTime().height"),
    ("S sourceRect extents width", f"{S}.sourceRectAtTime(time, true).width"),
    ("C sourceRect width", f"{C}.sourceRectAtTime().width"),
    ("S content size", f'{S}.content("G").content("R").size[0]'),
    ("S group position", f'{S}.content("G").transform.position[0]'),
    ("S group rotation", f'{S}.content("G").transform.rotation'),
    ("numLayers", "thisComp.numLayers"),
    ("comp width", "thisComp.width + thisComp.height / 1000"),
    ("frameDuration", "thisComp.frameDuration * 1000"),
    ("comp duration", "thisComp.duration"),
    ("thisLayer.index", "thisLayer.index"),
    ("K index", f"{K}.index"),
    ("K inPoint/outPoint", f"{K}.inPoint + {K}.outPoint * 10"),
    ("K width", f"{K}.width + {K}.height / 1000"),
    ("K rotation propertyIndex", f"{K}.rotation.propertyIndex"),
    ("own propertyIndex", "thisProperty.propertyIndex"),
    ("group propertyIndex", "thisProperty.propertyGroup(1).propertyIndex"),
    ("own value alpha", "value[3] + value.length * 10"),
    ("timeToFrames()", "timeToFrames()"),
    ("timeToFrames(time, 30)", "timeToFrames(time + 0.01, 30)"),
    ("framesToTime(30)", "framesToTime(30)"),
    ("posterizeTime(5)", "time * 1000", "posterizeTime(5);"),
    ("degreesToRadians", "degreesToRadians(30) * 1000"),
    ("radiansToDegrees", "radiansToDegrees(1)"),
    ("hslToRgb r", "hslToRgb([0.3, 0.5, 0.4, 1])[0] * 1000"),
    ("rgbToHsl h", "rgbToHsl([0.2, 0.4, 0.6, 1])[0] * 1000"),
    ("rgbToHsl s", "rgbToHsl([0.9, 0.4, 0.1, 1])[1] * 1000"),
    ("hexToRgb g", 'hexToRgb("#3366CC")[1] * 1000'),
    ("normalize", "normalize([3, 4])[0] * 1000"),
    ("length 3D", "length([3, 4, 12])"),
    ("length 2 args", "length([1, 2], [4, 6])"),
    ("dot", "dot([1, 2, 3], [4, 5, 6])"),
    ("cross x", "cross([1, 2, 3], [4, 5, 6])[0]"),
    ("clamp reversed limits", "clamp(5, 10, 0)"),
    ("clamp vector", "clamp([5, 50], 0, 10)[1]"),
    ("Math", "Math.atan2(1, 2) * 1000 + Math.hypot(3, 4)"),
]

js.probe("expr_probe_api", API_CELLS, setup=api_setup, frames=(0, 5, 10, 15, 20))

OPS_CELLS = [
    ("[1,2]+5 [0]", "([1, 2] + 5)[0]"),
    ("[1,2]+5 [1]", "([1, 2] + 5)[1]"),
    ("5+[1,2] [0]", "(5 + [1, 2])[0]"),
    ("5+[1,2] [1]", "(5 + [1, 2])[1]"),
    ("[1,2]-5 [1]", "([1, 2] - 5)[1]"),
    ("5-[1,2] [0]", "(5 - [1, 2])[0]"),
    ("5-[1,2] [1]", "(5 - [1, 2])[1]"),
    ("[1,2,3]+[10,20] length", "([1, 2, 3] + [10, 20]).length"),
    ("[1,2,3]+[10,20] [2]", "([1, 2, 3] + [10, 20])[2]"),
    ("[1,2]+[10,20,30] length", "([1, 2] + [10, 20, 30]).length"),
    ("[1,2]+[10,20,30] [2]", "([1, 2] + [10, 20, 30])[2]"),
    ("[1,2,3]-[10,20] [2]", "([1, 2, 3] - [10, 20])[2]"),
    ("[2,3]*[4,5] [1]", "([2, 3] * [4, 5])[1]"),
    ("[10,20]/[2,4] [1]", "([10, 20] / [2, 4])[1]"),
    ("[1,2]*3 [1]", "([1, 2] * 3)[1]"),
    ("3*[1,2] [1]", "(3 * [1, 2])[1]"),
    ("[4,6]/2 [1]", "([4, 6] / 2)[1]"),
    ("6/[2,3]", "(6 / [2, 3])[0]"),
    ("-[1,2] [1]", "(-[1, 2])[1]"),
    ("[1,2]+=[3,4]", "a[1]", "var a = [1, 2]; a += [3, 4];"),
    ("[1,2]*=2", "a[1]", "var a = [1, 2]; a *= 2;"),
    ("add()", "add([1, 2], [3, 4])[1]"),
    ("sub()", "sub([5, 5], [1, 2])[1]"),
    ("mul()", "mul([1, 2], 3)[1]"),
    ("div()", "div([4, 6], 2)[0]"),
    ("add(vector, scalar)", "add([1, 2], 5)[1]"),
    ("[1,2]%2", "([3, 5] % 2) === 1 ? 1 : 0"),
    ("ease 0.1", "ease(0.1, 0, 1, 0, 1000)"),
    ("ease 0.25", "ease(0.25, 0, 1, 0, 1000)"),
    ("ease 0.5", "ease(0.5, 0, 1, 0, 1000)"),
    ("ease 0.75", "ease(0.75, 0, 1, 0, 1000)"),
    ("ease 0.9", "ease(0.9, 0, 1, 0, 1000)"),
    ("easeIn 0.1", "easeIn(0.1, 0, 1, 0, 1000)"),
    ("easeIn 0.25", "easeIn(0.25, 0, 1, 0, 1000)"),
    ("easeIn 0.5", "easeIn(0.5, 0, 1, 0, 1000)"),
    ("easeIn 0.75", "easeIn(0.75, 0, 1, 0, 1000)"),
    ("easeIn 0.9", "easeIn(0.9, 0, 1, 0, 1000)"),
    ("easeOut 0.1", "easeOut(0.1, 0, 1, 0, 1000)"),
    ("easeOut 0.25", "easeOut(0.25, 0, 1, 0, 1000)"),
    ("easeOut 0.5", "easeOut(0.5, 0, 1, 0, 1000)"),
    ("easeOut 0.75", "easeOut(0.75, 0, 1, 0, 1000)"),
    ("easeOut 0.9", "easeOut(0.9, 0, 1, 0, 1000)"),
    ("ease 3-arg", "ease(0.25, 0, 1000)"),
    ("easeIn 3-arg", "easeIn(0.25, 0, 1000)"),
    ("linear", "linear(0.3, 0, 1, 0, 1000)"),
    ("linear reversed range", "linear(0.3, 1, 0, 0, 1000)"),
    ("linear tMin>tMax", "linear(0.3, 0.5, 0, 10, 20)"),
    ("linear below", "linear(-1, 0, 1, 5, 10)"),
    ("linear above", "linear(2, 0, 1, 5, 10)"),
    ("ease vector", "ease(0.25, 0, 1, [0, 0], [100, 1000])[1]"),
    ("ease time", "ease(time, 0, 1, 0, 1000)"),
    ("easeOut time", "easeOut(time, 0.2, 0.8, 0, 1000)"),
]

js.probe("expr_probe_ops", OPS_CELLS, frames=(0, 6, 12, 18))


def coerce_setup(comp):
    def layer(name, three_d=False):
        s = comp.add_solid(TEAL, name, 4, 4)
        tr(s, "ADBE Position").value = [150.0, 110.0, 0.0]
        tr(s, "ADBE Rotate Z").value = 5.0
        if three_d:
            s.three_d_layer = True
        return s

    expr(tr(layer("X1"), "ADBE Rotate Z"), "[30]")
    expr(tr(layer("X2"), "ADBE Position"), "[50, 60, 70]")
    expr(tr(layer("X3", True), "ADBE Position"), "[50, 60]")
    expr(tr(layer("X4"), "ADBE Position"), "100")
    expr(tr(layer("X5"), "ADBE Opacity"), "150")
    expr(tr(layer("X6"), "ADBE Opacity"), "-20")
    expr(tr(layer("X7"), "ADBE Scale"), "50")
    expr(tr(layer("X8"), "ADBE Rotate Z"), '"12"')
    expr(tr(layer("X9"), "ADBE Rotate Z"), "true")
    expr(tr(layer("X10"), "ADBE Rotate Z"), "0 / 0")
    expr(tr(layer("X11"), "ADBE Rotate Z"), "undefinedThing")
    expr(tr(layer("X12"), "ADBE Rotate Z"), "[1, 2]")
    expr(tr(layer("X13"), "ADBE Rotate Z"), 'thisComp.layer("X14").rotation + 1')
    expr(tr(layer("X14"), "ADBE Rotate Z"), 'thisComp.layer("X13").rotation + 1')
    x15 = layer("X15")
    keyed(tr(x15, "ADBE Rotate Z"), (0.0, 0.0), (1.0, 100.0))
    expr(tr(x15, "ADBE Rotate Z"), "valueAtTime(1) + 1")
    expr(tr(layer("X16"), "ADBE Rotate Z"), "var r = 7")
    expr(tr(layer("X17"), "ADBE Rotate Z"), "function f() { return 3 }")
    expr(tr(layer("X18"), "ADBE Rotate Z"), "if (time < 0.5) 11; else 22")
    expr(tr(layer("X19"), "ADBE Rotate Z"), "thisProperty")
    expr(tr(layer("X20"), "ADBE Rotate Z"), "Infinity")
    expr(tr(layer("X21"), "ADBE Rotate Z"), "for (var i = 0; i < 3; i++) i * 10")
    x22 = layer("X22", True)
    expr(tr(x22, "ADBE Scale"), "[50, 60]")
    expr(tr(layer("X23"), "ADBE Scale"), "[50, 60, 70]")
    expr(tr(layer("X24"), "ADBE Anchor Point"), "[1, 2, 3]")


def x(name, path):
    return f'thisComp.layer("{name}").{path}'


COERCE_CELLS = [
    ("rotation = [30]", x("X1", "rotation")),
    ("2D position = 3 values: x", x("X2", "position[0]")),
    ("2D position = 3 values: length", x("X2", "position.value.length")),
    ("3D position = 2 values: x", x("X3", "position[0]")),
    ("3D position = 2 values: z", x("X3", "position[2]")),
    ("position = 100: x", x("X4", "position[0]")),
    ("position = 100: y", x("X4", "position[1]")),
    ("opacity = 150", x("X5", "opacity")),
    ("opacity = -20", x("X6", "opacity")),
    ("scale = 50: x", x("X7", "scale[0]")),
    ("scale = 50: y", x("X7", "scale[1]")),
    ('rotation = "12"', x("X8", "rotation")),
    ("rotation = true", x("X9", "rotation")),
    ("rotation = NaN", x("X10", "rotation")),
    ("rotation = undefined name", x("X11", "rotation")),
    ("rotation = [1, 2]", x("X12", "rotation")),
    ("cycle a", x("X13", "rotation")),
    ("cycle b", x("X14", "rotation")),
    ("valueAtTime on itself", x("X15", "rotation")),
    ("ends in var declaration", x("X16", "rotation")),
    ("ends in function declaration", x("X17", "rotation")),
    ("if/else completion", x("X18", "rotation")),
    ("result is thisProperty", x("X19", "rotation")),
    ("rotation = Infinity", x("X20", "rotation")),
    ("for loop completion", x("X21", "rotation")),
    ("3D scale = 2 values: z", x("X22", "scale[2]")),
    ("2D scale = 3 values: length", x("X23", "scale.value.length")),
    ("2D anchor = 3 values: x", x("X24", "anchorPoint[0]")),
    ("2D position via toComp", x("X2", "toComp([0, 0])[0]")),
]

js.probe("expr_probe_coerce", COERCE_CELLS, setup=coerce_setup, frames=(0, 12))


def loop_setup(comp):
    keys = ((0.0, 0.0), (0.5, 90.0), (1.0, 30.0))
    for name, source in [
        ("L1", 'loopOut("cycle")'),
        ("L2", 'loopOut("pingpong")'),
        ("L3", 'loopOut("offset")'),
        ("L4", 'loopOut("continue")'),
        ("L5", 'loopOut("cycle", 1)'),
        ("L6", 'loopOutDuration("cycle", 0.25)'),
        ("L7", 'loopOut("pingpong", 1)'),
        ("L8", 'loopOut()'),
    ]:
        s = comp.add_solid(TEAL, name, 4, 4)
        tr(s, "ADBE Position").value = [150.0, 110.0, 0.0]
        keyed(tr(s, "ADBE Rotate Z"), *keys)
        expr(tr(s, "ADBE Rotate Z"), source)
    for name, source in [("L9", 'loopIn("cycle")'), ("L10", 'loopIn("pingpong")'), ("L11", 'loopIn("offset")'), ("L12", 'loopIn("continue")')]:
        s = comp.add_solid(TEAL, name, 4, 4)
        tr(s, "ADBE Position").value = [150.0, 110.0, 0.0]
        keyed(tr(s, "ADBE Rotate Z"), (1.0, 0.0), (1.5, 90.0), (2.0, 30.0))
        expr(tr(s, "ADBE Rotate Z"), source)
    p = comp.add_solid(TEAL, "L13", 4, 4)
    keyed(tr(p, "ADBE Position"), (0.0, [20.0, 20.0, 0.0]), (0.5, [140.0, 100.0, 0.0]))
    expr(tr(p, "ADBE Position"), 'loopOut("pingpong")')
    q = comp.add_solid(TEAL, "L14", 4, 4)
    keyed(tr(q, "ADBE Position"), (0.0, [20.0, 20.0, 0.0]), (0.5, [140.0, 100.0, 0.0]))
    expr(tr(q, "ADBE Position"), 'loopOut("continue")')


LOOP_CELLS = [(f"L{i} rotation", x(f"L{i}", "rotation")) for i in range(1, 13)] + [
    ("L13 pingpong x", x("L13", "position[0]")),
    ("L13 pingpong y", x("L13", "position[1]")),
    ("L14 continue x", x("L14", "position[0]")),
]

js.probe("expr_probe_loops", LOOP_CELLS, setup=loop_setup, frames=tuple(range(0, 48, 4)), duration=2.0)

js.save()

# =====================================================================================
# Legacy ExtendScript engine
# =====================================================================================

legacy = ProbeSuite(Suite("expr_legacy"), "extendscript")


@legacy.suite.case("expr_legacy_transform", frames=FRAMES)
def _(comp):
    comp.add_solid(BG, "bg")
    box = comp.add_solid(ORANGE, "box", 40, 30)
    expr(tr(box, "ADBE Position"), "[80 + Math.sin(time * 6) * 40, 60] + [0, time * 20]")
    expr(tr(box, "ADBE Rotate Z"), "this_comp.layer(1).index * 10 + time * 90")
    other = comp.add_solid(TEAL, "other", 20, 20)
    expr(tr(other, "ADBE Position"), 'this_comp.layer("box").position - [0, 30]')


def legacy_setup(comp):
    k = comp.add_solid(ORANGE, "K", 30, 20)
    keyed(tr(k, "ADBE Position"), (0.0, [20.0, 30.0, 0.0]), (1.0, [140.0, 90.0, 0.0]))


LEGACY_CELLS = [
    ("time", "time"),
    ("this_comp", "this_comp.numLayers"),
    ("this_layer.index", "this_layer.index"),
    ("this.index", "this.index"),
    ("thisComp.layer", 'thisComp.layer("K").position[0]'),
    ("[1,2]+5", "([1, 2] + 5)[1]"),
    ("value * 2", "(value * 2)[3]"),
    ("ease", "ease(0.25, 0, 1, 0, 1000)"),
    ("linear", 'linear(time, 0, 1, 0, thisComp.layer("K").position[1])'),
    ("velocity", 'thisComp.layer("K").position.velocity[0]'),
    ("toComp", 'thisComp.layer("K").toComp([0, 0])[0]'),
]

legacy.probe("expr_legacy_probe", LEGACY_CELLS, setup=legacy_setup, frames=(0, 12))
legacy.save()

# =====================================================================================
# AE's random generators (measured, never counted)
# =====================================================================================

rnd = ProbeSuite(Suite("expr_random"), "javascript-1.0", manifest=False)
RANDOM_CELLS = (
    [(f"random() #{i}", "random() * 1000") for i in range(32)]
    + [(f"gaussRandom() #{i}", "gaussRandom() * 1000") for i in range(16)]
    + [(f"seedRandom(1, true) #{i}", "random() * 1000", "seedRandom(1, true);") for i in range(16)]
    + [(f"wiggle(2, 1000) #{i}", "wiggle(2, 1000)[0]") for i in range(32)]
    + [(f"noise({i * 0.37:.2f})", f"noise({i * 0.37:.2f}) * 1000") for i in range(32)]
    + [(f"noise([{i * 0.29:.2f}, 0.5])", f"noise([{i * 0.29:.2f}, 0.5]) * 1000") for i in range(16)]
)
rnd.probe("expr_random_cells", RANDOM_CELLS, frames=tuple(range(0, 24, 3)), random=True)
rnd.save()
