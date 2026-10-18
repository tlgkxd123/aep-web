# Builds refs/fixtures/blurnoise.aep: the Blur & Sharpen and Noise & Grain effects of
# src/render/effects/blurNoise.ts, each on a card of hard-edged coloured cells, on a
# scene with transparent margins and antialiased edges, and on single-pixel probes,
# with every parameter the case depends on set (values in lists are keyed one per
# frame). The noise effects draw from After Effects' own random generators, which
# ours only imitate, and the effects listed in NOT_MATCHED are not matched yet: they
# render references but stay out of the pixel gate
# (refs/fixtures/blurnoise.approximations.json).
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_blurnoise.py
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BG, ORANGE, REFS, TEAL, Suite, add, add_effect, fill, install_effects, set_layer_param, shape_group, stroke, tr  # noqa: E402

CHANNEL = "ADBE Channel Blur"
RFB = "CC Radial Fast Blur"
RB = "CC Radial Blur"
CROSS = "CS CrossBlur"
VECTOR = "CC Vector Blur"
COMPOUND = "ADBE Compound Blur"
BILATERAL = "ADBE Bilateral"
SMART = "ADBE Smart Blur"
MEDIAN = "ADBE Median"
DUST = "ADBE Dust & Scratches"
LENS = "ADBE Camera Lens Blur"
NOISE_ALPHA = "ADBE Noise Alpha2"
NOISE_HLS = "ADBE Noise HLS2"
NOISE_HLS_AUTO = "ADBE Noise HLS Auto2"
TURBULENT = "ADBE AIF Perlin Noise 3D"
GRAIN = "VISINF Grain Implant"
EFFECTS = [CHANNEL, RFB, RB, CROSS, VECTOR, COMPOUND, BILATERAL, SMART, MEDIAN, DUST, LENS, NOISE_ALPHA, NOISE_HLS, NOISE_HLS_AUTO, TURBULENT, GRAIN]

suite = Suite("blurnoise")
install_effects(suite, EFFECTS)
case = suite.case
folder = suite.folder

CELL_COLORS = [
    [0.95, 0.85, 0.2], [0.1, 0.2, 0.6], [0.85, 0.2, 0.25], [0.2, 0.75, 0.35],
    [0.6, 0.3, 0.8], [1.0, 1.0, 1.0], [0.05, 0.05, 0.05], [0.95, 0.55, 0.1],
    [0.3, 0.85, 0.9], [0.5, 0.5, 0.5], [0.9, 0.4, 0.7], [0.15, 0.45, 0.3],
]


