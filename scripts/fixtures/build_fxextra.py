# Builds refs/fixtures/fxextra.aep: the remaining effects of the user's project
# (Keylight, CC Vignette, Remove Color Matting, Minimax, Superpose 2, Sound Keys,
# Particular) and effects whose plugins are not installed (XMult, Sapphire).
# Parameters start from the instances in that project wherever it has them.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_fxextra.py
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import (  # noqa: E402
    BG,
    ORANGE,
    REFS,
    TEAL,
    Suite,
    _leaves,
    add,
    add_effect,
    fill,
    gtr,
    install_effects,
    py_aep,
    shape_group,
    tr,
)

USER_PROJECT = "C:/Users/schxm/projects/_user/bass-supreme.aep"

suite = Suite("fxextra")
install_effects(
    suite,
    [
        "Keylight 906",
        "CS Vignette",
        "ADBE Remove Color Matting",
        "ADBE Minimax",
        "Keller.io Superpose 2",
        "tc Sound Keys",
        "tc Particular",
        "Fandev XMult",
        "S_Blur",
        "S_Glow",
        "S_Shake",
        "S_ZGlow",
        "S_Flicker",
    ],
)

_user = py_aep.parse(USER_PROJECT).project


def user_effect(comp_name: str, layer_name: str, match_name: str, nth: int = 0):
    comps = [i for i in _user.items.values() if getattr(i, "name", None) == comp_name and hasattr(i, "layers")]
    layer = next(lay for comp in comps for lay in comp.layers if lay.name == layer_name)
    return [fx for fx in layer["ADBE Effect Parade"].properties if fx.match_name == match_name][nth]


def copy_values(src, dst) -> None:
    """Copies the static values of every parameter of an effect instance (layer parameters stay unset)."""
    targets = {leaf.match_name: leaf for leaf in _leaves(dst)}
    for leaf in _leaves(src):
        target = targets.get(leaf.match_name)
        if target is None or getattr(leaf, "_tdpi", None) is not None:
            continue
        try:
            value = leaf.value
            if value is None:
                continue
            target.value = value
        except Exception:  # noqa: BLE001 - groups, layer and custom-data parameters carry no plain value
            pass


def user_fx(layer, comp_name, layer_name, match_name, nth=0, **params):
    fx = add_effect(layer, match_name)
    copy_values(user_effect(comp_name, layer_name, match_name, nth), fx)
    for key, value in params.items():
        fx[f"{match_name}-{int(key[1:]):04d}"].value = value
    return fx


# --- Test content ----------------------------------------------------------------

