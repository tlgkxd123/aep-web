# Builds refs/fixtures/generate2.aep: the Generate effects of src/render/effects/generateExtra.ts on a tiled
# card with translucent and missing cells (and on a star with alpha edges), with every parameter each case
# depends on set. Number, point and colour lists, and popups given as lists, are keyed one value per frame.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_generate2.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BG, ORANGE, TEAL, MaskMode, Shape, Suite, add, add_effect, add_mask, fill, install_effects, rect, shape_group, stroke, tr  # noqa: E402

EFFECTS = [
    "ADBE Checkerboard",
    "ADBE Circle",
    "ADBE ELLIPSE",
    "ADBE Grid",
    "ADBE Laser",
    "ADBE Eyedropper Fill",
    "CC Light Sweep",
]
suite = Suite("generate2")
install_effects(suite, EFFECTS)
case = suite.case
folder = suite.folder

CELL_COLORS = [
    [0.95, 0.85, 0.2], [0.1, 0.2, 0.6], [0.85, 0.2, 0.25], [0.2, 0.75, 0.35],
    [0.6, 0.3, 0.8], [1.0, 1.0, 1.0], [0.05, 0.05, 0.05], [0.95, 0.55, 0.1],
    [0.3, 0.85, 0.9], [0.5, 0.5, 0.5], [0.9, 0.4, 0.7], [0.15, 0.45, 0.3],
]
#: Cells of the card left out, and drawn at half opacity.
HOLES = {(2, 1), (5, 4)}
TRANSLUCENT = {(1, 3), (6, 1), (3, 5)}


def card():
    """160x120 of 20 px coloured cells: hard edges, two cells missing and three at half opacity."""
    inner = folder.add_comp("generate2_card", 160, 120, 1.0, 1.0, 24.0)
    for j in range(6):
        for i in range(8):
            if (i, j) in HOLES:
                continue
            s = inner.add_solid(CELL_COLORS[(j * 8 + i) % len(CELL_COLORS)], f"c{i}_{j}", 20, 20)
            tr(s, "ADBE Position").value = [i * 20 + 10, j * 20 + 10, 0.0]
            if (i, j) in TRANSLUCENT:
                tr(s, "ADBE Opacity").value = 50.0
    return inner


CARD = card()


def on_card(comp):
    comp.add_solid(BG, "bg")
    return comp.add(CARD)


def star(comp):
    comp.add_solid(BG, "bg")
    layer = comp.add_shape()
    g = shape_group(layer)
    add(g, "ADBE Vector Shape - Star", **{"ADBE Vector Star Points": 5.0, "ADBE Vector Star Outer Radius": 50.0, "ADBE Vector Star Inner Radius": 22.0})
    stroke(g, TEAL, 4.0)
    fill(g, ORANGE)
    return layer


def effect(layer, match_name, **params):
    """add_effect where a list for a number or popup parameter, or a list of lists, is keyed one value per frame."""
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


def rgba(c):
    return [*c, 1.0]


# Checkerboard, Circle and Grid share their Blending Mode menu; stored values count its separators.
NONE, NORMAL, STENCIL, ADD, MULTIPLY, SCREEN, OVERLAY, SOFT, HARD = 1, 2, 3, 5, 6, 7, 8, 9, 10
DODGE, BURN, DARKEN, LIGHTEN, DIFFERENCE, EXCLUSION, HUE, SATURATION, COLOR, LUMINOSITY = 12, 13, 15, 16, 17, 18, 20, 21, 22, 23
BLENDS = [NORMAL, STENCIL, ADD, MULTIPLY, SCREEN, OVERLAY, SOFT, HARD, DODGE, BURN, DARKEN, LIGHTEN, DIFFERENCE, EXCLUSION, HUE, SATURATION, COLOR, LUMINOSITY]


