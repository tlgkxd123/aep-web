# Builds refs/fixtures/fixtures.aep: one small composition per renderer feature,
# authored with py-aep (MIT, https://github.com/forticheprod/py-aep) on top of an
# AE 25.6 project that uses After Effects' default color settings (8 bpc, no
# working space, no linearization), so After Effects 2025 can open and render it.
# Also writes refs/fixtures/manifest.json listing each comp and the frames to render.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_fixtures.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import (  # noqa: E402
    BG,
    DUR,
    FPS,
    H,
    ORANGE,
    TEAL,
    W,
    BlendingMode,
    MaskMode,
    Shape,
    Suite,
    TrackMatteType,
    add,
    add_mask,
    fill,
    gtr,
    rect,
    shape_comp,
    shape_group,
    stroke,
    tr,
)

suite = Suite("fixtures", project_file="fixtures.aep", manifest_file="manifest.json")
case = suite.case
folder = suite.folder


@case("solid_basic")
def _(comp):
    comp.add_solid(BG, "bg")
    comp.add_solid(ORANGE, "box", 80, 60)


@case("solid_offset")
def _(comp):
    s = comp.add_solid(ORANGE, "box", 80, 60)
    tr(s, "ADBE Position").value = [30.0, 25.0, 0.0]


@case("transform_rotate")
def _(comp):
    comp.add_solid(BG, "bg")
    s = comp.add_solid(ORANGE, "box", 90, 40)
    tr(s, "ADBE Rotate Z").value = 30.0


@case("transform_scale_anchor")
def _(comp):
    comp.add_solid(BG, "bg")
    s = comp.add_solid(ORANGE, "box", 60, 40)
    tr(s, "ADBE Anchor Point").value = [0.0, 0.0, 0.0]
    tr(s, "ADBE Scale").value = [150.0, 50.0, 100.0]
    tr(s, "ADBE Rotate Z").value = -15.0


@case("opacity")
def _(comp):
    comp.add_solid(BG, "bg")
    comp.add_solid(TEAL, "under", 100, 70)
    s = comp.add_solid(ORANGE, "over", 70, 50)
    tr(s, "ADBE Position").value = [100.0, 70.0, 0.0]
    tr(s, "ADBE Opacity").value = 50.0


@case("parent")
def _(comp):
    comp.add_solid(BG, "bg")
    parent = comp.add_null()
    tr(parent, "ADBE Position").value = [60.0, 50.0, 0.0]
    tr(parent, "ADBE Rotate Z").value = 45.0
    tr(parent, "ADBE Scale").value = [70.0, 70.0, 100.0]
    child = comp.add_solid(ORANGE, "child", 50, 30)
    child.parent = parent
    tr(child, "ADBE Position").value = [40.0, 0.0, 0.0]


@case("anim_position", frames=(0, 6, 12, 18))
def _(comp):
    comp.add_solid(BG, "bg")
    s = comp.add_solid(ORANGE, "box", 30, 30)
    pos = tr(s, "ADBE Position")
    pos.set_value_at_time(0.0, [20.0, 20.0, 0.0])
    pos.set_value_at_time(0.75, [140.0, 100.0, 0.0])


@case("anim_rotation_opacity", frames=(0, 6, 12, 18))
def _(comp):
    comp.add_solid(BG, "bg")
    s = comp.add_solid(ORANGE, "box", 70, 30)
    rot = tr(s, "ADBE Rotate Z")
    rot.set_value_at_time(0.0, 0.0)
    rot.set_value_at_time(0.75, 120.0)
    op = tr(s, "ADBE Opacity")
    op.set_value_at_time(0.0, 100.0)
    op.set_value_at_time(0.75, 20.0)


BLEND_MODES = [
    "ADD", "MULTIPLY", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN", "DIFFERENCE", "SOFT_LIGHT",
    "HARD_LIGHT", "COLOR_DODGE", "COLOR_BURN", "LINEAR_BURN", "LINEAR_DODGE", "EXCLUSION",
    "SUBTRACT", "DIVIDE", "HUE", "SATURATION", "COLOR", "LUMINOSITY",
]