STEPS = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
# Colours near the project's red screens and skin/orange tones, after a 6x6x6 RGB grid.
EXTRA = [
    [1.0, 0.02, 0.0], [1.0, 0.05, 0.02], [1.0, 0.1, 0.05], [1.0, 0.15, 0.1], [0.9, 0.05, 0.0], [0.8, 0.1, 0.05],
    [0.7, 0.0, 0.0], [0.6, 0.12, 0.06], [0.64, 0.12, 0.06], [0.5, 0.1, 0.1], [1.0, 0.3, 0.3], [1.0, 0.5, 0.4],
    [0.95, 0.7, 0.6], [0.85, 0.55, 0.45], [0.6, 0.4, 0.3], [0.4, 0.25, 0.2], [1.0, 0.09, 0.0], [1.0, 0.0, 0.1],
    [1.0, 0.0, 0.3], [1.0, 0.2, 0.0], [1.0, 0.35, 0.0], [0.3, 0.0, 0.0], [0.15, 0.0, 0.0], [0.05, 0.05, 0.05],
    [0.1, 0.9, 0.1], [0.0, 0.7, 0.2], [0.2, 1.0, 0.3], [0.0, 0.3, 1.0], [0.1, 0.1, 0.8], [0.5, 0.5, 0.5],
    [0.25, 0.25, 0.25], [0.75, 0.75, 0.75], [0.9, 0.9, 0.9], [0.1, 0.2, 0.3], [0.3, 0.2, 0.1], [0.2, 0.3, 0.1],
    [1.0, 0.11, 1.0], [0.9, 0.1, 0.9], [1.0, 0.6, 1.0], [0.5, 0.0, 0.5], [0.0, 1.0, 1.0], [1.0, 1.0, 0.0],
    [0.98, 0.0, 0.0], [0.95, 0.03, 0.03], [0.85, 0.0, 0.0], [0.75, 0.05, 0.0], [1.0, 0.25, 0.15], [1.0, 0.45, 0.2],
    [0.55, 0.45, 0.42], [0.35, 0.3, 0.3], [0.2, 0.05, 0.05], [0.45, 0.02, 0.02], [0.3, 0.1, 0.0], [0.7, 0.3, 0.0],
    [0.12, 0.16, 0.3], [1.0, 0.5, 0.0], [0.1, 0.7, 0.65], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.66, 0.0, 0.33],
    [0.33, 0.0, 0.66], [0.0, 0.33, 0.0], [0.4, 0.8, 0.2], [0.8, 0.4, 0.6],
]
HALF = [[1.0, 0.0, 0.0], [1.0, 0.5, 0.0], [0.2, 0.8, 0.2], [0.2, 0.4, 1.0], [1.0, 1.0, 1.0], [0.0, 0.0, 0.0],
        [0.8, 0.2, 0.1], [0.6, 0.6, 0.6], [1.0, 0.1, 0.05], [0.4, 0.1, 0.5]]
CELL = 8


def cells(layer, entries) -> None:
    """entries: (column, row, colour, opacity %) cells of CELL px in a 160x120 shape layer."""
    for col, row, color, opacity in entries:
        g = shape_group(layer)
        gtr(g, "ADBE Vector Position", [col * CELL + CELL / 2 - 80.0, row * CELL + CELL / 2 - 60.0])
        add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [float(CELL), float(CELL)]})
        fill(g, color, **({"ADBE Vector Fill Opacity": float(opacity)} if opacity != 100 else {}))


def palette_comp():
    comp = suite.folder.add_comp("fxextra_src_palette", 160, 120, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    grid = [[r, g, b] for r in STEPS for g in STEPS for b in STEPS] + EXTRA
    entries = [(i % 20, i // 20, c, 100) for i, c in enumerate(grid[:280])]
    entries += [(i, 14, c, 50) for i, c in enumerate(HALF)]
    cells(layer, entries)
    return comp


def alpha_comp():
    comp = suite.folder.add_comp("fxextra_src_alpha", 160, 120, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    entries = []
    opacities = [10, 25, 40, 50, 60, 75, 90, 100]
    colors = [[1.0, 0.0, 0.0], [1.0, 0.5, 0.0], [0.2, 0.8, 0.2], [0.2, 0.4, 1.0], [1.0, 1.0, 1.0], [0.1, 0.1, 0.1],
              [0.8, 0.2, 0.6], [0.5, 0.5, 0.5], [0.05, 0.3, 0.2], [0.9, 0.9, 0.2]]
    for row in range(15):
        for col in range(20):
            if (row + col) % 7 == 3:
                continue  # stays transparent
            entries.append((col, row, colors[(col + 3 * row) % len(colors)], opacities[(2 * col + row) % len(opacities)]))
    cells(layer, entries)
    return comp


def blobs_comp():
    """Shapes on transparency for Minimax, one touching the layer edges."""
    comp = suite.folder.add_comp("fxextra_src_blobs", 160, 120, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [-40.0, -20.0])
    add(g, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [50.0, 40.0]})
    fill(g, ORANGE)
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [30.0, 10.0])
    gtr(g, "ADBE Vector Rotation", 25.0)
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [40.0, 30.0]})
    fill(g, TEAL)
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [70.0, -55.0])
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [40.0, 30.0]})
    fill(g, [0.9, 0.9, 0.2])
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [-50.0, 40.0])
    add(g, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [6.0, 6.0]})
    fill(g, [1.0, 1.0, 1.0])
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [-10.0, 40.0])
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [3.0, 20.0]})
    fill(g, [0.2, 0.4, 1.0])
    return comp


