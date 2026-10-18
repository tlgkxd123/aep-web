# Builds refs/fixtures/keying.aep: the stock Keying and Matte effects rendered by
# src/render/effects/keying.ts, on a 1200-colour palette (green and blue screen
# colours, colours near them, a 7x7x7 grid, every grey level, partly transparent
# cells) and on a keyed scene with soft edges. Each comp tiles four copies of a
# source, each with its own settings; a parameter given as a list is keyed one
# value per frame. The palette's colours go to refs/fixtures/keying.palette.json
# for the fitting scripts (scripts/check-keying-cells.ts).
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_keying.py
import json
import os
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import REFS, Suite, add, add_effect, fill, gtr, install_effects, set_layer_param, shape_group, tr  # noqa: E402

EFFECTS = [
    "ADBE Linear Color Key2",
    "ADBE Color Key",
    "ADBE Luma Key",
    "ADBE Extract",
    "ADBE Color Range",
    "ADBE Color Difference Key",
    "ADBE Difference Matte2",
    "ADBE Spill Suppressor",
    "ADBE Spill2",
    "ADBE Matte Choker",
    "CC Simple Wire Removal",
    "ADBE KeyCleaner",
]
suite = Suite("keying")
install_effects(suite, EFFECTS)
folder = suite.folder

GREEN8 = [26, 204, 51]
BLUE8 = [20, 60, 230]
ORANGE8 = [240, 128, 20]
TEAL8 = [26, 178, 166]


def f(c8):
    return [v / 255.0 for v in c8]


GREEN, BLUE, ORANGE, TEAL = f(GREEN8), f(BLUE8), f(ORANGE8), f(TEAL8)
RECT, ELLIPSE = "ADBE Vector Shape - Rect", "ADBE Vector Shape - Ellipse"
SIZE = {RECT: "ADBE Vector Rect Size", ELLIPSE: "ADBE Vector Ellipse Size"}


def shape_item(layer, position, shape, size, colour, rotation=0.0, opacity=None):
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", position)
    if rotation:
        gtr(g, "ADBE Vector Rotation", rotation)
    add(g, shape, **{SIZE[shape]: size})
    fill(g, colour, **({"ADBE Vector Fill Opacity": opacity} if opacity is not None else {}))

# --- Sources ---------------------------------------------------------------------

CELL = 4
COLS, ROWS = 40, 30