@case("generate2_checker", frames=frames(5))
def _(comp):
    effect(on_card(comp), "ADBE Checkerboard", p1=[30.0, 20.0], p2=[1, 2, 3, 1, 3], p3=[52.0, 37.0], p4=[13.0, 13.0, 25.0, 13.0, 31.5], p5=[10.0, 10.0, 10.0, 10.0, 17.25],
           p7=[0.0, 0.0, 0.0, 5.0, 2.0], p8=[0.0, 0.0, 0.0, 3.0, 8.0], p10=rgba(ORANGE), p11=100.0, p12=NONE)


@case("generate2_checker_blend", frames=frames(len(BLENDS)))
def _(comp):
    effect(on_card(comp), "ADBE Checkerboard", p1=[7.0, 5.0], p2=2, p4=16.0, p5=16.0, p7=1.5, p8=1.5, p10=[0.2, 0.6, 1.0, 1.0], p11=80.0, p12=BLENDS)


# One cell over the whole card, without a background: the blend modes' colour and alpha over opaque, translucent
# and empty pixels.
@case("generate2_checker_alpha", frames=frames(len(BLENDS)))
def _(comp):
    effect(comp.add(CARD), "ADBE Checkerboard", p1=[0.0, 0.0], p2=2, p4=400.0, p5=400.0, p7=0.0, p8=0.0, p10=[0.2, 0.6, 1.0, 1.0], p11=80.0, p12=BLENDS)


@case("generate2_circle", frames=frames(7))
def _(comp):
    effect(on_card(comp), "ADBE Circle", p1=[[70.0, 55.0], [70.0, 55.0], [70.0, 55.0], [90.5, 50.25], [70.0, 55.0], [70.0, 55.0], [60.0, 65.0]],
           p2=[30.0, 30.0, 40.0, 25.5, 35.0, 30.0, 45.0], p3=[1, 2, 3, 4, 5, 1, 3], p4=[12.0, 12.0, 12.0, 0.4, 0.3, 12.0, 6.0],
           p6=[0.0, 0.0, 4.0, 0.0, 6.0, 8.0, 3.0], p7=[0.0, 0.0, 0.0, 3.0, 2.0, 0.0, 5.0], p9=[0, 0, 0, 0, 0, 1, 1],
           p10=[1.0, 0.9, 0.2, 1.0], p11=100.0, p12=NONE)


@case("generate2_circle_blend", frames=frames(len(BLENDS)))
def _(comp):
    effect(on_card(comp), "ADBE Circle", p1=[80.0, 60.0], p2=45.0, p3=1, p4=10.0, p6=6.0, p7=0.0, p9=0, p10=[0.9, 0.2, 0.6, 1.0], p11=75.0, p12=BLENDS)


@case("generate2_grid", frames=frames(5))
def _(comp):
    effect(on_card(comp), "ADBE Grid", p1=[10.0, 8.0], p2=[1, 2, 3, 1, 3], p3=[42.0, 30.0], p4=[20.0, 20.0, 27.5, 20.0, 18.0], p5=[14.0, 14.0, 13.0, 14.0, 22.0],
           p6=[3.0, 5.0, 2.5, 4.0, 6.0], p8=[0.0, 0.0, 0.0, 3.0, 1.0], p9=[0.0, 0.0, 0.0, 2.0, 4.0], p11=[0, 0, 0, 0, 1],
           p12=[0.3, 1.0, 0.4, 1.0], p13=100.0, p14=NONE)


@case("generate2_grid_invert", frames=frames(6))
def _(comp):
    effect(on_card(comp), "ADBE Grid", p1=[10.0, 8.0], p2=3, p4=30.0, p5=25.0, p6=[6.0, 6.0, 6.0, 6.0, 3.0, 8.0], p8=[0.0, 1.0, 2.0, 4.0, 1.0, 3.0],
           p9=[0.0, 2.0, 1.0, 4.0, 3.0, 3.0], p11=1, p12=[0.3, 1.0, 0.4, 1.0], p13=100.0, p14=NONE)


