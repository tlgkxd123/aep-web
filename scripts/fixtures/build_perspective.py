# Builds refs/fixtures/perspective.aep: the Perspective effects (Bevel Alpha, Bevel
# Edges, Radial Shadow, 3D Glasses, Basic 3D, CC Spotlight, CC Sphere, CC Cylinder,
# CC Environment) on alpha-edged shapes and textured cards, and the Time effects
# (Posterize Time, Echo, Time Difference, Time Displacement, CC Wide Time, CC Force
# Motion Blur) on a precomp whose shapes move and change colour, sampled at several
# frames. Each comp tiles several settings of one effect in 160x120 cells. Every
# parameter a cell depends on is set.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_perspective.py
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BG, ORANGE, TEAL, Suite, TrackMatteType, add, add_effect, add_mask, fill, install_effects, rect, set_layer_param, shape_group, stroke, tr  # noqa: E402

EFFECTS = [
    "ADBE Bevel Alpha",
    "ADBE Bevel Edges",
    "ADBE Radial Shadow",
    "ADBE 3D Glasses2",
    "ADBE Basic 3D",
    "CC Spotlight",
    "CC Sphere",
    "CC Cylinder",
    "CC Environment",
    "ADBE Posterize Time",
    "ADBE Echo",
    "ADBE Difference",
    "ADBE Time Displacement",
    "CC Wide Time",
    "CC Force Motion Blur",
    "ADBE Fill",
]
suite = Suite("perspective")
install_effects(suite, EFFECTS)
folder = suite.folder

CELL_W, CELL_H = 160, 120
CELL_COLORS = [
    [0.95, 0.85, 0.2], [0.1, 0.2, 0.6], [0.85, 0.2, 0.25], [0.2, 0.75, 0.35],
    [0.6, 0.3, 0.8], [1.0, 1.0, 1.0], [0.05, 0.05, 0.05], [0.95, 0.55, 0.1],
    [0.3, 0.85, 0.9], [0.5, 0.5, 0.5], [0.9, 0.4, 0.7], [0.15, 0.45, 0.3],
]


def card(w=80, h=60, cell=20):
    """A precomp tiled with differently coloured solids: hard edges and texture, opaque to its bounds."""
    inner = folder.add_comp(f"perspective_card_{w}x{h}_{cell}", w, h, 1.0, 1.0, 24.0)
    cols = (w + cell - 1) // cell
    for j in range((h + cell - 1) // cell):
        for i in range(cols):
            s = inner.add_solid(CELL_COLORS[(j * cols + i) % len(CELL_COLORS)], f"c{i}_{j}", cell, cell)
            tr(s, "ADBE Position").value = [i * cell + cell / 2, j * cell + cell / 2, 0.0]
    return inner


CARD = card()
WIDE_CARD = card(160, 120, 20)


def star_comp():
    """A 100x100 precomp with a five-pointed orange star outlined in teal at its centre: soft alpha edges."""
    inner = folder.add_comp("perspective_star", 100, 100, 1.0, 1.0, 24.0)
    layer = inner.add_shape()
    tr(layer, "ADBE Position").value = [50.0, 50.0, 0.0]
    g = shape_group(layer)
    add(g, "ADBE Vector Shape - Star", **{"ADBE Vector Star Points": 5.0, "ADBE Vector Star Outer Radius": 32.0, "ADBE Vector Star Inner Radius": 15.0})
    stroke(g, TEAL, 4.0)
    fill(g, ORANGE)
    return inner


STAR = star_comp()


def soft_comp():
    """An 80x60 precomp: the tiled card through the luma of a radial white-to-black gradient, a soft-edged matte."""
    inner = folder.add_comp("perspective_soft", 80, 60, 1.0, 1.0, 24.0)
    texture = inner.add(CARD)
    matte = inner.add_shape()
    tr(matte, "ADBE Position").value = [40.0, 30.0, 0.0]
    g = shape_group(matte)
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [80.0, 60.0]})
    add(g, "ADBE Vector Graphic - G-Fill", **{"ADBE Vector Grad Type": 2.0, "ADBE Vector Grad Start Pt": [0.0, 0.0], "ADBE Vector Grad End Pt": [34.0, 0.0]})
    texture.set_track_matte(matte, TrackMatteType.LUMA)
    return inner


