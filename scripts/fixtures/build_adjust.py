# Builds refs/fixtures/adjust.aep: adjustment layers. Their effects apply to the
# composite of the layers below, inside the layer's own area (its source's alpha and
# masks), mixed in by its opacity; layers above are not affected.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_adjust.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BG, ORANGE, TEAL, Suite, add_effect, add_mask, install_effects, rect, tr  # noqa: E402

BOX = "ADBE Box Blur2"
suite = Suite("adjust")
install_effects(suite, [BOX])
case = suite.case


def scene(comp, background=True):
    """Hard-edged content to blur: a background and two overlapping solids."""
    if background:
        comp.add_solid(BG, "bg")
    a = comp.add_solid(ORANGE, "a", 70, 50)
    tr(a, "ADBE Position").value = [60.0, 50.0, 0.0]
    b = comp.add_solid(TEAL, "b", 40, 70)
    tr(b, "ADBE Position").value = [105.0, 70.0, 0.0]


def adjustment(comp, name="adjust", width=None, height=None):
    layer = comp.add_solid([1.0, 1.0, 1.0], name, width or comp.width, height or comp.height)
    layer.adjustment_layer = True
    return layer


def blur(layer, radius, iterations=3, repeat=0):
    fx = add_effect(layer, BOX)
    for index, value in ((1, radius), (2, iterations), (3, 1), (4, repeat)):
        fx[f"{BOX}-{index:04d}"].value = value
    return fx


@case("adjust_blur")
def _(comp):
    scene(comp)
    blur(adjustment(comp), 6.0)


@case("adjust_above")
def _(comp):
    # A layer above the adjustment layer stays sharp.
    scene(comp)
    blur(adjustment(comp), 6.0)
    top = comp.add_solid([0.9, 0.9, 0.9], "top", 24, 24)
    tr(top, "ADBE Position").value = [80.0, 30.0, 0.0]


@case("adjust_opacity")
def _(comp):
    scene(comp)
    layer = adjustment(comp)
    blur(layer, 10.0)
    tr(layer, "ADBE Opacity").value = 45.0


@case("adjust_masked")
def _(comp):
    scene(comp)
    layer = adjustment(comp)
    blur(layer, 8.0)
    add_mask(layer, rect(40, 30, 120, 95))


@case("adjust_feathered")
def _(comp):
    scene(comp)
    layer = adjustment(comp)
    blur(layer, 8.0)
    add_mask(layer, rect(30, 25, 130, 100), feather=12.0)


@case("adjust_small_moved")
def _(comp):
    # A smaller adjustment layer, scaled and rotated: its effect runs in its own pixels.
    scene(comp)
    layer = adjustment(comp, "small", 70, 50)
    tr(layer, "ADBE Position").value = [85.0, 62.0, 0.0]
    tr(layer, "ADBE Scale").value = [130.0, 130.0, 100.0]
    tr(layer, "ADBE Rotate Z").value = 25.0
    blur(layer, 5.0)


@case("adjust_transparent")
def _(comp):
    # Nothing below in places: the blur spreads the layers' alpha too.
    scene(comp, background=False)
    blur(adjustment(comp), 7.0)


@case("adjust_transparent_opacity")
def _(comp):
    scene(comp, background=False)
    layer = adjustment(comp)
    blur(layer, 7.0)
    tr(layer, "ADBE Opacity").value = 50.0


@case("adjust_no_effect")
def _(comp):
    # Without effects it changes nothing, even at partial opacity over partial transparency.
    scene(comp, background=False)
    layer = adjustment(comp)
    tr(layer, "ADBE Opacity").value = 50.0


@case("adjust_stacked")
def _(comp):
    scene(comp)
    blur(adjustment(comp, "first"), 4.0)
    mid = comp.add_solid([0.95, 0.95, 0.2], "mid", 20, 20)
    tr(mid, "ADBE Position").value = [40.0, 95.0, 0.0]
    blur(adjustment(comp, "second"), 3.0, 2, 1)


suite.save()