for mode in BLEND_MODES:

    @case(f"blend_{mode.lower()}")
    def _(comp, mode=mode):
        left = comp.add_solid([0.85, 0.35, 0.2], "left", 80, 120)
        tr(left, "ADBE Position").value = [40.0, 60.0, 0.0]
        right = comp.add_solid([0.2, 0.55, 0.9], "right", 80, 120)
        tr(right, "ADBE Position").value = [120.0, 60.0, 0.0]
        top = comp.add_solid([0.55, 0.75, 0.3], "top", 110, 60)
        top.blending_mode = getattr(BlendingMode, mode)
        tr(top, "ADBE Opacity").value = 80.0


for matte, kind in [
    ("alpha", TrackMatteType.ALPHA),
    ("alpha_inverted", TrackMatteType.ALPHA_INVERTED),
    ("luma", TrackMatteType.LUMA),
    ("luma_inverted", TrackMatteType.LUMA_INVERTED),
]:

    @case(f"matte_{matte}")
    def _(comp, kind=kind):
        comp.add_solid(BG, "bg")
        content = comp.add_solid(ORANGE, "content", 120, 90)
        matte_layer = comp.add_solid([0.6, 0.6, 0.6], "matte", 70, 50)
        tr(matte_layer, "ADBE Position").value = [95.0, 55.0, 0.0]
        tr(matte_layer, "ADBE Rotate Z").value = 20.0
        content.set_track_matte(matte_layer, kind)


for mode in ["ADD", "SUBTRACT", "INTERSECT", "LIGHTEN", "DARKEN", "DIFFERENCE"]:

    @case(f"mask_{mode.lower()}")
    def _(comp, mode=mode):
        comp.add_solid(BG, "bg")
        s = comp.add_solid(ORANGE, "masked", 120, 90)
        add_mask(s, rect(10, 10, 80, 60), MaskMode.ADD, opacity=80.0)
        add_mask(s, rect(40, 30, 110, 80), getattr(MaskMode, mode), opacity=60.0)


@case("mask_inverted")
def _(comp):
    comp.add_solid(BG, "bg")
    s = comp.add_solid(ORANGE, "masked", 120, 90)
    add_mask(s, rect(20, 15, 100, 75), inverted=True)


@case("mask_bezier")
def _(comp):
    comp.add_solid(BG, "bg")
    s = comp.add_solid(ORANGE, "masked", 120, 90)
    mask = s["ADBE Mask Parade"].add_property("ADBE Mask Atom")
    mask["ADBE Mask Shape"].value = Shape(
        [[60, 5], [115, 45], [60, 85], [5, 45]],
        [[-30, 0], [0, -25], [30, 0], [0, 25]],
        [[30, 0], [0, 25], [-30, 0], [0, -25]],
        closed=True,
    )


@case("mask_feather")
def _(comp):
    comp.add_solid(BG, "bg")
    s = comp.add_solid(ORANGE, "masked", 120, 90)
    add_mask(s, rect(25, 20, 95, 70), feather=12.0)


@case("precomp", frames=(0, 12))
def _(comp):
    inner = folder.add_comp("precomp_inner", 80, 60, 1.0, DUR, FPS)
    inner.add_solid(TEAL, "inner_bg")
    box = inner.add_solid(ORANGE, "inner_box", 30, 20)
    pos = tr(box, "ADBE Position")
    pos.set_value_at_time(0.0, [10.0, 10.0, 0.0])
    pos.set_value_at_time(0.5, [70.0, 50.0, 0.0])
    comp.add_solid(BG, "bg")
    layer = comp.add(inner)
    layer.start_time = 0.25
    tr(layer, "ADBE Rotate Z").value = 10.0