def gray_comp():
    """20x15 cells of grey levels 0..1 in reading order."""
    comp = suite.folder.add_comp("fxextra_src_gray", 160, 120, 1.0, 1.0, 24.0)
    layer = comp.add_shape()
    cells(layer, [(i % 20, i // 20, [i / 299.0] * 3, 100) for i in range(300)])
    return comp


def mover_comp():
    """An orange box crossing the comp in the first second, over a static teal box."""
    comp = suite.folder.add_comp("fxextra_src_mover", 160, 120, 1.0, 2.0, 24.0)
    layer = comp.add_shape()
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [0.0, 30.0])
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [30.0, 30.0]})
    fill(g, TEAL)
    g = shape_group(layer)
    pos = g["ADBE Vector Transform Group"]["ADBE Vector Position"]
    pos.set_value_at_time(0.0, [-70.0, -30.0])
    pos.set_value_at_time(1.0, [70.0, -30.0])
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [20.0, 20.0]})
    fill(g, ORANGE)
    return comp


PALETTE = palette_comp()
GRAY = gray_comp()
MOVER = mover_comp()
ALPHA = alpha_comp()
BLOBS = blobs_comp()
QUADRANTS = [[80.0, 60.0, 0.0], [240.0, 60.0, 0.0], [80.0, 180.0, 0.0], [240.0, 180.0, 0.0]]


def tiles(comp, source, variants, bg=None):
    """Four copies of `source` in the quadrants of a 320x240 comp, each set up by one variant."""
    if bg is not None:
        comp.add_solid(bg, "bg")
    for position, variant in zip(QUADRANTS, variants):
        layer = comp.add(source) if hasattr(source, "layers") else comp.add_solid(source, "solid", 160, 120)
        tr(layer, "ADBE Position").value = position
        if variant:
            variant(layer)


def tile_case(name, source, variants, bg=BG, frames=(0,)):
    # An opaque background keeps the references unambiguous: aerender's "TIFF with alpha" holds
    # premultiplied colour while tagging its alpha as unspecified, which scripts/lib/tiff.ts reads as straight.
    suite.case(name, frames=frames, width=320, height=240)(lambda comp: tiles(comp, source, variants, bg))


# --- Keylight ----------------------------------------------------------------------

KL = ("Logo", "BE.jpg", "Keylight 906")
FINAL, MATTE, INTERMEDIATE = 11, 5, 10


def keylight(**params):
    return lambda layer: user_fx(layer, *KL, **params)