def card(w=80, h=60, cell=20):
    """A precomp tiled with differently coloured solids: hard edges and texture, opaque to its bounds."""
    inner = folder.add_comp(f"blurnoise_card_{w}x{h}_{cell}", w, h, 1.0, 1.0, 24.0)
    cols = (w + cell - 1) // cell
    for j in range((h + cell - 1) // cell):
        for i in range(cols):
            s = inner.add_solid(CELL_COLORS[(j * cols + i) % len(CELL_COLORS)], f"c{i}_{j}", cell, cell)
            tr(s, "ADBE Position").value = [i * cell + cell / 2, j * cell + cell / 2, 0.0]
    return inner


CARD = card()


def star(comp, position=None):
    layer = comp.add_shape()
    g = shape_group(layer)
    add(g, "ADBE Vector Shape - Star", **{"ADBE Vector Star Points": 5.0, "ADBE Vector Star Outer Radius": 32.0, "ADBE Vector Star Inner Radius": 14.0})
    stroke(g, TEAL, 4.0, **{"ADBE Vector Stroke Line Join": 2.0})
    fill(g, ORANGE)
    if position:
        tr(layer, "ADBE Position").value = position + [0.0]
    return layer


def scene():
    """A comp-sized precomp with transparent margins: a turned card, a star and a half-transparent bar."""
    inner = folder.add_comp("blurnoise_src_scene", 160, 120, 1.0, 1.0, 24.0)
    c = inner.add(CARD)
    tr(c, "ADBE Position").value = [66.0, 64.0, 0.0]
    tr(c, "ADBE Rotate Z").value = 12.0
    star(inner, [118.0, 44.0])
    bar = inner.add_solid([0.9, 0.9, 0.95], "bar", 44, 14)
    tr(bar, "ADBE Position").value = [118.0, 98.0, 0.0]
    tr(bar, "ADBE Opacity").value = 50.0
    return inner


SCENE = scene()


def plain():
    """The scene's ingredients on whole pixels, without turned or curved edges: the card, an orange block over its
    corner, a 70% teal block and the half-transparent bar. Rank filters pick among antialiased edge values, which
    this renderer's shape and turned-layer edges do not reproduce exactly."""
    inner = folder.add_comp("blurnoise_src_plain", 160, 120, 1.0, 1.0, 24.0)
    c = inner.add(CARD)
    tr(c, "ADBE Position").value = [66.0, 64.0, 0.0]
    solid_at(inner, ORANGE, "block", 96, 24, 30, 24)
    teal = solid_at(inner, TEAL, "teal", 124, 56, 20, 20)
    tr(teal, "ADBE Opacity").value = 70.0
    bar = inner.add_solid([0.9, 0.9, 0.95], "bar", 44, 14)
    tr(bar, "ADBE Position").value = [118.0, 98.0, 0.0]
    tr(bar, "ADBE Opacity").value = 50.0
    return inner


def dots():
    """64x64 of transparency with one opaque white pixel at (20, 20) and a 2x2 red one at (42, 42)."""
    inner = folder.add_comp("blurnoise_src_dots", 64, 64, 1.0, 1.0, 24.0)
    d = inner.add_solid([1.0, 1.0, 1.0], "dot", 1, 1)
    tr(d, "ADBE Position").value = [20.5, 20.5, 0.0]
    r = inner.add_solid([1.0, 0.0, 0.0], "red", 2, 2)
    tr(r, "ADBE Position").value = [43.0, 43.0, 0.0]
    return inner


DOTS = dots()


def stripes(w=80, h=60, n=8):
    """n vertical stripes from black to white: a blur map."""
    inner = folder.add_comp(f"blurnoise_src_stripes_{w}x{h}", w, h, 1.0, 1.0, 24.0)
    sw = w / n
    for i in range(n):
        v = i / (n - 1)
        s = inner.add_solid([v, v, v], f"s{i}", int(round(sw)), h)
        tr(s, "ADBE Position").value = [(i + 0.5) * sw, h / 2, 0.0]
    return inner


STRIPES = stripes()
STRIPES_WIDE = stripes(160, 120, 5)


def solid_at(comp, color, name, x, y, w, h):
    s = comp.add_solid(color, name, w, h)
    tr(s, "ADBE Position").value = [x + w / 2, y + h / 2, 0.0]
    return s


def kernel_probe():
    """160x120 of transparency with an opaque white column at x = 30 and an opaque white quadrant from (100, 60):
    a blur's line response and its step responses across x and y."""
    inner = folder.add_comp("blurnoise_src_kernel", 160, 120, 1.0, 1.0, 24.0)
    solid_at(inner, [1.0, 1.0, 1.0], "line", 30, 0, 1, 120)
    solid_at(inner, [1.0, 1.0, 1.0], "quadrant", 100, 60, 60, 60)
    return inner


KERNEL = kernel_probe()
PLAIN = plain()


def square_probe():
    """160x120 of transparency with an opaque white 20x20 square centred on (40, 60): radial step responses."""
    inner = folder.add_comp("blurnoise_src_square", 160, 120, 1.0, 1.0, 24.0)
    solid_at(inner, [1.0, 1.0, 1.0], "square", 30, 50, 20, 20)
    return inner


SQUARE = square_probe()


def half_probe():
    """160x120 with its upper half opaque white: angular step responses around (40, 60)."""
    inner = folder.add_comp("blurnoise_src_half", 160, 120, 1.0, 1.0, 24.0)
    solid_at(inner, [1.0, 1.0, 1.0], "half", 0, 0, 160, 60)
    return inner


HALF = half_probe()


def patch_probe():
    """160x120 of opaque mid grey with patches a known number of levels away: greys 5 to 89 levels brighter
    (top row), each channel 30 levels brighter, then darker (middle row), and steps of 15 and 76 levels (bottom)."""
    inner = folder.add_comp("blurnoise_src_patches", 160, 120, 1.0, 1.0, 24.0)
    inner.add_solid([0.5, 0.5, 0.5], "bg", 160, 120)
    for i, d in enumerate([0.02, 0.05, 0.08, 0.12, 0.2, 0.35]):
        solid_at(inner, [0.5 + d] * 3, f"grey{i}", 5 + 25 * i, 10, 20, 20)
    for i in range(6):
        c = [0.5, 0.5, 0.5]
        c[i % 3] += 0.12 if i < 3 else -0.12
        solid_at(inner, c, f"chan{i}", 5 + 25 * i, 45, 20, 20)
    solid_at(inner, [0.56] * 3, "low", 0, 80, 80, 40)
    solid_at(inner, [0.8] * 3, "high", 80, 80, 80, 40)
    return inner


PATCHES = patch_probe()


def ladder_probe():
    """320x60 of opaque grey 128 with 4x20 patches k = 1 to 40 levels brighter, every 8 pixels: grey (top row) and
    red only (bottom row)."""
    inner = folder.add_comp("blurnoise_src_ladder", 320, 60, 1.0, 1.0, 24.0)
    inner.add_solid([128 / 255] * 3, "bg", 320, 60)
    for k in range(1, 41):
        solid_at(inner, [(128 + k) / 255] * 3, f"grey{k}", 8 * (k - 1) + 2, 5, 4, 20)
        solid_at(inner, [(128 + k) / 255, 128 / 255, 128 / 255], f"red{k}", 8 * (k - 1) + 2, 35, 4, 20)
    return inner


LADDER = ladder_probe()


def on_card(comp):
    comp.add_solid(BG, "bg")
    return comp.add(CARD)


def on_scene(comp, bg=True):
    if bg:
        comp.add_solid(BG, "bg")
    return comp.add(SCENE)


def on_plain(comp, bg=True):
    if bg:
        comp.add_solid(BG, "bg")
    return comp.add(PLAIN)


def effect(layer, match_name, **params):
    """add_effect where a list for a number parameter, or a list of lists, is keyed one value per frame."""
    fx = add_effect(layer, match_name)
    for key, value in params.items():
        prop = fx[f"{match_name}-{int(key[1:]):04d}"]
        keyed = isinstance(value, list) and (isinstance(value[0], list) or not isinstance(prop.value, list))
        if keyed:
            for k, v in enumerate(value):
                prop.set_value_at_time(k / 24.0, v)
        else:
            prop.value = value
    return fx


def frames(n):
    return tuple(range(n))


def hidden(comp, source):
    layer = comp.add(source)
    layer.enabled = False
    return layer


#: The scene without an effect: what every case on it starts from.
@case("blurnoise_scene", frames=frames(1))
def _(comp):
    on_scene(comp)


@case("blurnoise_plain", frames=frames(1))
def _(comp):
    on_plain(comp, bg=False)


# --- Channel Blur: Red, Green, Blue, Alpha Blurriness, Repeat Edge Pixels, Blur Dimensions ---------------------

@case("blurnoise_channel", frames=frames(5))
def _(comp):
    effect(on_card(comp), CHANNEL, p1=[10.0, 0.0, 4.0, 0.0, 30.0], p2=[0.0, 6.0, 4.0, 0.0, 2.0], p3=[0.0, 20.0, 4.0, 0.0, 9.0], p4=[0.0, 0.0, 4.0, 12.0, 5.0], p5=0, p6=1)


@case("blurnoise_channel_repeat", frames=frames(3))
def _(comp):
    effect(on_card(comp), CHANNEL, p1=[8.0, 8.0, 3.0], p2=[3.0, 8.0, 12.0], p3=[15.0, 8.0, 0.0], p4=[6.0, 8.0, 10.0], p5=1, p6=[1, 2, 3])


@case("blurnoise_channel_alpha", frames=frames(3))
def _(comp):
    effect(on_plain(comp, bg=False), CHANNEL, p1=[3.0, 0.0, 10.0], p2=[0.0, 5.0, 10.0], p3=[6.0, 0.0, 10.0], p4=[0.0, 8.0, 10.0], p5=0, p6=[1, 2, 1])


@case("blurnoise_channel_dot", frames=frames(2), width=64, height=64)
def _(comp):
    effect(comp.add(DOTS), CHANNEL, p1=[3.0, 12.0], p2=[8.0, 0.0], p3=[0.0, 1.0], p4=[5.0, 6.0], p5=0, p6=1)


@case("blurnoise_channel_kernel", frames=frames(7))
def _(comp):
    b = [1.0, 2.0, 3.5, 5.0, 10.0, 20.0, 40.0]
    effect(comp.add(KERNEL), CHANNEL, p1=b, p2=b, p3=b, p4=b, p5=0, p6=1)


@case("blurnoise_channel_kernel_repeat", frames=frames(2))
def _(comp):
    b = [5.0, 20.0]
    effect(comp.add(KERNEL), CHANNEL, p1=b, p2=b, p3=b, p4=b, p5=1, p6=1)


# --- CC Radial Fast Blur: Center, Amount, Zoom (Standard, Brightest, Darkest) -----------------------------------

@case("blurnoise_ccrfb", frames=frames(3))
def _(comp):
    effect(on_card(comp), RFB, p1=[[40.0, 30.0], [40.0, 30.0], [10.0, 50.0]], p2=[20.0, 60.0, 90.0], p3=1)


@case("blurnoise_ccrfb_scene", frames=frames(3))
def _(comp):
    effect(on_scene(comp, bg=False), RFB, p1=[[80.0, 60.0], [100.0, 40.0], [60.0, 70.0]], p2=[50.0, 70.0, 40.0], p3=[1, 2, 3])


@case("blurnoise_ccrfb_dot", frames=frames(2), width=64, height=64)
def _(comp):
    effect(comp.add(DOTS), RFB, p1=[32.0, 32.0], p2=[30.0, 80.0], p3=1)


@case("blurnoise_ccrfb_probe", frames=frames(5))
def _(comp):
    effect(comp.add(SQUARE), RFB, p1=[40.0, 60.0], p2=[10.0, 25.0, 50.0, 75.0, 100.0], p3=1)


@case("blurnoise_ccrfb_probe_zoom", frames=frames(2))
def _(comp):
    effect(comp.add(SQUARE), RFB, p1=[40.0, 60.0], p2=50.0, p3=[2, 3])


# --- CC Radial Blur: Type (stored: 1 Straight Zoom, 2 Fading Zoom, 3 Centered Zoom, 5 Rotate, 6 Scratch,
# 7 Rotate Fading), Amount, Quality, Center ---------------------------------------------------------------------

@case("blurnoise_ccrb_types", frames=frames(6))
def _(comp):
    effect(on_scene(comp), RB, p1=[1, 2, 3, 5, 6, 7], p2=40.0, p3=50.0, p4=[90.0, 55.0])


@case("blurnoise_ccrb_amount", frames=frames(4))
def _(comp):
    effect(on_card(comp), RB, p1=[1, 3, 5, 7], p2=[-30.0, 80.0, -60.0, 25.0], p3=[100.0, 20.0, 80.0, 100.0], p4=[[40.0, 30.0], [30.0, 20.0], [40.0, 30.0], [60.0, 40.0]])


@case("blurnoise_ccrb_zoom_probe", frames=frames(6))
def _(comp):
    effect(comp.add(SQUARE), RB, p1=[1, 2, 3, 1, 1, 1], p2=[50.0, 50.0, 50.0, -50.0, 100.0, 50.0], p3=[100.0, 100.0, 100.0, 100.0, 100.0, 30.0], p4=[40.0, 60.0])


@case("blurnoise_ccrb_spin_probe", frames=frames(6))
def _(comp):
    effect(comp.add(HALF), RB, p1=[5, 6, 7, 5, 5, 5], p2=[10.0, 10.0, 10.0, -10.0, 30.0, 10.0], p3=[100.0, 100.0, 100.0, 100.0, 100.0, 30.0], p4=[40.0, 60.0])


# --- CC Cross Blur: Radius X, Radius Y, Transfer Mode (Blend, Add, Screen, Multiply, Lighten, Darken),
# Repeat Edge Pixels -----------------------------------------------------------------------------------------------

@case("blurnoise_cccross", frames=frames(6))
def _(comp):
    effect(on_card(comp), CROSS, p1=[10.0, 6.0, 0.0, 12.0, 3.5, 20.0], p2=[4.0, 6.0, 9.0, 0.0, 7.5, 20.0], p3=[1, 2, 3, 4, 5, 6], p4=0)


@case("blurnoise_cccross_repeat", frames=frames(2))
def _(comp):
    effect(on_card(comp), CROSS, p1=[8.0, 15.0], p2=[5.0, 15.0], p3=1, p4=1)


@case("blurnoise_cccross_alpha", frames=frames(2))
def _(comp):
    effect(on_plain(comp, bg=False), CROSS, p1=[6.0, 12.0], p2=[6.0, 3.0], p3=[1, 3], p4=0)


@case("blurnoise_cccross_dot", frames=frames(2), width=64, height=64)
def _(comp):
    effect(comp.add(DOTS), CROSS, p1=[5.0, 2.5], p2=[0.0, 4.0], p3=1, p4=0)


@case("blurnoise_cccross_kernel", frames=frames(8))
def _(comp):
    effect(comp.add(KERNEL), CROSS, p1=[1.0, 2.0, 2.5, 3.5, 5.0, 10.0, 20.0, 40.0], p2=0.0, p3=5, p4=0)


@case("blurnoise_cccross_kernel_fine", frames=frames(6))
def _(comp):
    effect(comp.add(KERNEL), CROSS, p1=[1.25, 1.5, 1.75, 2.25, 2.75, 3.0], p2=0.0, p3=5, p4=0)


@case("blurnoise_cccross_kernel_y", frames=frames(6))
def _(comp):
    effect(comp.add(KERNEL), CROSS, p1=[0.0, 0.0, 0.0, 0.0, 5.0, 5.0], p2=[2.0, 5.0, 10.0, 20.0, 5.0, 5.0], p3=[5, 5, 5, 5, 1, 2], p4=0)


# --- CC Vector Blur: Type (Natural, Constant Length, Perpendicular, Direction Center, Direction Fading), Amount,
# Angle Offset, Ridge Smoothness, Vector Map, Property, Map Softness -------------------------------------------------

# Type cannot be keyed: one comp per type.
for vtype, vname in ((1, "natural"), (2, "constant"), (3, "perpendicular"), (4, "center"), (5, "fading")):

    @case(f"blurnoise_ccvector_{vname}", frames=frames(2))
    def _(comp, vtype=vtype):
        effect(on_scene(comp), VECTOR, p1=vtype, p2=[12.0, -25.0], p3=[0.0, 30.0], p4=[1.0, 20.0], p6=6, p7=[15.0, 5.0])


@case("blurnoise_ccvector_map", frames=frames(3))
def _(comp):
    m = comp.add(STRIPES_WIDE)
    m.enabled = False
    fx = effect(on_card(comp), VECTOR, p1=2, p2=[8.0, 20.0, -15.0], p3=[0.0, 45.0, 90.0], p4=[1.0, 10.0, 40.0], p6=[5, 1, 6], p7=[0.0, 15.0, 40.0])
    set_layer_param(fx[f"{VECTOR}-0005"], m)


# --- Compound Blur: Blur Layer, Maximum Blur, Stretch Map to Fit, Invert Blur ------------------------------------

@case("blurnoise_compound", frames=frames(3))
def _(comp):
    m = comp.add(STRIPES)
    m.enabled = False
    fx = effect(on_card(comp), COMPOUND, p2=[6.0, 20.0, 12.0], p3=1, p4=[0, 0, 1])
    set_layer_param(fx[f"{COMPOUND}-0001"], m)


@case("blurnoise_compound_center", frames=frames(2))
def _(comp):
    m = comp.add(STRIPES_WIDE)
    m.enabled = False
    fx = effect(on_scene(comp, bg=False), COMPOUND, p2=[10.0, 4.0], p3=[0, 1], p4=0)
    set_layer_param(fx[f"{COMPOUND}-0001"], m)


@case("blurnoise_compound_self", frames=frames(1))
def _(comp):
    effect(on_card(comp), COMPOUND, p1=0, p2=8.0, p3=1, p4=0)


@case("blurnoise_compound_kernel", frames=frames(4))
def _(comp):
    m = comp.add_solid([1.0, 1.0, 1.0], "map", 160, 120)
    m.enabled = False
    fx = effect(comp.add(KERNEL), COMPOUND, p2=[2.0, 5.0, 10.0, 20.0], p3=1, p4=0)
    set_layer_param(fx[f"{COMPOUND}-0001"], m)


@case("blurnoise_compound_grey", frames=frames(2))
def _(comp):
    m = comp.add_solid([0.5, 0.5, 0.5], "map", 160, 120)
    m.enabled = False
    fx = effect(comp.add(KERNEL), COMPOUND, p2=[10.0, 40.0], p3=1, p4=0)
    set_layer_param(fx[f"{COMPOUND}-0001"], m)


# --- Bilateral Blur: Radius, Threshold, Colorize -----------------------------------------------------------------

@case("blurnoise_bilateral", frames=frames(4))
def _(comp):
    effect(on_scene(comp), BILATERAL, p1=[5.0, 15.0, 8.0, 3.0], p2=[10.0, 30.0, 20.0, 100.0], p3=[1, 1, 0, 1])


@case("blurnoise_bilateral_dot", frames=frames(2), width=64, height=64)
def _(comp):
    effect(comp.add(DOTS), BILATERAL, p1=[4.0, 10.0], p2=[200.0, 200.0], p3=1)


@case("blurnoise_bilateral_patch", frames=frames(6))
def _(comp):
    effect(comp.add(PATCHES), BILATERAL, p1=[5.0, 5.0, 5.0, 10.0, 5.0, 2.0], p2=[10.0, 30.0, 60.0, 200.0, 30.0, 20.0], p3=[1, 1, 1, 1, 0, 1])


@case("blurnoise_bilateral_kernel", frames=frames(2))
def _(comp):
    effect(comp.add(KERNEL), BILATERAL, p1=[5.0, 12.0], p2=200.0, p3=1)


# --- Smart Blur: Radius, Threshold, Mode (Normal, Edge Only, Edge Overlay) ---------------------------------------

@case("blurnoise_smart", frames=frames(4))
def _(comp):
    effect(on_scene(comp), SMART, p1=[3.0, 10.0, 6.0, 6.0], p2=[25.0, 50.0, 30.0, 30.0], p3=[1, 1, 2, 3])


@case("blurnoise_smart_dot", frames=frames(2), width=64, height=64)
def _(comp):
    effect(comp.add(DOTS), SMART, p1=[4.0, 10.0], p2=[100.0, 100.0], p3=1)


@case("blurnoise_smart_patch", frames=frames(10))
def _(comp):
    effect(comp.add(PATCHES), SMART, p1=[3.0, 3.0, 3.0, 3.0, 6.0, 3.0, 1.0, 10.0, 3.0, 3.0], p2=[10.0, 20.0, 30.0, 50.0, 20.0, 20.0, 20.0, 20.0, 50.0, 20.0],
           p3=[1, 1, 1, 1, 1, 2, 2, 2, 2, 3])


@case("blurnoise_smart_ladder", frames=frames(12), width=320, height=60)
def _(comp):
    effect(comp.add(LADDER), SMART, p1=[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 15.0, 20.0, 3.0, 10.0], p2=[20.0] * 10 + [40.0, 40.0], p3=2)


@case("blurnoise_smart_ladder_normal", frames=frames(4), width=320, height=60)
def _(comp):
    effect(comp.add(LADDER), SMART, p1=[3.0, 10.0, 3.0, 10.0], p2=[20.0, 20.0, 40.0, 40.0], p3=1)


@case("blurnoise_bilateral_ladder", frames=frames(4), width=320, height=60)
def _(comp):
    effect(comp.add(LADDER), BILATERAL, p1=[3.0, 3.0, 3.0, 8.0], p2=[10.0, 20.0, 40.0, 20.0], p3=1)


# --- Median: Radius, Operate On Alpha Channel ----------------------------------------------------------------------

@case("blurnoise_median", frames=frames(3))
def _(comp):
    effect(on_plain(comp), MEDIAN, p1=[1, 3, 8], p2=0)


@case("blurnoise_median_alpha", frames=frames(2))
def _(comp):
    effect(on_plain(comp, bg=False), MEDIAN, p1=[2, 5], p2=[1, 0])


# --- Dust & Scratches: Radius, Threshold, Operate On Alpha Channel ------------------------------------------------

@case("blurnoise_dust", frames=frames(4))
def _(comp):
    effect(on_plain(comp), DUST, p1=[2, 5, 5, 3], p2=[0.0, 0.0, 0.1, 0.3], p3=0)


@case("blurnoise_dust_alpha", frames=frames(2))
def _(comp):
    effect(on_plain(comp, bg=False), DUST, p1=[3, 6], p2=[0.05, 0.0], p3=1)


# --- Camera Lens Blur: Blur Radius, Shape, Roundness, Aspect Ratio, Rotation, Diffraction Fringe, (Blur Map: Layer,
# Channel, Placement, Blur Focal Distance, Invert), Highlight Gain, Threshold, Saturation, Repeat Edge Pixels,
# Use "Linear" Working Space -----------------------------------------------------------------------------------------

@case("blurnoise_lens", frames=frames(4))
def _(comp):
    effect(on_scene(comp), LENS, p1=[5.0, 12.0, 8.0, 20.0], p3=[4, 1, 6, 8], p4=[0.0, 0.0, 50.0, 100.0], p5=1.0, p6=[0.0, 30.0, 0.0, 0.0], p7=100.0,
           p11=1, p12=1, p13=0.0, p14=0, p17=0.0, p18=0.8, p19=0.0, p21=0, p22=0)


@case("blurnoise_lens_card", frames=frames(3))
def _(comp):
    effect(on_card(comp), LENS, p1=[6.0, 10.0, 15.0], p3=[2, 3, 4], p4=0.0, p5=[1.0, 2.0, 0.5], p6=[0.0, 15.0, 45.0], p7=100.0,
           p11=1, p12=1, p13=0.0, p14=0, p17=0.0, p18=0.8, p19=0.0, p21=[1, 0, 1], p22=[0, 0, 1])


@case("blurnoise_lens_dot", frames=frames(3), width=64, height=64)
def _(comp):
    effect(comp.add(DOTS), LENS, p1=[6.0, 10.0, 8.0], p3=[4, 1, 2], p4=0.0, p5=1.0, p6=0.0, p7=[100.0, 100.0, 0.0],
           p11=1, p12=1, p13=0.0, p14=0, p17=0.0, p18=0.8, p19=0.0, p21=0, p22=0)


@case("blurnoise_lens_kernel", frames=frames(12))
def _(comp):
    effect(comp.add(KERNEL), LENS, p1=[10.0] * 10 + [4.0, 20.0], p3=[1, 2, 4, 6, 8, 4, 4, 4, 4, 4, 4, 4], p4=[0.0] * 5 + [50.0, 100.0] + [0.0] * 5,
           p5=[1.0] * 7 + [2.0] + [1.0] * 4, p6=[0.0] * 8 + [30.0] + [0.0] * 3, p7=[0.0] * 9 + [100.0, 0.0, 0.0],
           p11=1, p12=1, p13=0.0, p14=0, p17=0.0, p18=1.0, p19=0.0, p21=0, p22=0)


# --- Noise & Grain (approximations) -------------------------------------------------------------------------------

@case("blurnoise_noise_alpha", frames=frames(2))
def _(comp):
    effect(on_scene(comp), NOISE_ALPHA, p1=[1, 2], p2=[30.0, 60.0], p3=[1, 3], p4=1, p5=0.0, p7=0, p8=1)


@case("blurnoise_noise_hls", frames=frames(2))
def _(comp):
    effect(on_scene(comp), NOISE_HLS, p1=[1, 3], p2=[20.0, 10.0], p3=[30.0, 40.0], p4=[20.0, 30.0], p5=[1.0, 3.0], p6=0.0)


@case("blurnoise_noise_hls_auto", frames=frames(2))
def _(comp):
    effect(on_scene(comp), NOISE_HLS_AUTO, p1=2, p2=15.0, p3=30.0, p4=25.0, p5=1.0, p6=24.0)


@case("blurnoise_turbulent", frames=frames(3))
def _(comp):
    effect(on_card(comp), TURBULENT, p1=[1, 4, 3], p2=3, p3=0, p4=[100.0, 150.0, 100.0], p5=0.0, p6=1, p8=0.0, p9=1, p10=[100.0, 50.0, 200.0],
           p13=[80.0, 60.0], p27=0, p15=[6.0, 3.0, 8.0], p17=70.0, p18=56.0, p20=[0.0, 90.0, 0.0], p22=1.5, p23=0, p25=100.0, p26=2)


@case("blurnoise_grain", frames=frames(2))
def _(comp):
    effect(on_scene(comp), GRAIN, p21=3, p27=1, p8=[1.0, 3.0], p7=[1.0, 2.0], p130=1.0, p30=1.0, p5=[0, 1], p6=1.0, p11=100.0, p14=1, p53=0.0, p57=1, p60=0)


#: Comps whose frames come from After Effects' random generators: references are rendered, but no pixel gate.
APPROXIMATIONS = {
    "blurnoise_noise_alpha": "Noise Alpha's values come from After Effects' own random generator; ours are a seeded look-alike",
    "blurnoise_noise_hls": "Noise HLS's values come from After Effects' own random generator; ours are a seeded look-alike",
    "blurnoise_noise_hls_auto": "Noise HLS Auto's values come from After Effects' own random generator; ours are a seeded look-alike",
    "blurnoise_turbulent": "Turbulent Noise's lattice comes from After Effects' own random tables; ours is fractal.ts's hashed lattice",
    "blurnoise_grain": "Add Grain's grain comes from its own random generator and film-stock models; ours is a seeded look-alike",
}

#: Effects whose renderers do not match After Effects yet, by comp name prefix: their references are rendered for
#: the probes, but they stay out of the pixel gate until a renderer passes them.
NOT_MATCHED = {
    "blurnoise_ccrfb": "not matched: CC Radial Fast Blur decays along each ray (about 0.75 per pixel at Amount 10, "
    "toward a power of the distance at 100); ours is a fixed-length zoom",
    "blurnoise_ccrb_": "not matched: CC Radial Blur's sample spacing and weights per Type are not measured; ours is a "
    "uniform zoom or spin",
    "blurnoise_ccvector_": "not matched: CC Vector Blur's step along the map's gradient is not measured",
    "blurnoise_compound": "not matched: Compound Blur's kernel at a given map value (wide and asymmetric, about sigma "
    "2.7 at Maximum Blur 2 to 25 at 20) is not modelled; ours blends Gaussian levels",
    "blurnoise_bilateral": "not matched: Bilateral Blur's spatial kernel is not a Gaussian of Radius (peaked, with long "
    "tails: a 1 px column keeps 66/255 at Radius 5 and 36 at 12) and its range weight is not measured apart from it",
    "blurnoise_smart": "not matched: Smart Blur's threshold depends on Radius and on the extent of the area that "
    "differs (a 20-level step is an edge on a 20 px patch but not on a 4 px one at Radius 3), and Normal mode averages "
    "the ladder patches more widely than a uniform window",
}

#: Frames the pixel report accepts with a mean error of at most 1/255.
KNOWN: dict[str, str] = {}

suite.save()
manifest_path = REFS / suite.manifest_file
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
if KNOWN:
    manifest["known"] = KNOWN
reasons = dict(APPROXIMATIONS)
for c in manifest["comps"]:
    for prefix, reason in NOT_MATCHED.items():
        if c["comp"].startswith(prefix):
            reasons[c["comp"]] = reason
approx = {
    "project": manifest["project"],
    "comps": [c for c in manifest["comps"] if c["comp"] in reasons],
    "reasons": reasons,
}
manifest["comps"] = [c for c in manifest["comps"] if c["comp"] not in reasons]
manifest_path.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
(REFS / "blurnoise.approximations.json").write_text(json.dumps(approx, indent=1) + "\n", encoding="utf-8")
