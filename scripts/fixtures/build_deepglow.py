# Builds refs/fixtures/deepglow.aep: parameter sweeps of Deep Glow 2 (PEDG2, Plugin
# Everything) for fitting a black-box look-alike. The definition is cloned from the
# user's project (bass-supreme.aep) through aepfix.install_effects.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_deepglow.py
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import REFS, Suite, add, add_effect, fill, gtr, install_effects, shape_group  # noqa: E402

from py_aep.enums.property import PropertyControlType  # noqa: E402
from py_aep.models.properties.gradient import Gradient, GradientAlphaStop, GradientColorStop  # noqa: E402

#: Accepted approximations, "comp@frame" -> reason (still held to a mean error of 1/255).
KNOWN: dict[str, str] = {}

suite = Suite("deepglow")
install_effects(suite, ["PEDG2"])
case = suite.case
folder = suite.folder

#: Every parameter the fixtures depend on, by index: the fxmisc fixtures' settings
#: (Exponential, Screen, Radius 50, Exposure 1, no threshold, aberration, tint or tone mapping, Standard quality).
BASE = {
    103: 1, 24: 1, 17: 50.0, 18: 1.0,
    95: 1, 20: 0.0, 21: 0.0, 96: 0.0,
    26: 1, 154: 100.0,
    31: 1.0, 32: 0, 33: 0.0,
    36: 0, 37: 2, 38: 1.0, 1036: 0, 97: 100.0, 98: 120.0, 99: 140.0,
    43: 1, 67: 1, 42: [1.0, 0.0, 0.0, 1.0], 66: [1.0, 0.5, 0.0, 1.0], 44: 100.0,
    93: 1, 82: 100.0,
    48: 3, 1048: 3,
    64: 1, 65: 0,
    53: 1, 135: 1, 54: 100.0, 55: 1,
    143: 1,
}
GLOW_INPUT = {53: 2, 135: 2}


def _leaves(group):
    for child in group.properties:
        if hasattr(child, "properties"):
            yield from _leaves(child)
        else:
            yield child


def glow(layer, keys=None, **params):
    """Deep Glow 2 on `layer` with BASE plus `params` (pN=value); `keys` maps an index to per-frame values."""
    fx = add_effect(layer, "PEDG2")
    for leaf in _leaves(fx):
        # py-aep resets popups to a 0 below their range; the declared default is the pard's last value.
        if leaf._property_control_type == PropertyControlType.ENUM and leaf.value == 0 and leaf.last_value:
            leaf.value = leaf.last_value
    values = {**BASE, **{int(k[1:]): v for k, v in params.items()}}
    for index, value in values.items():
        fx[f"PEDG2-{index:04d}"].value = value
    for index, frames in (keys or {}).items():
        prop = fx[f"PEDG2-{index:04d}"]
        for k, v in enumerate(frames):
            prop.set_value_at_time(k / 24.0, v)
    return fx


def gradient(c0, c1):
    return Gradient(
        [GradientColorStop(0.0, 0.5, tuple(c0)), GradientColorStop(1.0, 0.5, tuple(c1))],
        [GradientAlphaStop(0.0, 0.5, 1.0), GradientAlphaStop(1.0, 0.5, 1.0)],
    )


def rect_item(layer, w, h, x, y, color):
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [x, y])
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [float(w), float(h)]})
    return fill(g, list(color))


def disk_item(layer, d, x, y, color):
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [x, y])
    add(g, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [float(d), float(d)]})
    return fill(g, list(color))


# --- Sources (precomps on transparency; shape coordinates are relative to the comp centre) ---


def dot_source(name, size):
    comp = folder.add_comp(name, size, size, 1.0, 1.0, 24.0)
    rect_item(comp.add_shape(), 4, 4, 0.0, 0.0, [1.0, 1.0, 1.0])
    return comp


def edge_source(name, w, h):
    """White over the left half."""
    comp = folder.add_comp(name, w, h, 1.0, 1.0, 24.0)
    rect_item(comp.add_shape(), w / 2, h, -w / 4, 0.0, [1.0, 1.0, 1.0])
    return comp


RAMP_COLORS = [[1.0, 1.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.5, 0.0], [0.3, 0.6, 1.0]]