@case("generate2_grid_blend", frames=frames(len(BLENDS)))
def _(comp):
    effect(on_card(comp), "ADBE Grid", p1=[3.0, 4.0], p2=2, p4=25.0, p5=25.0, p6=6.0, p8=1.0, p9=1.0, p11=0, p12=[1.0, 0.95, 0.4, 1.0], p13=70.0, p14=BLENDS)


@case("generate2_ellipse", frames=frames(5))
def _(comp):
    effect(on_card(comp), "ADBE ELLIPSE", p1=[[80.0, 60.0], [80.0, 60.0], [70.5, 55.25], [80.0, 60.0], [90.0, 50.0]],
           p2=[100.0, 60.0, 140.0, 80.0, 50.0], p3=[60.0, 90.0, 40.0, 80.0, 70.0], p4=[8.0, 20.0, 4.0, 12.0, 30.0], p5=[0.5, 0.0, 1.0, 0.25, 0.75],
           p6=[1.0, 1.0, 1.0, 1.0], p7=[1.0, 0.2, 0.2, 1.0], p8=[0, 0, 0, 1, 1])


ELLIPSE_SIZES = [(20.0, 20.0), (40.0, 40.0), (60.0, 60.0), (100.0, 100.0), (140.0, 110.0), (30.0, 100.0), (100.0, 30.0), (80.0, 40.0), (50.0, 50.0), (120.0, 60.0)]


@case("generate2_ellipse_sizes", frames=frames(len(ELLIPSE_SIZES)))
def _(comp):
    effect(on_card(comp), "ADBE ELLIPSE", p1=[80.0, 60.0], p2=[w for w, _ in ELLIPSE_SIZES], p3=[h for _, h in ELLIPSE_SIZES], p4=10.0, p5=0.0,
           p6=[1.0, 1.0, 1.0, 1.0], p7=[1.0, 0.2, 0.2, 1.0], p8=0)


@case("generate2_beam", frames=frames(6))
def _(comp):
    effect(on_card(comp), "ADBE Laser", p1=[20.0, 30.0], p2=[140.0, 90.0], p3=[1.0, 0.5, 0.25, 1.0, 0.6, 1.0], p4=[0.5, 0.5, 0.8, 0.0, 0.3, 1.0],
           p5=[8.0, 8.0, 12.0, 4.0, 20.0, 6.0], p6=[8.0, 20.0, 4.0, 16.0, 2.0, 6.0], p7=[0.5, 0.0, 1.0, 0.25, 0.75, 0.5],
           p8=[1.0, 1.0, 1.0, 1.0], p9=[0.2, 0.4, 1.0, 1.0], p10=[0, 0, 1, 1, 0, 0], p11=[0, 0, 0, 1, 1, 0])


@case("generate2_beam_perspective", frames=frames(7))
def _(comp):
    effect(on_card(comp), "ADBE Laser", p1=[20.0, 60.0], p2=[140.0, 60.0], p3=[0.25, 0.5, 0.3, 0.2, 0.4, 1.0, 0.5], p4=[0.8, 0.5, 0.5, 0.6, 0.4, 0.5, 0.25],
           p5=[12.0, 4.0, 8.0, 16.0, 4.0, 10.0, 6.0], p6=[4.0, 12.0, 8.0, 4.0, 16.0, 5.0, 12.0], p7=0.0,
           p8=[1.0, 1.0, 1.0, 1.0], p9=[0.2, 0.4, 1.0, 1.0], p10=1, p11=0)


@case("generate2_eyedropper", frames=frames(6))
def _(comp):
    effect(on_card(comp), "ADBE Eyedropper Fill", p1=[[40.0, 30.0], [100.0, 70.0], [50.0, 30.0], [55.0, 25.0], [110.0, 90.0], [20.0, 70.0]],
           p2=[10.0, 25.0, 3.0, 60.0, 15.5, 30.0], p3=[1, 2, 3, 4, 1, 2], p4=[0, 0, 0, 0, 1, 1], p5=[0.0, 0.0, 0.0, 0.0, 0.0, 0.4])