RED = [1.0, 0.003921568859368563, 0.0, 1.0]
tile_case("fxextra_keylight_red", PALETTE, [keylight(), keylight(p2=MATTE), keylight(p2=INTERMEDIATE), keylight(p6=0.0)])
tile_case(
    "fxextra_keylight_colours",
    PALETTE,
    [
        keylight(p4=[0.6431372761726379, 0.1197720468044281, 0.05800845846533775, 1.0]),
        keylight(p4=[1.0, 0.0941176563501358, 0.0, 1.0]),
        keylight(p4=[1.0, 0.11372549831867218, 1.0, 0.03529411926865578]),
        keylight(p4=[0.0, 1.0, 0.0, 1.0]),
    ],
)
tile_case(
    "fxextra_keylight_mattes",
    PALETTE,
    [
        keylight(p2=MATTE, p6=0.0),
        keylight(p2=MATTE, p4=[0.6431372761726379, 0.1197720468044281, 0.05800845846533775, 1.0]),
        keylight(p2=MATTE, p6=100.0),
        keylight(p2=MATTE, p4=[0.1, 0.3, 0.9, 1.0]),
    ],
)
tile_case(
    "fxextra_keylight_controls",
    PALETTE,
    [
        keylight(p2=MATTE, p5=150.0),
        keylight(p2=MATTE, p12=20.0, p13=80.0),
        keylight(p3=0),
        keylight(p28=1),
    ],
)
tile_case(
    "fxextra_keylight_final2",
    PALETTE,
    [
        keylight(p5=60.0),
        keylight(p12=10.0, p13=70.0),
        keylight(p6=0.0, p4=[0.6431372761726379, 0.1197720468044281, 0.05800845846533775, 1.0]),
        keylight(p4=[0.0, 0.2, 1.0, 1.0]),
    ],
)
tile_case(
    "fxextra_keylight_gain",
    PALETTE,
    [
        keylight(p5=80.0),
        keylight(p2=MATTE, p5=200.0),
        keylight(p5=130.0, p12=5.0, p13=90.0),
        keylight(p5=120.0, p6=0.0, p4=[0.6431372761726379, 0.1197720468044281, 0.05800845846533775, 1.0]),
    ],
)
tile_case(
    "fxextra_keylight_alpha",
    ALPHA,
    [keylight(), keylight(p12=10.0, p13=70.0), keylight(p5=150.0), keylight(p2=MATTE)],
    bg=[0.0, 0.0, 0.0],
)

# --- CC Vignette, Remove Color Matting, Minimax -------------------------------------

VIG = ("Final", "BG BLUR", "CS Vignette")


def vignette(**params):
    return lambda layer: user_fx(layer, *VIG, **{"p3": [80.0, 60.0], **params})


tile_case(
    "fxextra_vignette_white",
    [1.0, 1.0, 1.0],
    [vignette(p1=100.0), vignette(p1=166.0), vignette(p1=50.0, p2=90.0), lambda layer: add_effect(layer, "CS Vignette", p1=-60.0, p2=30.0)],
    bg=[0.0, 0.0, 0.0],
)
tile_case(
    "fxextra_vignette_palette",
    PALETTE,
    [vignette(p1=166.0), vignette(p1=100.0, p5=100.0), vignette(p1=120.0, p3=[40.0, 30.0]), vignette(p1=100.0, p2=10.0)],
    bg=[0.0, 0.0, 0.0],
)


tile_case(
    "fxextra_vignette_pin",
    GRAY,
    [
        vignette(p1=100.0, p2=90.0, p5=100.0),
        vignette(p1=100.0, p2=90.0, p5=50.0),
        vignette(p1=50.0, p2=90.0, p5=100.0),
        lambda layer: add_effect(layer, "CS Vignette", p1=100.0, p2=90.0),
    ],
    bg=[0.0, 0.0, 0.0],
)
tile_case(
    "fxextra_vignette_pin2",
    PALETTE,
    [
        vignette(p1=100.0, p2=90.0, p5=50.0),
        vignette(p1=166.0, p5=100.0),
        vignette(p1=100.0, p2=90.0, p5=25.0),
        vignette(p1=80.0, p2=45.0, p5=100.0),
    ],
    bg=[0.0, 0.0, 0.0],
)


@suite.case("fxextra_vignette_sizes", width=320, height=240)
def _(comp):
    comp.add_solid([0.0, 0.0, 0.0], "bg")
    a = comp.add_solid([1.0, 1.0, 1.0], "wide", 200, 80)
    tr(a, "ADBE Position").value = [110.0, 60.0, 0.0]
    vignette(p1=120.0, p3=[100.0, 40.0])(a)
    b = comp.add_solid([0.9, 0.6, 0.3], "tall", 80, 200)
    tr(b, "ADBE Position").value = [260.0, 120.0, 0.0]
    vignette(p1=80.0, p2=60.0, p3=[40.0, 100.0])(b)
    c = comp.add_solid([1.0, 1.0, 1.0], "small", 120, 100)
    tr(c, "ADBE Position").value = [80.0, 180.0, 0.0]
    tr(c, "ADBE Rotate Z").value = 15.0
    vignette(p1=150.0, p3=[60.0, 50.0])(c)