def ramps_source(name, w, h):
    """One horizontal strip per colour of RAMP_COLORS, black on the left to the colour on the right."""
    comp = folder.add_comp(name, w, h, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    strip = h / len(RAMP_COLORS)
    for k, color in enumerate(RAMP_COLORS):
        g = shape_group(layer)
        gtr(g, "ADBE Vector Position", [0.0, -h / 2 + strip * (k + 0.5)])
        add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [float(w), strip]})
        grad = add(g, "ADBE Vector Graphic - G-Fill", **{"ADBE Vector Grad Start Pt": [-w / 2, 0.0], "ADBE Vector Grad End Pt": [w / 2, 0.0]})
        grad["ADBE Vector Grad Colors"].value = gradient([0.0, 0.0, 0.0], color)
    return comp


def scene_source(name, w=160, h=120):
    """The fxmisc glow source: an orange disk and a blue bar."""
    comp = folder.add_comp(name, w, h, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    disk_item(layer, 24, 0.0, 0.0, [1.0, 0.6, 0.2])
    rect_item(layer, 30, 4, 40.0, 25.0, [0.3, 0.6, 1.0])
    return comp


def level_source(name, colors):
    """A 24 px disk whose colour steps through `colors`, one per frame."""
    comp = folder.add_comp(name, 160, 120, 1.0, 1.0, 24.0)
    item = disk_item(comp.add_shape(), 24, 0.0, 0.0, colors[0])
    prop = item["ADBE Vector Fill Color"]
    for k, c in enumerate(colors):
        prop.set_value_at_time(k / 24.0, list(c) + [1.0])
    return comp


def bars_source(name, w, h):
    """White spectrum-like bars standing on a baseline, on transparency."""
    comp = folder.add_comp(name, w, h, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    n = w // 12
    for k in range(n):
        height = 8.0 + (k * 37) % 120
        rect_item(layer, 5, height, -w / 2 + 10.0 + 12.0 * k, 40.0 - height / 2, [1.0, 1.0, 1.0])
    rect_item(layer, w - 20, 3, 0.0, 41.5, [1.0, 0.85, 0.3])
    return comp


def frames(n):
    return tuple(range(n))


def on_black(comp, src):
    comp.add_solid([0.0, 0.0, 0.0], "bg")
    return comp.add(src)


DOT = dot_source("deepglow_src_dot", 256)
EDGE = edge_source("deepglow_src_edge", 512, 96)
RAMPS = ramps_source("deepglow_src_ramps", 256, 96)
SCENE = scene_source("deepglow_src_scene")
BARS = bars_source("deepglow_src_bars", 480, 270)
LEVELS = [[1.0, 1.0, 1.0], [0.5, 0.5, 0.5], [0.25, 0.25, 0.25], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.5, 0.0], [0.3, 0.6, 1.0]]
LEVEL_SRC = level_source("deepglow_src_levels", LEVELS)
RADII = [8.0, 16.0, 32.0, 64.0, 128.0, 256.0, 512.0]

# --- Kernel shape ---------------------------------------------------------------------


@case("deepglow_dot", frames=frames(len(RADII)), width=256, height=256)
def _(comp):
    glow(on_black(comp, DOT), keys={17: RADII})


@case("deepglow_dot_hot", frames=frames(len(RADII)), width=256, height=256)
def _(comp):
    glow(on_black(comp, DOT), keys={17: RADII}, p18=20.0)


@case("deepglow_edge", frames=frames(len(RADII)), width=512, height=96)
def _(comp):
    glow(on_black(comp, EDGE), keys={17: RADII})


@case("deepglow_radius_small", frames=frames(5), width=256, height=256)
def _(comp):
    glow(on_black(comp, DOT), keys={17: [0.0, 1.0, 2.0, 4.0, 6.0]}, p18=20.0)


# --- Colour response ------------------------------------------------------------------


@case("deepglow_levels", frames=frames(len(LEVELS)))
def _(comp):
    glow(on_black(comp, LEVEL_SRC), p17=20.0)


@case("deepglow_levels_add", frames=frames(len(LEVELS)))
def _(comp):
    glow(on_black(comp, LEVEL_SRC), p17=20.0, p24=2)


@case("deepglow_exposure", frames=frames(5), width=256, height=96)
def _(comp):
    glow(on_black(comp, RAMPS), keys={18: [0.0, 0.25, 2.0, 6.0, 20.0]}, p17=16.0)


# --- Glow input (threshold) -----------------------------------------------------------

THRESHOLDS = [0.0, 25.0, 50.0, 75.0, 100.0, 200.0]


@case("deepglow_thresh_chroma", frames=frames(len(THRESHOLDS)), width=256, height=96)
def _(comp):
    glow(on_black(comp, RAMPS), keys={20: THRESHOLDS}, p95=1, **{f"p{k}": v for k, v in GLOW_INPUT.items()})


@case("deepglow_thresh_luma", frames=frames(len(THRESHOLDS)), width=256, height=96)
def _(comp):
    glow(on_black(comp, RAMPS), keys={20: THRESHOLDS}, p95=2, **{f"p{k}": v for k, v in GLOW_INPUT.items()})


@case("deepglow_smooth", frames=frames(5), width=256, height=96)
def _(comp):
    glow(on_black(comp, RAMPS), keys={21: [0.0, 25.0, 50.0, 75.0, 100.0]}, p20=50.0, **{f"p{k}": v for k, v in GLOW_INPUT.items()})


@case("deepglow_satbias", frames=frames(5), width=256, height=96)
def _(comp):
    glow(on_black(comp, RAMPS), keys={96: [-100.0, -50.0, 0.0, 50.0, 100.0]}, p20=50.0, **{f"p{k}": v for k, v in GLOW_INPUT.items()})


@case("deepglow_satbias_luma", frames=frames(5), width=256, height=96)
def _(comp):
    glow(on_black(comp, RAMPS), keys={96: [-100.0, -50.0, 0.0, 50.0, 100.0]}, p20=50.0, p95=2, **{f"p{k}": v for k, v in GLOW_INPUT.items()})


@case("deepglow_input_plain", frames=(0,), width=256, height=96)
def _(comp):
    glow(on_black(comp, RAMPS), **{f"p{k}": v for k, v in GLOW_INPUT.items()})


@case("deepglow_thresh_final", frames=frames(4), width=256, height=96)
def _(comp):
    glow(on_black(comp, RAMPS), keys={20: [25.0, 50.0, 75.0, 100.0]}, p21=50.0, p17=24.0)


# --- Shape options --------------------------------------------------------------------


@case("deepglow_aspect", frames=frames(5), width=256, height=256)
def _(comp):
    glow(on_black(comp, DOT), keys={31: [0.25, 0.5, 1.0, 1.5, 2.0]}, p17=64.0, p18=20.0)


@case("deepglow_angle", frames=frames(4), width=256, height=256)
def _(comp):
    glow(on_black(comp, DOT), keys={33: [0.0, 30.0, 60.0, 90.0]}, p17=64.0, p18=20.0, p31=0.5, p32=1)


# --- Chromatic aberration -------------------------------------------------------------


@case("deepglow_pixab_rb", frames=frames(4))
def _(comp):
    glow(on_black(comp, SCENE), keys={38: [-20.0, -5.0, 5.0, 20.0]}, p17=20.0, p36=1, p37=2)


@case("deepglow_pixab_rg", frames=(0,))
def _(comp):
    glow(on_black(comp, SCENE), p17=20.0, p36=1, p37=1, p38=10.0)


@case("deepglow_pixab_gb", frames=(0,))
def _(comp):
    glow(on_black(comp, SCENE), p17=20.0, p36=1, p37=3, p38=10.0)


@case("deepglow_glowab", frames=frames(4), width=256, height=256)
def _(comp):
    glow(on_black(comp, DOT), keys={97: [50.0, 100.0, 150.0, 200.0]}, p17=64.0, p18=20.0, p1036=1, p98=100.0, p99=100.0)


@case("deepglow_glowab_user", frames=(0,), width=256, height=256)
def _(comp):
    glow(on_black(comp, DOT), p17=64.0, p18=20.0, p1036=1, p97=100.0, p98=120.0, p99=140.0)


# --- Compositing ----------------------------------------------------------------------


@case("deepglow_alpha", frames=frames(3))
def _(comp):
    glow(comp.add(SCENE), keys={54: [100.0, 50.0, 0.0]})


@case("deepglow_alpha_add", frames=(0,))
def _(comp):
    glow(comp.add(SCENE), p24=2)


@case("deepglow_alpha_ramps", frames=(0,), width=256, height=96)
def _(comp):
    glow(comp.add(RAMPS), p17=16.0)


@case("deepglow_srcopacity", frames=frames(3))
def _(comp):
    glow(on_black(comp, SCENE), keys={54: [100.0, 50.0, 0.0]})


@case("deepglow_small_layer", frames=(0,), width=320, height=240)
def _(comp):
    comp.add_solid([0.0, 0.0, 0.0], "bg")
    layer = comp.add(SCENE)
    glow(layer, p17=50.0)


@case("deepglow_fullframe", frames=frames(2), width=256, height=96)
def _(comp):
    # An opaque source over the whole layer: what the glow sees beyond its edges.
    glow(comp.add(RAMPS), keys={17: [16.0, 128.0]})


# --- Tint -----------------------------------------------------------------------------


@case("deepglow_tint_mono", frames=(0,))
def _(comp):
    glow(on_black(comp, SCENE), p43=3, p42=[0.2, 0.6, 1.0, 1.0])


@case("deepglow_tint_duo", frames=(0,))
def _(comp):
    glow(on_black(comp, SCENE), p43=4, p42=[1.0, 0.0, 0.0, 1.0], p66=[0.0, 0.3, 1.0, 1.0])


# --- Quality presets ------------------------------------------------------------------

for preset, tag in ((1, "draft"), (2, "low"), (3, "medium"), (5, "high"), (6, "extreme")):

    @case(f"deepglow_quality_{tag}", frames=frames(2), width=256, height=256)
    def _(comp, preset=preset):
        glow(on_black(comp, DOT), keys={17: [64.0, 256.0]}, p18=20.0, p48=preset)


# --- Bright sources: where the glow stops being linear in the input -----------------


def disk_source(name, diameters, colors, size=160):
    """A disk at the centre whose diameter and colour step per frame."""
    comp = folder.add_comp(name, size, size, 1.0, 1.0, 24.0)
    g = shape_group(comp.add_shape())
    ellipse = add(g, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [float(diameters[0])] * 2})
    item = fill(g, list(colors[0]))
    for k, d in enumerate(diameters):
        ellipse["ADBE Vector Ellipse Size"].set_value_at_time(k / 24.0, [float(d)] * 2)
    for k, c in enumerate(colors):
        item["ADBE Vector Fill Color"].set_value_at_time(k / 24.0, list(c) + [1.0])
    return comp