@case("generate2_light_sweep", frames=frames(6))
def _(comp):
    effect(star(comp), "CC Light Sweep", p1=[[80.0, 60.0], [70.0, 50.0], [90.0, 70.0], [80.0, 60.0], [60.0, 60.0], [100.0, 60.0]],
           p2=[-30.0, 0.0, 45.0, 90.0, -30.0, 20.0], p3=[1, 2, 3, 3, 2, 1], p4=[50.0, 30.0, 20.0, 40.0, 60.0, 25.0],
           p5=[25.0, 50.0, 100.0, 25.0, 40.0, 80.0], p6=[50.0, 0.0, 100.0, 50.0, 80.0, 30.0], p7=[4.0, 2.0, 6.0, 1.0, 3.0, 8.0],
           p8=[1.0, 0.95, 0.85, 1.0], p9=[1, 1, 1, 2, 3, 2])


@case("generate2_light_sweep_band", frames=frames(8))
def _(comp):
    comp.add_solid(BG, "bg")
    layer = comp.add_solid([0.5, 0.5, 0.5], "grey", 160, 120)
    effect(layer, "CC Light Sweep", p1=[[80.0, 60.0], [80.0, 60.0], [80.0, 60.0], [70.0, 50.0], [90.0, 65.0], [80.0, 60.0], [80.0, 60.0], [80.0, 60.0]],
           p2=[0.0, 0.0, 0.0, 30.0, 90.0, -60.0, 0.0, 0.0], p3=[1, 2, 3, 1, 2, 3, 1, 1], p4=[50.0, 40.0, 30.0, 20.0, 60.0, 25.0, 40.0, 40.0],
           p5=[50.0, 80.0, 100.0, 60.0, 40.0, 70.0, 50.0, 50.0], p6=0.0, p7=4.0, p8=[1.0, 0.8, 0.6, 1.0], p9=[1, 1, 1, 1, 1, 1, 2, 3])


@case("generate2_light_sweep_edge", frames=frames(6))
def _(comp):
    effect(star(comp), "CC Light Sweep", p1=[80.0, 60.0], p2=[0.0, 45.0, 90.0, -30.0, 0.0, 0.0], p3=1, p4=200.0, p5=0.0,
           p6=[100.0, 100.0, 100.0, 100.0, 50.0, 100.0], p7=[1.0, 2.0, 4.0, 8.0, 4.0, 3.0], p8=[1.0, 1.0, 1.0, 1.0], p9=1)


HEXAGON = [[40.0, 30.0], [95.0, 18.0], [135.0, 50.0], [120.0, 100.0], [60.0, 105.0], [25.0, 70.0]]


@case("generate2_light_sweep_edge2", frames=frames(8))
def _(comp):
    """The edge light on dark grey (unsaturated) inside an irregular hexagon with a rectangular hole: exact coverage."""
    comp.add_solid(BG, "bg")
    layer = comp.add_solid([0.1, 0.1, 0.1], "grey", 160, 120)
    add_mask(layer, Shape(HEXAGON, [[0, 0]] * 6, [[0, 0]] * 6, closed=True))
    add_mask(layer, rect(65.0, 52.0, 95.0, 72.0), mode=MaskMode.SUBTRACT)
    effect(layer, "CC Light Sweep", p1=[80.0, 60.0], p2=[0.0, 45.0, 90.0, -30.0, 160.0, 0.0, 30.0, 0.0], p3=1, p4=[200.0, 200.0, 200.0, 200.0, 200.0, 200.0, 200.0, 30.0],
           p5=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 40.0], p6=[50.0, 50.0, 25.0, 50.0, 40.0, 50.0, 50.0, 50.0], p7=[1.0, 2.0, 4.0, 8.0, 3.0, 6.0, 4.0, 4.0],
           p8=[1.0, 1.0, 1.0, 1.0], p9=[1, 1, 1, 1, 1, 1, 2, 1])


suite.save()