RCM = ("Long Particles", "updated sw lp.mp4", "ADBE Remove Color Matting")


def rcm(**params):
    return lambda layer: user_fx(layer, *RCM, **params)


tile_case(
    "fxextra_rcm",
    ALPHA,
    [rcm(), rcm(p2=1), rcm(p1=[1.0, 1.0, 1.0, 1.0]), rcm(p1=[0.5, 0.2, 0.8, 1.0], p2=1)],
)

MM = ("Long Particles", "updated sw lp.mp4", "ADBE Minimax")


def minimax(**params):
    return lambda layer: user_fx(layer, *MM, **params)


tile_case("fxextra_minimax_a", BLOBS, [minimax(p1=2, p2=3.0), minimax(p1=1, p2=2.0), minimax(p1=2, p2=4.0, p4=2), minimax(p1=1, p2=3.0, p4=3)])
tile_case(
    "fxextra_minimax_b",
    BLOBS,
    [minimax(p1=3, p2=2.0), minimax(p1=4, p2=2.0), minimax(p1=2, p2=3.0, p3=2), minimax(p1=1, p2=2.0, p5=0)],
)
tile_case(
    "fxextra_minimax_c",
    PALETTE,
    [minimax(p1=2, p2=2.0), minimax(p1=1, p2=1.0, p3=3), minimax(p1=2, p2=5.5), minimax(p1=1, p2=2.0, p3=5)],
)

# --- Superpose 2, Sound Keys ---------------------------------------------------------


@suite.case("fxextra_superpose", frames=(0, 12))
def _(comp):
    comp.add_solid(BG, "bg")
    box = comp.add_solid(ORANGE, "box", 40, 30)
    pos = tr(box, "ADBE Position")
    pos.set_value_at_time(0.0, [30.0, 30.0, 0.0])
    pos.set_value_at_time(0.9, [130.0, 90.0, 0.0])
    user_fx(box, "Music", "WEVLTH - REBORN.mp4", "Keller.io Superpose 2", p1=0, p2=10)
    solid = comp.add_solid(TEAL, "solid", 50, 50)
    user_fx(solid, "Music", "WEVLTH - REBORN.mp4", "Keller.io Superpose 2")


SUPERPOSE = ("Music", "WEVLTH - REBORN.mp4", "Keller.io Superpose 2")


def superpose(**params):
    return lambda layer: user_fx(layer, *SUPERPOSE, **params)


tile_case(
    "fxextra_superpose_sweep",
    MOVER,
    [superpose(p1=0, p2=10), superpose(p1=5, p2=15), superpose(p1=0, p2=10, p3=2), superpose(p1=0, p2=10, p4=10, p5=3)],
    bg=BG,
    frames=tuple(range(0, 21, 2)),
)


@suite.case("fxextra_soundkeys", frames=(0, 12))
def _(comp):
    comp.add_solid(BG, "bg")
    layer = comp.add_solid([0.5, 0.5, 0.5], "sound keys", 160, 120)
    user_fx(layer, "Final", "Sound Keys", "tc Sound Keys")
    other = comp.add_solid(ORANGE, "box", 60, 40)
    tr(other, "ADBE Position").value = [50.0, 40.0, 0.0]
    user_fx(other, "Render This", "Select This", "tc Sound Keys")


# --- Particular ---------------------------------------------------------------------


@suite.case("fxextra_particular_real", frames=(24, 96), width=1920, height=1080, duration=5.0)
def _(comp):
    comp.add_solid(BG, "bg", 1920, 1080)
    layer = comp.add_solid([0.25, 0.25, 0.25], "Dark Gray Solid 1", 1920, 1080)
    user_fx(layer, "Real Particles", "Dark Gray Solid 1", "tc Particular", p581=[960.0, 540.0, 240.0])