GRAYS = [[v, v, v] for v in (1.0, 0.9, 0.8, 0.7, 0.6)]
SIZES = [4.0, 8.0, 16.0, 32.0, 64.0]
HI_SRC = disk_source("deepglow_src_hi", [24.0] * 5, GRAYS)
SIZE_SRC = disk_source("deepglow_src_size", SIZES, [[1.0, 1.0, 1.0]] * 5)
SIZE_GRAY_SRC = disk_source("deepglow_src_size_gray", SIZES, [[0.5, 0.5, 0.5]] * 5)


@case("deepglow_hi", frames=frames(5), width=160, height=160)
def _(comp):
    glow(on_black(comp, HI_SRC), p17=20.0)


@case("deepglow_size", frames=frames(5), width=160, height=160)
def _(comp):
    glow(on_black(comp, SIZE_SRC), p17=20.0)


@case("deepglow_size_gray", frames=frames(5), width=160, height=160)
def _(comp):
    glow(on_black(comp, SIZE_GRAY_SRC), p17=20.0)


@case("deepglow_size_r128", frames=frames(5), width=160, height=160)
def _(comp):
    glow(on_black(comp, SIZE_SRC), p17=128.0)


@case("deepglow_disk_exp", frames=frames(5), width=160, height=160)
def _(comp):
    glow(on_black(comp, HI_SRC), keys={18: [0.25, 0.5, 1.0, 2.0, 4.0]}, p17=20.0)


