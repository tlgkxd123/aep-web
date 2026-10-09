# Builds refs/fixtures/boxblur.aep: Fast Box Blur (ADBE Box Blur2) sweeps of radius
# (whole and fractional), iterations, dimensions and Repeat Edge Pixels, on opaque
# and alpha-edged layers, plus the settings of the user's bass-supreme.aep
# (radius animated up to 100, 5 iterations, repeated edges).
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_boxblur.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BG, ORANGE, TEAL, Suite, add, add_effect, fill, install_effects, shape_group, stroke, tr  # noqa: E402

BOX = "ADBE Box Blur2"
suite = Suite("boxblur")
install_effects(suite, [BOX])
case = suite.case
folder = suite.folder

CELL_COLORS = [
    [0.95, 0.85, 0.2], [0.1, 0.2, 0.6], [0.85, 0.2, 0.25], [0.2, 0.75, 0.35],
    [0.6, 0.3, 0.8], [1.0, 1.0, 1.0], [0.05, 0.05, 0.05], [0.95, 0.55, 0.1],
    [0.3, 0.85, 0.9], [0.5, 0.5, 0.5], [0.9, 0.4, 0.7], [0.15, 0.45, 0.3],
]


def card(w=80, h=60, cell=20):
    """A precomp tiled with differently coloured solids: hard edges and texture, opaque to its bounds."""
    inner = folder.add_comp(f"boxblur_card_{w}x{h}_{cell}", w, h, 1.0, 1.0, 24.0)
    cols = (w + cell - 1) // cell
    for j in range((h + cell - 1) // cell):
        for i in range(cols):
            s = inner.add_solid(CELL_COLORS[(j * cols + i) % len(CELL_COLORS)], f"c{i}_{j}", cell, cell)
            tr(s, "ADBE Position").value = [i * cell + cell / 2, j * cell + cell / 2, 0.0]
    return inner


CARD = card()
WIDE = card(160, 120, 16)


def star(comp):
    layer = comp.add_shape()
    g = shape_group(layer)
    add(g, "ADBE Vector Shape - Star", **{"ADBE Vector Star Points": 5.0, "ADBE Vector Star Outer Radius": 40.0, "ADBE Vector Star Inner Radius": 18.0})
    stroke(g, TEAL, 4.0)
    fill(g, ORANGE)
    return layer


def blur(layer, radius, iterations, dims=1, repeat=0):
    """Fast Box Blur with every parameter set; list values are keyed one per frame."""
    fx = add_effect(layer, BOX)
    for index, value in ((1, radius), (2, iterations), (3, dims), (4, repeat)):
        prop = fx[f"{BOX}-{index:04d}"]
        if isinstance(value, list):
            for k, v in enumerate(value):
                prop.set_value_at_time(k / 24.0, v)
        else:
            prop.value = value
    return fx


def frames(n):
    return tuple(range(n))


RADII = [1.0, 2.0, 3.0, 5.0, 10.0, 25.0]


@case("boxblur_radius", frames=frames(len(RADII)))
def _(comp):
    comp.add_solid(BG, "bg")
    blur(comp.add_solid(ORANGE, "bar", 60, 120), RADII, 1, 2, 0)


@case("boxblur_radius_frac", frames=frames(6))
def _(comp):
    comp.add_solid(BG, "bg")
    blur(comp.add_solid(ORANGE, "bar", 60, 120), [0.25, 0.5, 0.75, 1.5, 2.5, 6.5], 1, 2, 0)


@case("boxblur_iterations", frames=frames(5))
def _(comp):
    comp.add_solid(BG, "bg")
    blur(comp.add_solid(ORANGE, "bar", 60, 120), 6.0, [1, 2, 3, 4, 5], 2, 0)


@case("boxblur_iterations_frac", frames=frames(3))
def _(comp):
    comp.add_solid(BG, "bg")
    blur(comp.add_solid(ORANGE, "bar", 60, 120), 4.5, [2, 3, 5], 2, 0)


@case("boxblur_dims", frames=frames(3))
def _(comp):
    comp.add_solid(BG, "bg")
    blur(comp.add(CARD), 8.0, 3, [1, 2, 3], 0)


@case("boxblur_repeat", frames=frames(3))
def _(comp):
    comp.add_solid(BG, "bg")
    blur(comp.add(CARD), 5.0, 3, [1, 2, 3], 1)


@case("boxblur_alpha", frames=frames(4))
def _(comp):
    blur(star(comp), [2.0, 6.0, 12.0, 30.0], [1, 3, 2, 5], 1, 0)


@case("boxblur_alpha_repeat", frames=frames(2))
def _(comp):
    blur(star(comp), [3.0, 12.0], 3, 1, 1)


@case("boxblur_huge", frames=frames(3))
def _(comp):
    # Radii past the layer's size.
    comp.add_solid(BG, "bg")
    blur(comp.add(CARD), [60.0, 150.0, 400.0], 1, 1, [0, 0, 1])


@case("boxblur_scaled", frames=frames(1))
def _(comp):
    # The blur runs in layer pixels, before the layer transform.
    comp.add_solid(BG, "bg")
    layer = comp.add(CARD)
    tr(layer, "ADBE Scale").value = [150.0, 150.0, 100.0]
    tr(layer, "ADBE Rotate Z").value = 20.0
    blur(layer, 4.0, 2, 1, 0)


STRIPES = [(0, 8, [1.0, 0.0, 0.0]), (8, 16, [0.0, 1.0, 0.0]), (16, 40, [0.0, 0.0, 0.0]), (40, 48, [1.0, 1.0, 1.0]), (48, 64, [0.0, 0.0, 1.0])]


def stripes():
    """64x8 of asymmetric vertical stripes: a horizontal blur's profile shows how the edges extend."""
    inner = folder.add_comp("boxblur_src_stripes", 64, 8, 1.0, 1.0, 24.0)
    for x0, x1, color in STRIPES:
        s = inner.add_solid(color, f"s{x0}", x1 - x0, 8)
        tr(s, "ADBE Position").value = [(x0 + x1) / 2, 4.0, 0.0]
    return inner


STRIPES_SRC = stripes()
EDGE_RADII = [4.0, 16.0, 31.0, 32.0, 40.0, 63.0, 64.0, 100.0, 200.0]

for iterations in (1, 2):

    @case(f"boxblur_edge1d_x{iterations}", frames=frames(len(EDGE_RADII)), width=64, height=8)
    def _(comp, iterations=iterations):
        blur(comp.add(STRIPES_SRC), EDGE_RADII, iterations, 2, 1)


@case("boxblur_user", frames=frames(5))
def _(comp):
    # bass-supreme.aep's intro: Blur Radius animated 0 to 100, 5 iterations, repeated edges, on a full-frame layer.
    blur(comp.add(WIDE), [0.0, 5.0, 20.0, 50.0, 100.0], 5, 1, 1)


suite.save()