def palette_colours():
    """(rgb 0-255, opacity %) per cell, in reading order."""
    rng = random.Random(20261016)
    out = []
    steps = [0, 43, 85, 128, 170, 213, 255]
    out += [([r, g, b], 100) for r in steps for g in steps for b in steps]
    for key in (GREEN8, BLUE8):
        for _ in range(150):
            m = rng.choice([2, 4, 8, 12, 20, 30, 45, 70, 100])
            out.append(([max(0, min(255, k + round(rng.uniform(-m, m)))) for k in key], 100))
    out += [([v, v, v], 100) for v in range(256)]
    alpha_colours = [GREEN8, BLUE8, ORANGE8, TEAL8, [255, 255, 255], [0, 0, 0], [128, 128, 128], [200, 60, 60]]
    for i in range(100):
        c = alpha_colours[i % len(alpha_colours)] if i < 64 else [rng.randrange(256) for _ in range(3)]
        out.append((c, [25, 50, 75, 90][(i // 8) % 4]))
    while len(out) < COLS * ROWS:
        out.append(([rng.randrange(256) for _ in range(3)], 100))
    return out


PALETTE = palette_colours()


def cells_layer(comp, colours):
    layer = comp.add_shape()
    for i, (c8, opacity) in enumerate(colours):
        col, row = i % COLS, i // COLS
        g = shape_group(layer)
        gtr(g, "ADBE Vector Position", [col * CELL + CELL / 2 - 80.0, row * CELL + CELL / 2 - 60.0])
        add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [float(CELL), float(CELL)]})
        fill(g, f(c8), **({"ADBE Vector Fill Opacity": float(opacity)} if opacity != 100 else {}))
    return layer


def palette_comp(name, colours):
    comp = folder.add_comp(name, 160, 120, 1.0, 1.0, 24.0)
    cells_layer(comp, colours)
    return comp


def shifted(colours):
    """The palette with each colour moved by a seeded amount (Difference Matte's other layer)."""
    rng = random.Random(7)
    out = []
    for c8, opacity in colours:
        m = rng.choice([0, 0, 2, 5, 10, 20, 35, 60, 100])
        out.append(([max(0, min(255, v + round(rng.uniform(-m, m)))) for v in c8], opacity))
    return out


PALETTE2 = shifted(PALETTE)
PAL = palette_comp("keying_src_palette", PALETTE)
PAL2 = palette_comp("keying_src_palette2", PALETTE2)


def scene_comp():
    """Shapes with antialiased edges over a green screen that leaves the right edge transparent."""
    comp = folder.add_comp("keying_src_scene", 160, 120, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    shape_item(layer, [-10.0, 0.0], RECT, [140.0, 120.0], GREEN)
    shape_item(layer, [-35.0, -15.0], ELLIPSE, [50.0, 40.0], ORANGE)
    shape_item(layer, [25.0, 15.0], RECT, [40.0, 30.0], TEAL, rotation=25.0)
    shape_item(layer, [40.0, -38.0], RECT, [36.0, 22.0], ORANGE, opacity=50.0)
    shape_item(layer, [-5.0, -45.0], RECT, [70.0, 2.5], [1.0, 1.0, 1.0], rotation=8.0)
    shape_item(layer, [-62.0, 30.0], ELLIPSE, [5.0, 5.0], [0.9, 0.9, 0.2])
    shape_item(layer, [66.0, 10.0], ELLIPSE, [30.0, 30.0], [0.8, 0.3, 0.6])
    for i in range(12):
        t = i / 11.0
        mix = [GREEN[c] * (1 - t) + ORANGE[c] * t for c in range(3)]
        shape_item(layer, [-62.0 + i * 8.0, 48.0], RECT, [8.0, 12.0], mix)
    return comp


SCENE = scene_comp()


def blobs_comp():
    """Shapes on transparency with soft (partly transparent) parts, for the matte tools."""
    comp = folder.add_comp("keying_src_blobs", 160, 120, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    shape_item(layer, [-40.0, -20.0], ELLIPSE, [50.0, 40.0], ORANGE)
    shape_item(layer, [30.0, 10.0], RECT, [40.0, 30.0], TEAL, rotation=25.0)
    shape_item(layer, [70.0, -55.0], RECT, [40.0, 30.0], [0.9, 0.9, 0.2])
    shape_item(layer, [-50.0, 40.0], ELLIPSE, [6.0, 6.0], [1.0, 1.0, 1.0])
    shape_item(layer, [-10.0, 40.0], RECT, [3.0, 20.0], [0.2, 0.4, 1.0])
    shape_item(layer, [10.0, -40.0], RECT, [30.0, 16.0], [0.9, 0.2, 0.2], opacity=50.0)
    for i in range(8):
        shape_item(layer, [-70.0 + i * 9.0, 15.0], RECT, [9.0, 9.0], [1.0, 1.0, 1.0], opacity=12.5 * (i + 1))
    return comp


BLOBS = blobs_comp()

# --- Cases ----------------------------------------------------------------------

QUADRANTS = [[80.0, 60.0, 0.0], [240.0, 60.0, 0.0], [80.0, 180.0, 0.0], [240.0, 180.0, 0.0]]


def apply(layer, match_name, params):
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


def fx(match_name, **params):
    build = lambda layer, comp: apply(layer, match_name, params)  # noqa: E731
    build.record = {"effect": match_name, "params": params}
    return build


#: comp -> the effect and parameters of each quadrant, for the fitting scripts.
TILES = {}


def tile_case(name, source, variants, frames=1, bg=None):
    """Four copies of `source` in the quadrants of a 320x240 comp, each set up by one variant."""
    TILES[name] = {"frames": frames, "bg": bg, "tiles": [getattr(v, "record", None) for v in variants]}

    @suite.case(name, frames=tuple(range(frames)), width=320, height=240)
    def _(comp):
        if bg is not None:
            comp.add_solid(bg, "bg")
        for position, variant in zip(QUADRANTS, variants):
            layer = comp.add(source)
            tr(layer, "ADBE Position").value = position
            if variant:
                variant(layer, comp)


def rgba(c):
    return list(c) + [1.0]


tile_case("keying_src", PAL, [None, None, None, None])
tile_case("keying_src_shapes", SCENE, [None, None, None, None])

# Linear Color Key: View 1 final / 3 matte; Match Colors 1 RGB / 2 Hue / 3 Chroma; Key Operation 1 key / 2 keep.
LCK = "ADBE Linear Color Key2"
tile_case("keying_lck_rgb", PAL, [
    fx(LCK, p2=1, p3=rgba(GREEN), p4=1, p5=[10.0, 25.0, 0.0], p6=[10.0, 0.0, 30.0], p7=1),
    fx(LCK, p2=3, p3=rgba(GREEN), p4=1, p5=[10.0, 25.0, 0.0], p6=[10.0, 0.0, 30.0], p7=1),
    fx(LCK, p2=1, p3=rgba(BLUE), p4=1, p5=[5.0, 15.0, 40.0], p6=[20.0, 5.0, 0.0], p7=1),
    fx(LCK, p2=3, p3=rgba(BLUE), p4=1, p5=[5.0, 15.0, 40.0], p6=[20.0, 5.0, 0.0], p7=1),
], frames=3)
tile_case("keying_lck_hue", PAL, [
    fx(LCK, p2=1, p3=rgba(GREEN), p4=2, p5=[10.0, 25.0, 3.0], p6=[10.0, 0.0, 30.0], p7=1),
    fx(LCK, p2=3, p3=rgba(GREEN), p4=2, p5=[10.0, 25.0, 3.0], p6=[10.0, 0.0, 30.0], p7=1),
    fx(LCK, p2=1, p3=rgba(BLUE), p4=3, p5=[10.0, 25.0, 3.0], p6=[10.0, 0.0, 30.0], p7=1),
    fx(LCK, p2=3, p3=rgba(BLUE), p4=3, p5=[10.0, 25.0, 3.0], p6=[10.0, 0.0, 30.0], p7=1),
], frames=3)
tile_case("keying_lck_keep", PAL, [
    fx(LCK, p2=1, p3=rgba(GREEN), p4=1, p5=[15.0, 30.0], p6=[10.0, 20.0], p7=2),
    fx(LCK, p2=[2, 3], p3=rgba(GREEN), p4=3, p5=[15.0, 30.0], p6=[10.0, 20.0], p7=2),
    fx(LCK, p2=1, p3=rgba(ORANGE), p4=2, p5=[15.0, 30.0], p6=[10.0, 20.0], p7=1),
    fx(LCK, p2=1, p3=[rgba(TEAL), rgba([1.0, 1.0, 1.0])], p4=1, p5=[15.0, 30.0], p6=[10.0, 20.0], p7=1),
], frames=2)
tile_case("keying_lck_scene", SCENE, [
    fx(LCK, p2=1, p3=rgba(GREEN), p4=1, p5=12.0, p6=8.0, p7=1),
    fx(LCK, p2=1, p3=rgba(GREEN), p4=2, p5=5.0, p6=10.0, p7=1),
    fx(LCK, p2=1, p3=rgba(GREEN), p4=3, p5=20.0, p6=20.0, p7=1),
    fx(LCK, p2=3, p3=rgba(GREEN), p4=1, p5=30.0, p6=0.0, p7=1),
])
tile_case("keying_lck_chroma", PAL, [
    fx(LCK, p2=3, p3=rgba(GREEN), p4=3, p5=[10.0, 5.0], p6=[20.0, 40.0], p7=1),
    fx(LCK, p2=3, p3=rgba(ORANGE), p4=3, p5=[10.0, 5.0], p6=[20.0, 40.0], p7=1),
    fx(LCK, p2=3, p3=rgba(TEAL), p4=3, p5=[10.0, 5.0], p6=[20.0, 40.0], p7=1),
    fx(LCK, p2=3, p3=rgba(f([200, 80, 160])), p4=3, p5=[10.0, 5.0], p6=[20.0, 40.0], p7=1),
], frames=2)

# Color Key: Key Color, Color Tolerance (0-255), Edge Thin (-5..5), Edge Feather.
CK = "ADBE Color Key"
tile_case("keying_ckey_tol", PAL, [
    fx(CK, p1=rgba(GREEN), p2=[0.0, 10.0, 40.0], p3=0.0, p4=0.0),
    fx(CK, p1=rgba(GREEN), p2=[25.0, 70.0, 120.0], p3=0.0, p4=0.0),
    fx(CK, p1=rgba(BLUE), p2=[5.0, 30.0, 60.0], p3=0.0, p4=0.0),
    fx(CK, p1=[rgba([0.0, 0.0, 0.0]), rgba([1.0, 1.0, 1.0]), rgba(ORANGE)], p2=50.0, p3=0.0, p4=0.0),
], frames=3)
tile_case("keying_ckey_edges", SCENE, [
    fx(CK, p1=rgba(GREEN), p2=[30.0, 30.0, 30.0], p3=[1.0, 3.0, -2.0], p4=0.0),
    fx(CK, p1=rgba(GREEN), p2=30.0, p3=0.0, p4=[2.0, 6.0, 15.0]),
    fx(CK, p1=rgba(GREEN), p2=[30.0, 60.0, 30.0], p3=[-1.0, 2.0, 5.0], p4=[4.0, 1.0, 8.0]),
    fx(CK, p1=rgba(GREEN), p2=[80.0, 30.0, 30.0], p3=[0.0, -5.0, -3.0], p4=[0.0, 3.0, 0.0]),
], frames=3)

# Luma Key: Key Type 1 brighter / 2 darker / 3 similar / 4 dissimilar, Threshold, Tolerance (0-255).
LK = "ADBE Luma Key"
tile_case("keying_luma_types", PAL, [
    fx(LK, p1=1, p2=[128.0, 60.0, 200.0], p3=[0.0, 30.0, 10.0], p4=0.0, p5=0.0),
    fx(LK, p1=2, p2=[128.0, 60.0, 200.0], p3=[0.0, 30.0, 10.0], p4=0.0, p5=0.0),
    fx(LK, p1=3, p2=[128.0, 60.0, 200.0], p3=[0.0, 30.0, 10.0], p4=0.0, p5=0.0),
    fx(LK, p1=4, p2=[128.0, 60.0, 200.0], p3=[0.0, 30.0, 10.0], p4=0.0, p5=0.0),
], frames=3)
tile_case("keying_luma_edges", SCENE, [
    fx(LK, p1=2, p2=140.0, p3=0.0, p4=[2.0, -2.0], p5=0.0),
    fx(LK, p1=1, p2=150.0, p3=0.0, p4=0.0, p5=[3.0, 10.0]),
    fx(LK, p1=3, p2=140.0, p3=40.0, p4=[1.0, -3.0], p5=[5.0, 2.0]),
    fx(LK, p1=4, p2=100.0, p3=50.0, p4=[4.0, 0.0], p5=[0.0, 6.0]),
], frames=2)

# Extract: Channel 1 luminance / 2 red / 3 green / 4 blue / 5 alpha, black and white points and softness, Invert.
EX = "ADBE Extract"
tile_case("keying_extract", PAL, [
    fx(EX, p2=1, p3=[50.0, 0.0, 100.0], p4=[200.0, 128.0, 255.0], p5=[0.0, 40.0, 60.0], p6=[0.0, 30.0, 0.0], p7=0),
    fx(EX, p2=[2, 3, 4], p3=[60.0, 30.0, 120.0], p4=[180.0, 230.0, 240.0], p5=[20.0, 0.0, 40.0], p6=[20.0, 50.0, 10.0], p7=0),
    fx(EX, p2=1, p3=[40.0, 80.0, 0.0], p4=[220.0, 160.0, 100.0], p5=[10.0, 0.0, 80.0], p6=[10.0, 60.0, 0.0], p7=1),
    fx(EX, p2=[5, 1, 3], p3=[60.0, 10.0, 200.0], p4=[255.0, 250.0, 100.0], p5=[50.0, 100.0, 20.0], p6=[0.0, 100.0, 20.0], p7=[0, 0, 1]),
], frames=3)

# Color Range: Fuzziness (0-200), Color Space 1 Lab / 2 YUV / 3 RGB, then min/max of each channel (0-255).
CR = "ADBE Color Range"


def color_range(space, fuzz, box):
    lo1, hi1, lo2, hi2, lo3, hi3 = box
    return fx(CR, p2=fuzz, p3=space, p4=lo1, p5=hi1, p6=lo2, p7=hi2, p8=lo3, p9=hi3)


tile_case("keying_crange", PAL, [
    color_range(1, [0.0, 20.0, 60.0], [120.0, 200.0, 30.0, 90.0, 140.0, 220.0]),
    color_range(2, [0.0, 20.0, 60.0], [100.0, 160.0, 40.0, 110.0, 30.0, 100.0]),
    color_range(3, [0.0, 20.0, 60.0], [0.0, 80.0, 150.0, 255.0, 0.0, 100.0]),
    color_range([1, 2, 3], [10.0, 40.0, 5.0], [[40.0, 90.0, 140.0], [200.0, 220.0, 255.0], [100.0, 0.0, 100.0], [180.0, 140.0, 200.0], [60.0, 150.0, 200.0], [200.0, 255.0, 255.0]]),
], frames=3)

# Color Difference Key: View 1 source ... 6 uncorrected matte, 7 corrected matte, 8 final; levels of partial A, B
# and the matte.
CDK = "ADBE Color Difference Key"
tile_case("keying_cdk_views", PAL, [
    fx(CDK, p2=[8, 6, 2], p3=rgba(GREEN), p4=1, p5=0.0, p6=255.0, p7=1.0, p8=0.0, p9=255.0, p10=0.0, p11=255.0, p12=1.0, p13=0.0, p14=255.0, p15=0.0, p16=255.0, p17=1.0),
    fx(CDK, p2=[4, 7, 8], p3=rgba(GREEN), p4=1, p5=20.0, p6=200.0, p7=1.5, p8=10.0, p9=240.0, p10=30.0, p11=220.0, p12=0.7, p13=0.0, p14=255.0, p15=40.0, p16=200.0, p17=1.2),
    fx(CDK, p2=[8, 6, 3], p3=rgba(BLUE), p4=2, p5=0.0, p6=255.0, p7=1.0, p8=0.0, p9=255.0, p10=0.0, p11=255.0, p12=1.0, p13=0.0, p14=255.0, p15=0.0, p16=255.0, p17=1.0),
    fx(CDK, p2=[5, 7, 8], p3=rgba(BLUE), p4=1, p5=10.0, p6=230.0, p7=0.8, p8=0.0, p9=255.0, p10=0.0, p11=200.0, p12=1.3, p13=20.0, p14=235.0, p15=20.0, p16=230.0, p17=0.9),
], frames=3)

# Difference Matte: View 1 final / 3 matte, Difference Layer (the shifted palette), If Layer Sizes Differ,
# Matching Tolerance and Softness, Blur Before Difference.
DM = "ADBE Difference Matte2"


def diff_matte(**params):
    def build(layer, comp):
        other = next((l for l in comp.layers if l.name == "plate"), None)
        if other is None:
            other = comp.add(PAL2)
            other.name = "plate"
            other.enabled = False
            tr(other, "ADBE Position").value = [80.0, 60.0, 0.0]
        effect = apply(layer, DM, params)
        set_layer_param(effect[f"{DM}-0002"], other)

    build.record = {"effect": DM, "params": params}
    return build


tile_case("keying_dmatte", PAL, [
    diff_matte(p1=1, p3=1, p4=[15.0, 5.0, 30.0], p5=[0.0, 10.0, 20.0], p6=0.0),
    diff_matte(p1=3, p3=1, p4=[15.0, 5.0, 30.0], p5=[0.0, 10.0, 20.0], p6=0.0),
    diff_matte(p1=3, p3=1, p4=[2.0, 50.0, 10.0], p5=[5.0, 30.0, 0.0], p6=0.0),
    diff_matte(p1=[1, 3, 1], p3=1, p4=10.0, p5=10.0, p6=[2.0, 2.0, 6.0]),
], frames=3)

# Spill Suppressor: Color To Suppress, Suppression (0-200).
SP = "ADBE Spill Suppressor"
tile_case("keying_spill", PAL, [
    fx(SP, p1=rgba(GREEN), p3=[100.0, 50.0, 200.0]),
    fx(SP, p1=rgba(BLUE), p3=[100.0, 50.0, 200.0]),
    fx(SP, p1=[rgba(ORANGE), rgba([1.0, 0.0, 0.0]), rgba(TEAL)], p3=[100.0, 150.0, 70.0]),
    fx(SP, p1=[rgba([0.0, 1.0, 0.0]), rgba([0.0, 0.0, 1.0]), rgba([0.5, 0.2, 0.9])], p3=[100.0, 100.0, 120.0]),
], frames=3)

# Advanced Spill Suppressor: Method 1 standard / 2 ultra, Suppression; the ultra settings.
SP2 = "ADBE Spill2"
tile_case("keying_spill2", PAL, [
    fx(SP2, p1=1, p1001=[100.0, 50.0, 25.0]),
    fx(SP2, p1=2, p1001=100.0, p3=rgba(GREEN), p4=[50.0, 20.0, 80.0], p5=[50.0, 0.0, 100.0], p6=[50.0, 80.0, 20.0], p7=[50.0, 0.0, 100.0], p8=[0.0, 50.0, 100.0]),
    fx(SP2, p1=2, p1001=[100.0, 60.0, 100.0], p3=rgba(BLUE), p4=50.0, p5=50.0, p6=50.0, p7=50.0, p8=0.0),
    fx(SP2, p1=2, p1001=100.0, p3=[rgba(GREEN), rgba(ORANGE), rgba(TEAL)], p4=30.0, p5=70.0, p6=40.0, p7=30.0, p8=20.0),
], frames=3)

# Matte Choker: Geometric Softness, Choke, Gray Level Softness (twice), Iterations.
MC = "ADBE Matte Choker"
CHOKES = [
    fx(MC, p1=[4.0, 0.0, 2.0], p2=[75.0, 50.0, -60.0], p3=[0.1, 0.0, 0.5], p4=0.0, p5=0.0, p6=1.0, p7=1),
    fx(MC, p1=[1.0, 8.0, 3.0], p2=[0.0, 100.0, 30.0], p3=[0.5, 1.0, 0.2], p4=0.0, p5=0.0, p6=1.0, p7=1),
    fx(MC, p1=4.0, p2=75.0, p3=0.1, p4=[2.0, 0.0, 5.0], p5=[-50.0, 0.0, 40.0], p6=[0.5, 1.0, 0.2], p7=[1, 1, 3]),
    fx(MC, p1=[0.0, 2.0, 6.0], p2=[127.0, -127.0, 90.0], p3=[0.0, 0.3, 1.0], p4=0.0, p5=0.0, p6=1.0, p7=[1, 2, 1]),
]
tile_case("keying_choker", BLOBS, CHOKES, frames=3, bg=[0.0, 0.0, 0.0])
# The same chokes on transparency, where the output's alpha is the choked matte; keying_blobs is their source.
tile_case("keying_blobs", BLOBS, [None, None, None, None])
tile_case("keying_choker_alpha", BLOBS, CHOKES, frames=3)

# Advanced Spill Suppressor's Standard method alone: Suppression and the Key Color the Ultra settings hold.
tile_case("keying_spill2_std", PAL, [
    fx(SP2, p1=1, p1001=[100.0, 70.0, 40.0]),
    fx(SP2, p1=1, p1001=[100.0, 30.0, 85.0], p3=rgba(BLUE)),
    fx(SP2, p1=1, p1001=[60.0, 100.0, 10.0], p3=rgba(ORANGE)),
    fx(SP2, p1=1, p1001=[100.0, 50.0, 100.0], p3=[rgba([0.5, 0.2, 0.9]), rgba(TEAL), rgba([1.0, 0.0, 0.0])]),
], frames=3)

# CC Simple Wire Removal: Point A, Point B, Removal Style 1 fade / 3 displace / 4 displace horizontal, Thickness,
# Slope, Mirror Blend.
WR = "CC Simple Wire Removal"
tile_case("keying_wire", SCENE, [
    fx(WR, p1=[20.0, 20.0], p2=[140.0, 100.0], p3=1, p4=[4.0, 6.0, 3.0], p5=[0.5, 0.2, 0.9], p6=[0.0, 0.25, 0.6], p7=5),
    fx(WR, p1=[80.0, 5.0], p2=[80.0, 115.0], p3=3, p4=[2.0, 10.0, 8.0], p5=[0.5, 0.0, 1.0], p6=[0.25, 0.0, 1.0], p7=5),
    fx(WR, p1=[10.0, 60.0], p2=[150.0, 50.0], p3=4, p4=[5.0, 3.0, 15.0], p5=[0.7, 0.5, 0.3], p6=[0.5, 0.25, 0.1], p7=5),
    fx(WR, p1=[30.0, 110.0], p2=[120.0, 15.0], p3=3, p4=[12.0, 1.0, 20.0], p5=[0.0, 1.0, 0.5], p6=[0.1, 0.9, 0.3], p7=5),
], frames=3)

# Key Cleaner: Additional Edge Radius, Reduce Chatter, Alpha Contrast, Strength.
KC = "ADBE KeyCleaner"
tile_case("keying_cleaner", BLOBS, [
    fx(KC, p6=[10.0, 3.0, 30.0], p2=0, p16=0.0, p1=100.0),
    fx(KC, p6=10.0, p2=0, p16=[30.0, 70.0, 100.0], p1=100.0),
    fx(KC, p6=[5.0, 20.0, 10.0], p2=0, p16=0.0, p1=[50.0, 25.0, 0.0]),
    fx(KC, p6=10.0, p2=1, p16=[0.0, 50.0, 0.0], p1=100.0),
], frames=3, bg=[0.0, 0.0, 0.0])

# KEYING_TABLES_ONLY=1 writes only the palette and tile tables (the project may be open in aerender).
if not os.environ.get("KEYING_TABLES_ONLY"):
    suite.save()
(REFS / "keying.palette.json").write_text(
    json.dumps({"cell": CELL, "cols": COLS, "palette": PALETTE, "palette2": PALETTE2, "comps": TILES}) + "\n",
    encoding="utf-8",
)