@case("deepglow_radius_mid", frames=frames(5), width=256, height=256)
def _(comp):
    glow(on_black(comp, DOT), keys={17: [40.0, 48.0, 56.0, 150.0, 1000.0]}, p18=20.0)


@case("deepglow_radius_mid_lo", frames=frames(5), width=256, height=256)
def _(comp):
    glow(on_black(comp, DOT), keys={17: [40.0, 48.0, 56.0, 150.0, 1000.0]})


# --- Threshold Smooth range and the saturation measure (glow input view) ------------

for t, tag in ((65.0, "t65"), (25.0, "t25")):

    @case(f"deepglow_smooth_{tag}", frames=frames(3), width=256, height=96)
    def _(comp, t=t):
        glow(on_black(comp, RAMPS), keys={21: [25.0, 50.0, 100.0]}, p20=t, **{f"p{k}": v for k, v in GLOW_INPUT.items()})


SAT_ROWS = [([1.0, 1.0, 1.0], [1.0, 0.0, 0.0]), ([0.5, 0.5, 0.5], [0.5, 0.0, 0.0]), ([1.0, 1.0, 1.0], [0.0, 0.5, 1.0]),
            ([1.0, 1.0, 1.0], [1.0, 1.0, 0.0]), ([0.25, 0.25, 0.25], [0.0, 0.25, 0.0]), ([1.0, 1.0, 1.0], [0.0, 1.0, 1.0])]


