# Builds refs/fixtures/fixtures.aep: one small composition per renderer feature,
# authored with py-aep (MIT, https://github.com/forticheprod/py-aep) on top of an
# AE 25.6 project that uses After Effects' default color settings (8 bpc, no
# working space, no linearization), so After Effects 2025 can open and render it.
# Also writes refs/fixtures/manifest.json listing each comp and the frames to render.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_fixtures.py
import json
import sys
import traceback
from pathlib import Path

PY_AEP = Path(__file__).resolve().parents[3] / "_ref" / "py-aep"
sys.path.insert(0, str(PY_AEP / "src"))
import py_aep  # noqa: E402
from py_aep.enums import BlendingMode, MaskMode, TrackMatteType  # noqa: E402
from py_aep.models.properties.shape import Shape  # noqa: E402

BASE = PY_AEP / "samples" / "bugs" / "windows-1250_decoding_error.aep"
OUT = Path(__file__).resolve().parents[2] / "refs" / "fixtures"
W, H, FPS, DUR = 160, 120, 24.0, 1.0

app = py_aep.parse(BASE)
project = app.project
folder = project.root_folder.add_folder("fixtures")
manifest: list[dict] = []
failures: list[str] = []

BG = [0.12, 0.16, 0.30]
ORANGE = [1.0, 0.5, 0.0]
TEAL = [0.1, 0.7, 0.65]


def tr(layer, match_name):
    return layer["ADBE Transform Group"][match_name]


def case(name: str, frames=(0,)):
    def wrap(build):
        try:
            comp = folder.add_comp(name, W, H, 1.0, DUR, FPS)
            build(comp)
            manifest.append({"comp": name, "frames": list(frames)})
        except Exception:  # noqa: BLE001 - one failing case must not block the rest
            failures.append(f"{name}: {traceback.format_exc(limit=3)}")
        return build

    return wrap


def rect(x0, y0, x1, y1):
    return Shape([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], [[0, 0]] * 4, [[0, 0]] * 4, closed=True)


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


def add_mask(layer, shape, mode=MaskMode.ADD, inverted=False, opacity=None, feather=None):
    mask = layer["ADBE Mask Parade"].add_property("ADBE Mask Atom")
    mask["ADBE Mask Shape"].value = shape
    mask.mask_mode = mode
    if inverted:
        mask.inverted = True
    if opacity is not None:
        mask["ADBE Mask Opacity"].value = opacity
    if feather is not None:
        mask["ADBE Mask Feather"].value = [feather, feather]
    return mask


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


OUT.mkdir(parents=True, exist_ok=True)
(OUT / "fixtures.aep").unlink(missing_ok=True)
project.save(OUT / "fixtures.aep")
(OUT / "manifest.json").write_text(
    json.dumps({"project": "fixtures.aep", "width": W, "height": H, "comps": manifest}, indent=1) + "\n",
    encoding="utf-8",
)
print(f"built {len(manifest)} comps into {OUT / 'fixtures.aep'}")
for failure in failures:
    print("FAILED", failure)