@case("three_d_default_camera")
def _(comp):
    comp.add_solid(BG, "bg")
    s = comp.add_solid(ORANGE, "card", 80, 60)
    s.three_d_layer = True
    tr(s, "ADBE Rotate Y").value = 40.0
    tr(s, "ADBE Position").value = [80.0, 60.0, 50.0]


@case("three_d_camera")
def _(comp):
    comp.add_solid(BG, "bg")
    s = comp.add_solid(ORANGE, "card", 80, 60)
    s.three_d_layer = True
    tr(s, "ADBE Rotate X").value = 25.0
    camera = comp.add_camera("cam", [80.0, 60.0])
    tr(camera, "ADBE Position").value = [140.0, 20.0, -220.0]


# --- Shape layers ----------------------------------------------------------


@case("shape_rect")
def _(comp):
    g = shape_group(shape_comp(comp))
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [80.0, 50.0]})
    fill(g, ORANGE)


@case("shape_rect_round_stroke")
def _(comp):
    g = shape_group(shape_comp(comp))
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [90.0, 60.0], "ADBE Vector Rect Roundness": 14.0})
    stroke(g, TEAL, 6.0)
    fill(g, ORANGE)


@case("shape_ellipse_stroke")
def _(comp):
    g = shape_group(shape_comp(comp))
    add(g, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [100.0, 64.0]})
    stroke(g, TEAL, 8.0)
    fill(g, ORANGE)


@case("shape_star")
def _(comp):
    g = shape_group(shape_comp(comp))
    add(
        g,
        "ADBE Vector Shape - Star",
        **{"ADBE Vector Star Points": 5.0, "ADBE Vector Star Outer Radius": 50.0, "ADBE Vector Star Inner Radius": 22.0},
    )
    stroke(g, TEAL, 3.0)
    fill(g, ORANGE)


@case("shape_polygon_round")
def _(comp):
    g = shape_group(shape_comp(comp))
    add(
        g,
        "ADBE Vector Shape - Star",
        **{
            "ADBE Vector Star Type": 2.0,
            "ADBE Vector Star Points": 6.0,
            "ADBE Vector Star Outer Radius": 48.0,
            "ADBE Vector Star Rotation": 15.0,
            "ADBE Vector Star Outer Roundess": 40.0,
        },
    )
    fill(g, ORANGE)


@case("shape_path_open")
def _(comp):
    g = shape_group(shape_comp(comp))
    add(
        g,
        "ADBE Vector Shape - Group",
        **{
            "ADBE Vector Shape": Shape(
                [[-60, 20], [-10, -35], [55, 25]], [[0, 0], [-30, 0], [0, -40]], [[20, -40], [30, 0], [0, 0]], closed=False
            )
        },
    )
    stroke(g, ORANGE, 7.0, **{"ADBE Vector Stroke Line Cap": 2.0, "ADBE Vector Stroke Line Join": 2.0})


@case("shape_group_transform")
def _(comp):
    layer = shape_comp(comp)
    outer = shape_group(layer)
    gtr(outer, "ADBE Vector Position", [-20.0, 5.0])
    gtr(outer, "ADBE Vector Rotation", 20.0)
    inner = shape_group(outer)
    add(inner, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [60.0, 40.0]})
    fill(inner, ORANGE)
    gtr(inner, "ADBE Vector Scale", [120.0, 70.0])
    gtr(inner, "ADBE Vector Skew", 20.0)
    gtr(inner, "ADBE Vector Skew Axis", 30.0)
    gtr(inner, "ADBE Vector Group Opacity", 80.0)
    # AE ignores static shape-item positions py-aep writes, so items are placed with group transforms.
    dot = shape_group(outer)
    gtr(dot, "ADBE Vector Position", [45.0, 0.0])
    add(dot, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [40.0, 40.0]})
    fill(outer, TEAL)