def sat_source(name, w, h):
    """Strips running from a gray (left) to a colour of the same maximum (right)."""
    comp = folder.add_comp(name, w, h, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    strip = h / len(SAT_ROWS)
    for k, (c0, c1) in enumerate(SAT_ROWS):
        g = shape_group(layer)
        gtr(g, "ADBE Vector Position", [0.0, -h / 2 + strip * (k + 0.5)])
        add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [float(w), strip]})
        grad = add(g, "ADBE Vector Graphic - G-Fill", **{"ADBE Vector Grad Start Pt": [-w / 2, 0.0], "ADBE Vector Grad End Pt": [w / 2, 0.0]})
        grad["ADBE Vector Grad Colors"].value = gradient(c0, c1)
    return comp


SAT = sat_source("deepglow_src_sat", 256, 96)


@case("deepglow_sat_curve", frames=frames(4), width=256, height=96)
def _(comp):
    glow(on_black(comp, SAT), keys={96: [100.0, 50.0, -50.0, -100.0]}, **{f"p{k}": v for k, v in GLOW_INPUT.items()})


@case("deepglow_sat_input", frames=(0,), width=256, height=96)
def _(comp):
    glow(on_black(comp, SAT), **{f"p{k}": v for k, v in GLOW_INPUT.items()})


# --- The user's settings (bass-supreme.aep) on spectrum-like bars ---------------------

USER_COMMON = dict(p17=150.0, p95=1, p36=1, p37=2, p48=3)


@case("deepglow_user_rgb", frames=(0,), width=480, height=270)
def _(comp):
    # "RGB GLOW" in Final.
    glow(on_black(comp, BARS), **USER_COMMON, p18=0.5, p20=65.0, p21=100.0, p96=100.0, p38=20.0, p1036=1, p97=100.0, p98=120.0, p99=140.0)


@case("deepglow_user_qca", frames=(0,), width=480, height=270)
def _(comp):
    # "Deep Glow 2" in Render This.
    glow(on_black(comp, BARS), **USER_COMMON, p18=1.0, p20=0.0, p21=0.0, p96=0.0, p38=17.0, p1036=0, p97=125.0, p98=125.0, p99=133.0)


@case("deepglow_user_rgb_alpha", frames=(0,), width=480, height=270)
def _(comp):
    glow(comp.add(BARS), **USER_COMMON, p18=0.5, p20=65.0, p21=100.0, p96=100.0, p38=20.0, p1036=1, p97=100.0, p98=120.0, p99=140.0)


@case("deepglow_user_qca_alpha", frames=(0,), width=480, height=270)
def _(comp):
    glow(comp.add(BARS), **USER_COMMON, p18=1.0, p20=0.0, p21=0.0, p96=0.0, p38=17.0, p1036=0, p97=125.0, p98=125.0, p99=133.0)


@case("deepglow_user_rgb_input", frames=(0,), width=480, height=270)
def _(comp):
    # The glow input of "RGB GLOW": threshold, smooth and saturation bias on white bars.
    glow(on_black(comp, BARS), **USER_COMMON, p18=0.5, p20=65.0, p21=100.0, p96=100.0, p38=20.0, p1036=1, p97=100.0, p98=120.0, p99=140.0, **{f"p{k}": v for k, v in GLOW_INPUT.items()})


@case("deepglow_satbias_smooth", frames=frames(4), width=256, height=96)
def _(comp):
    glow(on_black(comp, RAMPS), keys={21: [0.0, 25.0, 50.0, 100.0]}, p20=65.0, p96=100.0, **{f"p{k}": v for k, v in GLOW_INPUT.items()})


@case("deepglow_satbias_smooth_neg", frames=frames(3), width=256, height=96)
def _(comp):
    glow(on_black(comp, RAMPS), keys={96: [-100.0, 25.0, 75.0]}, p20=65.0, p21=50.0, **{f"p{k}": v for k, v in GLOW_INPUT.items()})


suite.save()
manifest = REFS / suite.manifest_file
data = json.loads(manifest.read_text(encoding="utf-8"))
data["known"] = KNOWN
manifest.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