SOFT = soft_comp()


def mover():
    """A 2 s precomp: an orange solid sliding right and down over a solid sliding left and up while Fill changes its
    colour, both by whole pixels a frame so that their edges stay on pixel boundaries at frame times (echoes,
    differences and frame means would weigh antialiased edges, which AE and the renderer draw differently)."""
    inner = folder.add_comp("perspective_mover", CELL_W, CELL_H, 1.0, 2.0, 24.0)
    tinted = inner.add_solid([1.0, 1.0, 1.0], "tinted", 30, 30)
    pos = tr(tinted, "ADBE Position")
    pos.set_value_at_time(0.0, [CELL_W / 2 + 48.0, CELL_H / 2 + 30.0, 0.0])
    pos.set_value_at_time(2.0, [CELL_W / 2 - 48.0, CELL_H / 2 - 18.0, 0.0])
    fx = add_effect(tinted, "ADBE Fill")
    fx["ADBE Fill-0001"].value = 0
    fx["ADBE Fill-0002"].set_value_at_time(0.0, TEAL + [1.0])
    fx["ADBE Fill-0002"].set_value_at_time(2.0, [0.9, 0.2, 0.7, 1.0])
    fx["ADBE Fill-0005"].value = 1.0
    fx["ADBE Fill-0006"].value = 0
    fx["ADBE Fill-0007"].value = 0
    square = inner.add_solid(ORANGE, "square", 36, 36)
    pos = tr(square, "ADBE Position")
    pos.set_value_at_time(0.0, [CELL_W / 2 - 48.0, CELL_H / 2 - 24.0, 0.0])
    pos.set_value_at_time(2.0, [CELL_W / 2 + 48.0, CELL_H / 2 + 24.0, 0.0])
    return inner


MOVER = mover()


def gradient_comp(horizontal):
    """A 160x120 precomp filled with a black-to-white linear gradient, left to right or top to bottom."""
    inner = folder.add_comp(f"perspective_gradient_{'h' if horizontal else 'v'}", CELL_W, CELL_H, 1.0, 1.0, 24.0)
    layer = inner.add_shape()
    tr(layer, "ADBE Position").value = [CELL_W / 2, CELL_H / 2, 0.0]
    g = shape_group(layer)
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [float(CELL_W), float(CELL_H)]})
    add(
        g,
        "ADBE Vector Graphic - G-Fill",
        **{
            "ADBE Vector Grad Start Pt": [-CELL_W / 2, 0.0] if horizontal else [0.0, -CELL_H / 2],
            "ADBE Vector Grad End Pt": [CELL_W / 2, 0.0] if horizontal else [0.0, CELL_H / 2],
        },
    )
    return inner


GRADIENT_H = gradient_comp(True)
GRADIENT_V = gradient_comp(False)


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