@suite.case("fxextra_particular_white", frames=(24, 96), width=1920, height=1080, duration=5.0)
def _(comp):
    comp.add_solid(BG, "bg", 1920, 1080)
    layer = comp.add_solid([1.0, 1.0, 1.0], "White Solid 2", 1920, 1080)
    user_fx(layer, "Particles", "White Solid 2", "tc Particular")


@suite.case("fxextra_particular_blob", frames=(12,), width=320, height=240)
def _(comp):
    comp.add_solid(BG, "bg")
    layer = comp.add_solid([0.25, 0.25, 0.25], "particles", 320, 240)
    # One emitter point, no motion and no randomness: every particle sits at the centre.
    user_fx(
        layer, "Real Particles", "Dark Gray Solid 1", "tc Particular",
        p146=2.0, p5=1, p581=[160.0, 120.0, 0.0], p11=0.0, p12=0.0, p65=0.0, p27=40.0, p74=0.0, p75=0.0,
        p22=0.0, p23=0.0, p24=0.0,
    )


# --- Effects whose plugins are not installed -----------------------------------------


def missing_case(name, comp_name, layer_name, match_name, frames=(0,), nth=0):
    @suite.case(name, frames=frames)
    def _(comp):
        comp.add_solid(BG, "bg")
        layer = comp.add(PALETTE)
        user_fx(layer, comp_name, layer_name, match_name, nth)
        box = comp.add_solid(ORANGE, "box", 30, 20)
        tr(box, "ADBE Position").value = [130.0, 100.0, 0.0]


missing_case("fxextra_missing_xmult", "Overlay", "IG FROM TN.mp4", "Fandev XMult")
missing_case("fxextra_missing_sblur", "Final", "Adjustment Layer 1", "S_Blur")
missing_case("fxextra_missing_sglow", "Render This", "Audio Spectrum Comp 1", "S_Glow")
missing_case("fxextra_missing_sshake", "Render This", "Intro", "S_Shake", frames=(0, 6))
missing_case("fxextra_missing_szglow", "Final", "Spectrum soundkeys 2", "S_ZGlow")
missing_case("fxextra_missing_sflicker", "Render This", "Put Wallpaper Here", "S_Flicker", frames=(0, 6))

#: Look-alikes of plugin output that is not reproduced; measured by scripts/fxextra-approx-report.ts
#: and kept out of the pixel gate (refs/fixtures/fxextra.approximations.json).
APPROXIMATIONS = {
    "fxextra_soundkeys": "Sound Keys draws its own spectrum/output display over the layer; only its grid and bars are imitated",
    "fxextra_particular_real": "Particular's particle positions come from its own random generator; ours are a seeded look-alike",
    "fxextra_particular_white": "Particular's particle positions come from its own random generator; ours are a seeded look-alike",
    "fxextra_particular_blob": "Particular's glow-sphere particle profile is only imitated",
}

#: Frames the pixel report accepts with a mean error of at most 1/255.
KNOWN = {
    "fxextra_keylight_alpha@0": "Screen Matte of the 10%-opacity cells is 4/255 bright: AE keys their exact colour, "
    "ours keys the colour recovered from 8-bit premultiplied layer pixels",
}

suite.save()
manifest_path = REFS / suite.manifest_file
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["known"] = KNOWN
approx = {
    "project": manifest["project"],
    "comps": [c for c in manifest["comps"] if c["comp"] in APPROXIMATIONS],
    "reasons": APPROXIMATIONS,
}
manifest["comps"] = [c for c in manifest["comps"] if c["comp"] not in APPROXIMATIONS]
manifest_path.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
(REFS / "fxextra.approximations.json").write_text(json.dumps(approx, indent=1) + "\n", encoding="utf-8")