@case("shape_trim")
def _(comp):
    g = shape_group(shape_comp(comp))
    add(g, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [90.0, 90.0]})
    stroke(g, ORANGE, 10.0)
    add(g, "ADBE Vector Filter - Trim", **{"ADBE Vector Trim Start": 10.0, "ADBE Vector Trim End": 70.0, "ADBE Vector Trim Offset": 30.0})


@case("shape_repeater")
def _(comp):
    g = shape_group(shape_comp(comp))
    arm = shape_group(g)
    gtr(arm, "ADBE Vector Position", [32.0, 0.0])
    add(arm, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [30.0, 14.0]})
    fill(g, ORANGE)
    rep = add(g, "ADBE Vector Filter - Repeater", **{"ADBE Vector Repeater Copies": 6.0})
    t = rep["ADBE Vector Repeater Transform"]
    t["ADBE Vector Repeater Rotation"].value = 40.0
    t["ADBE Vector Repeater Scale"].value = [88.0, 88.0]
    t["ADBE Vector Repeater Opacity 2"].value = 30.0


@case("shape_gradient_linear")
def _(comp):
    g = shape_group(shape_comp(comp))
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [120.0, 80.0]})
    add(g, "ADBE Vector Graphic - G-Fill", **{"ADBE Vector Grad Start Pt": [-60.0, 0.0], "ADBE Vector Grad End Pt": [60.0, 20.0]})


@case("shape_gradient_radial")
def _(comp):
    g = shape_group(shape_comp(comp))
    add(g, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [110.0, 90.0]})
    add(
        g,
        "ADBE Vector Graphic - G-Fill",
        **{"ADBE Vector Grad Type": 2.0, "ADBE Vector Grad Start Pt": [0.0, 0.0], "ADBE Vector Grad End Pt": [50.0, 0.0]},
    )


@case("shape_fill_evenodd")
def _(comp):
    g = shape_group(shape_comp(comp))
    add(g, "ADBE Vector Shape - Star", **{"ADBE Vector Star Points": 5.0, "ADBE Vector Star Outer Radius": 52.0, "ADBE Vector Star Inner Radius": 45.0})
    add(g, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [60.0, 60.0]})
    fill(g, ORANGE, **{"ADBE Vector Fill Rule": 2.0})


@case("shape_stacking")
def _(comp):
    layer = shape_comp(comp)
    front = shape_group(layer)
    gtr(front, "ADBE Vector Position", [-15.0, -10.0])
    add(front, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [70.0, 50.0]})
    fill(front, ORANGE)
    back = shape_group(layer)
    gtr(back, "ADBE Vector Position", [15.0, 10.0])
    add(back, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [70.0, 50.0]})
    stroke(back, [1.0, 1.0, 1.0], 6.0)
    fill(back, TEAL)


@case("shape_layer_transform_mask")
def _(comp):
    layer = shape_comp(comp)
    g = shape_group(layer)
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [100.0, 60.0]})
    fill(g, ORANGE)
    tr(layer, "ADBE Rotate Z").value = 25.0
    tr(layer, "ADBE Scale").value = [110.0, 90.0, 100.0]
    # py-aep divides mask points by the layer size, but AE reads a shape layer's
    # mask points as layer pixels, so pre-scale to land on (-20,-35)..(60,25).
    add_mask(layer, rect(-20 * W, -35 * H, 60 * W, 25 * H))


@case("shape_animated_trim", frames=(0, 8, 16))
def _(comp):
    g = shape_group(shape_comp(comp))
    add(g, "ADBE Vector Shape - Star", **{"ADBE Vector Star Points": 6.0, "ADBE Vector Star Outer Radius": 50.0, "ADBE Vector Star Inner Radius": 30.0})
    stroke(g, ORANGE, 6.0)
    trim = add(g, "ADBE Vector Filter - Trim")
    end = trim["ADBE Vector Trim End"]
    end.set_value_at_time(0.0, 0.0)
    end.set_value_at_time(0.75, 100.0)


suite.save()