def grid(name, cells, cols, frames, setup=None):
    """A comp of 160x120 cells over the background; each cell function builds its layer, which is placed at the cell's centre."""
    rows = math.ceil(len(cells) / cols)

    @suite.case(name, frames=frames, width=cols * CELL_W, height=rows * CELL_H)
    def _(comp):
        comp.add_solid(BG, "bg")
        shared = setup(comp) if setup else None
        for i, cell in enumerate(cells):
            layer = cell(comp, shared) if setup else cell(comp)
            tr(layer, "ADBE Position").value = [(i % cols) * CELL_W + CELL_W / 2, (i // cols) * CELL_H + CELL_H / 2, 0.0]


def on(source, match_name, configure=None, **params):
    """A cell: `source` with the effect; `configure(layer, fx)` may adjust both afterwards."""

    def cell(comp):
        layer = comp.add(source)
        fx = effect(layer, match_name, **params)
        if configure:
            configure(layer, fx)
        return layer

    return cell


def masked(x0, y0, x1, y1):
    """A hard rectangular mask: the renderer's feather is an approximation of AE's (see the mask_feather known frame)."""
    return lambda layer, fx: add_mask(layer, rect(x0, y0, x1, y1))


# --- Time ------------------------------------------------------------------------------

grid(
    "perspective_posterize_time",
    [
        lambda comp: comp.add(MOVER),
        on(MOVER, "ADBE Posterize Time", p1=8.0),
        on(MOVER, "ADBE Posterize Time", p1=5.0),
        on(MOVER, "ADBE Posterize Time", p1=10.0),
        on(MOVER, "ADBE Posterize Time", masked(10.0, 10.0, 120.0, 100.0), p1=6.0),
    ],
    3,
    tuple(range(12)),
)


def shifted(layer, fx):
    layer.start_time = -0.5


echo = lambda configure=None, **params: on(MOVER, "ADBE Echo", configure, **params)  # noqa: E731
grid(
    "perspective_echo",
    [echo(p1=-2.0 / 24.0, p2=4, p3=0.8, p4=0.7, p5=op) for op in range(1, 8)]
    + [
        echo(p1=3.0 / 24.0, p2=2, p3=1.0, p4=0.5, p5=6),
        echo(p1=-0.07, p2=3, p3=0.6, p4=0.9, p5=1),
        echo(masked(20.0, 15.0, 110.0, 95.0), p1=-3.0 / 24.0, p2=3, p3=1.0, p4=0.6, p5=2),
        echo(shifted, p1=-2.0 / 24.0, p2=2, p3=1.0, p4=0.5, p5=1),
    ],
    4,
    (2, 9, 16, 23),
)


def target_self(layer, fx):
    set_layer_param(fx["ADBE Difference-0001"], layer)


def difference(target=target_self, **params):
    return on(MOVER, "ADBE Difference", target, **params)


def difference_other(comp):
    other = comp.add(WIDE_CARD)
    other.enabled = False
    tr(other, "ADBE Position").value = [CELL_W / 2, CELL_H / 2, 0.0]
    layer = comp.add(MOVER)
    fx = effect(layer, "ADBE Difference", p2=0.0, p3=60.0, p4=0, p5=1)
    set_layer_param(fx["ADBE Difference-0001"], other)
    return layer


grid(
    "perspective_time_difference",
    [difference(p2=-0.125, p3=50.0, p4=0, p5=alpha) for alpha in (1, 2, 3, 4, 5, 7, 8, 10, 11)]
    + [difference(p2=-0.125, p3=80.0, p4=1, p5=5), difference(p2=0.25, p3=20.0, p4=0, p5=1), difference_other],
    4,
    (6, 15),
)


def displacement(map_comp, **params):
    def cell(comp):
        grad = comp.add(map_comp)
        grad.enabled = False
        layer = comp.add(MOVER)
        fx = effect(layer, "ADBE Time Displacement", **params)
        set_layer_param(fx["ADBE Time Displacement-0001"], grad)
        return layer

    return cell


grid(
    "perspective_time_displacement",
    [
        displacement(GRADIENT_H, p2=0.5, p3=60.0, p4=1),
        displacement(GRADIENT_V, p2=-0.4, p3=6.0, p4=1),
        displacement(GRADIENT_H, p2=0.3, p3=24.0, p4=0),
    ],
    3,
    (6, 15),
)

grid(
    "perspective_wide_time",
    [on(MOVER, "CC Wide Time", p1=f, p2=b, p3=2) for f, b in ((2, 2), (0, 4), (3, 1))]
    + [on(MOVER, "CC Force Motion Blur", p1=n, p2=1, p3=a, p5=ph, p4=2) for n, a, ph in ((8, 180.0, 0.0), (16, 360.0, 0.0), (5, 90.0, -90.0))],
    3,
    (2, 9, 16, 23),
)

# --- Perspective -----------------------------------------------------------------------

grid(
    "perspective_bevel_alpha",
    [
        on(STAR, "ADBE Bevel Alpha", p1=[4.0, 10.0, 2.0], p2=[-60.0, 45.0, 150.0], p3=[1.0, 1.0, 1.0, 1.0], p4=[0.6, 1.0, 0.3]),
        on(STAR, "ADBE Bevel Alpha", p1=[6.0, 20.0, 1.0], p2=[-120.0, 0.0, -60.0], p3=[1.0, 0.6, 0.2, 1.0], p4=[0.8, 0.5, 1.0]),
        on(CARD, "ADBE Bevel Alpha", p1=[5.0, 12.0, 30.0], p2=[-60.0, 30.0, 90.0], p3=[1.0, 1.0, 1.0, 1.0], p4=[0.5, 0.9, 0.4]),
        on(SOFT, "ADBE Bevel Alpha", p1=[3.0, 8.0, 15.0], p2=-60.0, p3=[0.2, 0.9, 1.0, 1.0], p4=0.7),
    ],
    2,
    (0, 1, 2),
)



def grey_comp():
    """A 100x80 precomp filled with mid grey: bevel light and shade show unclipped."""
    inner = folder.add_comp("perspective_grey", 100, 80, 1.0, 1.0, 24.0)
    inner.add_solid([0.5, 0.5, 0.5], "grey", 100, 80)
    return inner


GREY = grey_comp()

grid(
    "perspective_bevel_probe",
    [
        on(GREY, "ADBE Bevel Alpha", p1=5.0, p2=90.0, p3=[1.0, 1.0, 1.0, 1.0], p4=1.0),
        on(GREY, "ADBE Bevel Alpha", p1=5.0, p2=45.0, p3=[1.0, 1.0, 1.0, 1.0], p4=1.0),
        on(GREY, "ADBE Bevel Alpha", p1=20.0, p2=90.0, p3=[1.0, 1.0, 1.0, 1.0], p4=0.5),
        on(GREY, "ADBE Bevel Edges", p1=0.1, p2=90.0, p3=[1.0, 1.0, 1.0, 1.0], p4=1.0),
        on(GREY, "ADBE Bevel Edges", p1=0.1, p2=45.0, p3=[1.0, 1.0, 1.0, 1.0], p4=1.0),
        on(GREY, "ADBE Bevel Edges", p1=0.3, p2=90.0, p3=[1.0, 1.0, 1.0, 1.0], p4=0.5),
    ],
    3,
    (0,),
)

grid(
    "perspective_bevel_edges",
    [
        on(CARD, "ADBE Bevel Edges", p1=[0.1, 0.25, 0.04], p2=[-60.0, 45.0, 170.0], p3=[1.0, 1.0, 1.0, 1.0], p4=[0.4, 1.0, 0.7]),
        on(WIDE_CARD, "ADBE Bevel Edges", p1=[0.15, 0.4, 0.5], p2=[-100.0, 20.0, 0.0], p3=[0.3, 0.8, 1.0, 1.0], p4=[0.6, 0.25, 0.5]),
        on(STAR, "ADBE Bevel Edges", p1=[0.1, 0.2, 0.05], p2=[-60.0, 90.0, 200.0], p3=[1.0, 1.0, 1.0, 1.0], p4=[0.6, 0.8, 0.3]),
        on(CARD, "ADBE Bevel Edges", masked(8.0, 6.0, 72.0, 54.0), p1=0.12, p2=-60.0, p3=[1.0, 1.0, 1.0, 1.0], p4=0.5),
    ],
    2,
    (0, 1, 2),
)


grid(
    "perspective_radial_shadow",
    [
        on(STAR, "ADBE Radial Shadow", p1=[0.0, 0.0, 0.0, 1.0], p2=[0.5, 0.8, 1.0], p3=[[30.0, 20.0], [90.0, 10.0], [50.0, 95.0]], p4=[10.0, 25.0, 50.0], p5=0.0, p6=1, p7=1.0, p8=0, p9=0),
        on(STAR, "ADBE Radial Shadow", p1=[0.8, 0.1, 0.1, 1.0], p2=0.7, p3=[40.0, 25.0], p4=[15.0, 15.0, 30.0], p5=[5.0, 20.0, 50.0], p6=1, p7=1.0, p8=0, p9=1),
        on(STAR, "ADBE Radial Shadow", p1=[0.0, 0.0, 0.2, 1.0], p2=0.9, p3=[45.0, 35.0], p4=[20.0, 40.0, 60.0], p5=[0.0, 10.0, 3.0], p6=1, p7=1.0, p8=[1, 0, 1], p9=1),
        on(SOFT, "ADBE Radial Shadow", p1=[0.0, 0.0, 0.0, 1.0], p2=[0.6, 1.0, 0.8], p3=[10.0, 5.0], p4=[20.0, 30.0, 40.0], p5=[0.0, 5.0, 0.0], p6=2, p7=[1.0, 0.5, 2.0], p8=0, p9=1),
    ],
    2,
    (0, 1, 2),
)


def block_comp():
    """A 100x100 precomp with a white 40x40 solid at its centre: straight edges for Softness's profile."""
    inner = folder.add_comp("perspective_block", 100, 100, 1.0, 1.0, 24.0)
    inner.add_solid([1.0, 1.0, 1.0], "block", 40, 40)
    return inner


BLOCK = block_comp()
alone = dict(p3=[50.0, 50.0], p4=0.0, p8=1, p9=1)
grid(
    "perspective_radial_shadow_probe",
    [
        on(BLOCK, "ADBE Radial Shadow", p1=[0.0, 0.0, 0.0, 1.0], p2=1.0, p5=10.0, p6=1, p7=1.0, **alone),
        on(BLOCK, "ADBE Radial Shadow", p1=[0.0, 0.0, 0.0, 1.0], p2=1.0, p5=30.0, p6=1, p7=1.0, **alone),
        on(SOFT, "ADBE Radial Shadow", p1=[0.0, 0.0, 0.0, 1.0], p2=1.0, p5=0.0, p6=2, p7=1.0, **alone),
        on(SOFT, "ADBE Radial Shadow", p1=[0.0, 0.0, 1.0, 1.0], p2=1.0, p5=0.0, p6=2, p7=0.5, **alone),
        on(SOFT, "ADBE Radial Shadow", p1=[0.0, 0.0, 0.0, 1.0], p2=0.5, p5=0.0, p6=1, p7=1.0, **alone),
        on(SOFT, "ADBE Radial Shadow", p1=[0.0, 0.0, 0.0, 1.0], p2=1.0, p3=[40.0, 30.0], p4=15.0, p5=0.0, p6=2, p7=1.0, p8=0, p9=1),
    ],
    3,
    (0,),
)


def glasses_views(comp):
    left = comp.add(CARD)
    left.enabled = False
    right = comp.add(STAR)
    right.enabled = False
    return left, right


def glasses(view, **params):
    def cell(comp, views):
        layer = comp.add(WIDE_CARD)
        fx = effect(layer, "ADBE 3D Glasses2", p5=view, **params)
        set_layer_param(fx["ADBE 3D Glasses2-0001"], views[0])
        set_layer_param(fx["ADBE 3D Glasses2-0002"], views[1])
        return layer

    return cell


grid(
    "perspective_3d_glasses",
    [glasses(view, p3=6.0, p7=-4.0, p8=1, p4=0, p6=12.0) for view in (1, 2, 3, 4, 6, 7, 9, 10, 12)] + [glasses(6, p3=-10.0, p7=3.0, p8=1, p4=1, p6=8.0)],
    4,
    (0,),
    glasses_views,
)



def glasses_solids(comp):
    left = comp.add_solid([0.9, 0.3, 0.2], "left", 40, 30)
    left.enabled = False
    right = comp.add_solid([0.2, 0.7, 0.4], "right", 30, 40)
    right.enabled = False
    return left, right


def glasses_on_grey(view, **params):
    def cell(comp, views):
        layer = comp.add(GREY)
        fx = effect(layer, "ADBE 3D Glasses2", p5=view, p8=1, p4=0, **params)
        set_layer_param(fx["ADBE 3D Glasses2-0001"], views[0])
        set_layer_param(fx["ADBE 3D Glasses2-0002"], views[1])
        return layer

    return cell


grid(
    "perspective_3d_glasses_probe",
    [
        glasses_on_grey(6, p3=0.0, p7=0.0, p6=0.0),
        glasses_on_grey(6, p3=10.0, p7=0.0, p6=0.0),
        glasses_on_grey(6, p3=0.0, p7=10.0, p6=0.0),
        glasses_on_grey(4, p3=10.0, p7=6.0, p6=0.0),
        glasses_on_grey(1, p3=10.0, p7=6.0, p6=0.0),
        glasses_on_grey(2, p3=10.0, p7=6.0, p6=0.0),
        glasses_on_grey(3, p3=0.0, p7=0.0, p6=0.0),
        glasses_on_grey(9, p3=0.0, p7=0.0, p6=12.0),
    ],
    4,
    (0,),
    glasses_solids,
)

grid(
    "perspective_basic_3d",
    [
        on(WIDE_CARD, "ADBE Basic 3D", p1=[30.0, 0.0, -50.0, 20.0], p2=[0.0, 40.0, 20.0, -30.0], p3=[0.0, 0.0, 50.0, -60.0], p4=0, p5=0),
        on(WIDE_CARD, "ADBE Basic 3D", p1=[25.0, -35.0, 10.0, 0.0], p2=[-20.0, 15.0, 30.0, 0.0], p3=[0.0, 30.0, -20.0, 0.0], p4=1, p5=0),
    ],
    2,
    (0, 1, 2, 3),
)

grid(
    "perspective_cc_spotlight",
    [on(WIDE_CARD, "CC Spotlight", p1=[[20.0, 10.0], [140.0, 20.0], [80.0, 0.0]], p2=[80.0, 60.0], p3=[50.0, 30.0, 80.0], p4=[20.0, 35.0, 15.0], p5=[0.25, 0.6, 0.1], p6=[1.0, 1.0, 1.0, 1.0], p7=[75.0, 100.0, 150.0], p8=4)]
    + [on(WIDE_CARD, "CC Spotlight", p1=[30.0, 20.0], p2=[90.0, 70.0], p3=50.0, p4=25.0, p5=0.3, p6=[1.0, 0.8, 0.4, 1.0], p7=100.0, p8=mode) for mode in (1, 2, 3)],
    2,
    (0, 1, 2),
)

grid(
    "perspective_cc_sphere",
    [
        on(WIDE_CARD, "CC Sphere", p2=[0.0, 20.0, -30.0], p3=[0.0, 45.0, 90.0], p4=[0.0, 0.0, 15.0], p26=1, p6=[50.0, 40.0, 55.0], p7=[80.0, 60.0], p8=1, p10=100.0, p11=[1.0, 1.0, 1.0, 1.0], p12=40.0, p13=-85.0, p16=10.0, p17=100.0, p18=10.0, p19=0.05, p20=100.0, p21=0.0, p23=0, p24=0),
        on(WIDE_CARD, "CC Sphere", p2=30.0, p3=60.0, p4=0.0, p26=1, p6=45.0, p7=[80.0, 60.0], p8=[2, 3, 1], p10=60.0, p11=[1.0, 0.9, 0.7, 1.0], p12=20.0, p13=30.0, p16=40.0, p17=60.0, p18=40.0, p19=0.1, p20=50.0, p21=0.0, p23=0, p24=0),
    ],
    2,
    (0, 1, 2),
)

grid(
    "perspective_cc_cylinder",
    [
        on(WIDE_CARD, "CC Cylinder", p2=[60.0, 100.0, 40.0], p4=0.0, p5=0.0, p6=[0.0, 50.0, -50.0], p9=[0.0, 20.0, 0.0], p10=[30.0, 60.0, 0.0], p11=[0.0, 0.0, 30.0], p27=3, p13=1, p15=100.0, p16=[1.0, 1.0, 1.0, 1.0], p17=25.0, p18=-45.0, p21=50.0, p22=50.0, p23=50.0, p24=0.04, p25=100.0),
        on(WIDE_CARD, "CC Cylinder", p2=70.0, p4=0.0, p5=0.0, p6=0.0, p9=10.0, p10=40.0, p11=0.0, p27=3, p13=[2, 3, 1], p15=80.0, p16=[1.0, 1.0, 1.0, 1.0], p17=40.0, p18=30.0, p21=30.0, p22=70.0, p23=20.0, p24=0.1, p25=50.0),
    ],
    2,
    (0, 1, 2),
)


def environment_map(comp):
    env = comp.add(WIDE_CARD)
    env.enabled = False
    return env


def environment(mapping):
    def cell(comp, env):
        layer = comp.add(CARD)
        fx = effect(layer, "CC Environment", p4=mapping, p2=[0.0, 40.0], p3=0, p5=[0.0, 50.0])
        set_layer_param(fx["CC Environment-0001"], env)
        return layer

    return cell


grid("perspective_cc_environment", [environment(m) for m in (1, 2, 3)], 3, (0, 1), environment_map)

suite.save()
