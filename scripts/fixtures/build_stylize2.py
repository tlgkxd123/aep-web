# Builds refs/fixtures/stylize2.aep: the Stylize effects of src/render/effects/stylizeExtra.ts (Emboss, Color
# Emboss, Find Edges, CC Threshold, CC Threshold RGB, Strobe Light, CC Kaleida, CC RepeTile, CC HexTile, CC Block
# Load, Texturize, CC Burn Film, CC Glass, CC Plastic, Cartoon, CC Mr. Smoothie, Roughen Edges, Scatter, Brush
# Strokes), on a scene of stepped ramps, colour cells and partly transparent pixels, on a probe of steps and one
# pixel lines that shows a kernel's response, and on UV cards whose colours give the source position each output
# pixel shows. Parameters are keyed one value per frame where a case sweeps them.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_stylize2.py
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import REFS, BlendingMode, Suite, add_effect, install_effects, set_layer_param, tr  # noqa: E402

EFFECTS = [
    "ADBE Ramp",
    "ADBE Emboss",
    "ADBE Color Emboss",
    "ADBE Find Edges",
    "CC Threshold",
    "CC Threshold RGB",
    "ADBE Strobe",
    "CC Kaleida",
    "CC RepeTile",
    "CS HexTile",
    "CS BlockLoad",
    "ADBE Texturize",
    "CC Burn Film",
    "CC Glass",
    "CC Plastic",
    "ADBE Roughen Edges",
    "ADBE Scatter",
    "ADBE Cartoonify",
    "CC Mr. Smoothie",
    "ADBE Brush Strokes",
]
suite = Suite("stylize2")
install_effects(suite, EFFECTS)
case = suite.case
folder = suite.folder

CELL_COLORS = [
    [0.95, 0.85, 0.2], [0.1, 0.2, 0.6], [0.85, 0.2, 0.25], [0.2, 0.75, 0.35],
    [0.6, 0.3, 0.8], [1.0, 1.0, 1.0], [0.05, 0.05, 0.05], [0.95, 0.55, 0.1],
    [0.3, 0.85, 0.9], [0.5, 0.5, 0.5], [0.9, 0.4, 0.7], [0.15, 0.45, 0.3],
]
RAMP_COLORS = [[1.0, 1.0, 1.0], [1.0, 0.2, 0.1], [0.2, 1.0, 0.4], [0.3, 0.4, 1.0]]


def effect(layer, match_name, fps=24.0, **params):
    """add_effect where a list for a number parameter, or a list of lists, is keyed one value per frame."""
    fx = add_effect(layer, match_name)
    for key, value in params.items():
        prop = fx[f"{match_name}-{int(key[1:]):04d}"]
        keyed = isinstance(value, list) and (isinstance(value[0], list) or not isinstance(prop.value, list))
        if keyed:
            for k, v in enumerate(value):
                prop.set_value_at_time(k / fps, v)
        else:
            prop.value = value
    return fx


# Sources are made of pixel-aligned solids, so After Effects and the renderer start from the same 8-bit pixels and
# the effects' gains (Sobel, Contrast) do not amplify differences in antialiasing or gradient rounding.


def solid(comp, color, name, w, h, x, y, opacity=None):
    s = comp.add_solid(color, name, w, h)
    tr(s, "ADBE Position").value = [x + w / 2, y + h / 2, 0.0]
    if opacity is not None:
        tr(s, "ADBE Opacity").value = opacity
    return s


RAMP_STEPS = 20


def scene_source():
    """100 x 80: four black-to-colour ramps of 5 px steps over the top half, colour cells below (one 50 % opaque, one
    missing, with a 60 % opaque square inside it) and a white bar across the ramps."""
    w, h = 100, 80
    comp = folder.add_comp("stylize2_scene", w, h, 1.0, 1.0, 24.0)
    for k in range(10):
        i, j = k % 5, k // 5
        if k == 9:
            continue
        solid(comp, CELL_COLORS[k], f"c{k}", 20, 20, i * 20, 40 + j * 20, 50.0 if k == 6 else None)
    solid(comp, [0.9, 0.95, 1.0], "glass", 12, 12, 84, 64, 60.0)
    step = w // RAMP_STEPS
    for k, color in enumerate(RAMP_COLORS):
        for i in range(RAMP_STEPS):
            t = i / (RAMP_STEPS - 1)
            solid(comp, [c * t for c in color], f"r{k}_{i}", step, 10, i * step, 10 * k)
    solid(comp, [1.0, 1.0, 1.0], "bar", 6, 26, 62, 8)
    return comp


def probe_source():
    """60 x 40 opaque: 0.8 grey left of x = 30, 0.2 grey right of it, a white column at x = 45 and a white row at
    y = 30 over the right half; a step, two impulses and their crossing. The last solid added is drawn on top."""
    comp = folder.add_comp("stylize2_probe", 60, 40, 1.0, 1.0, 24.0)
    solid(comp, [0.2, 0.2, 0.2], "dark", 60, 40, 0, 0)
    solid(comp, [0.8, 0.8, 0.8], "light", 30, 40, 0, 0)
    solid(comp, [1.0, 1.0, 1.0], "column", 1, 40, 45, 0)
    solid(comp, [1.0, 1.0, 1.0], "row", 30, 1, 30, 30)
    return comp


def texture_source():
    """30 x 20 cells of 10 px."""
    comp = folder.add_comp("stylize2_texture", 30, 20, 1.0, 1.0, 24.0)
    for k in range(6):
        solid(comp, CELL_COLORS[(k * 5) % len(CELL_COLORS)], f"t{k}", 10, 10, (k % 3) * 10, (k // 3) * 10)
    return comp


def uv_source(name, w, h, cell=10):
    """w x h: red (x + 0.5) / w in column x, green (y + 0.5) / h in row y (one pixel solids, added) and 0.8 blue on
    alternate cells: each pixel's colour tells where in the source it was taken from. Solids rather than Gradient
    Ramps, which After Effects evaluates at pixel corners."""
    comp = folder.add_comp(name, w, h, 1.0, 1.0, 24.0)
    for i in range(w):
        solid(comp, [(i + 0.5) / w, 0.0, 0.0], f"x{i}", 1, h, i, 0)
    for j in range(h):
        s = solid(comp, [0.0, (j + 0.5) / h, 0.0], f"y{j}", w, 1, 0, j)
        s.blending_mode = BlendingMode.ADD
    for j in range(h // cell):
        for i in range(w // cell):
            if (i + j) % 2:
                continue
            s = solid(comp, [0.0, 0.0, 0.8], f"b{i}_{j}", cell, cell, i * cell, j * cell)
            s.blending_mode = BlendingMode.ADD
    return comp


def luma_source():
    """256 x 60: black-to-colour Gradient Ramps of red, green, blue, yellow, cyan and magenta, 10 px each."""
    comp = folder.add_comp("stylize2_luma_src", 256, 60, 1.0, 1.0, 24.0)
    for k, color in enumerate([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 0.0], [0.0, 1.0, 1.0], [1.0, 0.0, 1.0]]):
        s = solid(comp, [0.0, 0.0, 0.0], f"ramp{k}", 256, 10, 0, 10 * k)
        effect(s, "ADBE Ramp", p1=[0.0, 5.0], p2=[0.0, 0.0, 0.0, 1.0], p3=[256.0, 5.0], p4=color + [1.0], p5=1, p6=0.0, p7=0.0)
    return comp


def quadrant_source():
    """40 x 40 opaque quadrants: black, red (right), green (bottom) and yellow (bottom right), so a mix across a
    vertical seam shows in red and one across a horizontal seam in green."""
    comp = folder.add_comp("stylize2_quadrants", 40, 40, 1.0, 1.0, 24.0)
    for k, color in enumerate([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]]):
        solid(comp, color, f"q{k}", 20, 20, (k % 2) * 20, (k // 2) * 20)
    return comp


SCENE = scene_source()
PROBE = probe_source()
TEXTURE = texture_source()
UV = uv_source("stylize2_uv", 100, 80)
UV_SQUARE = uv_source("stylize2_uv_square", 80, 80)
LUMA = luma_source()
UV_SMALL = uv_source("stylize2_uv_small", 20, 20)
QUADRANTS = quadrant_source()


def frames(n):
    return tuple(range(n))


def scene(comp):
    return comp.add(SCENE)


def probe(comp):
    return comp.add(PROBE)


# --- Threshold ---------------------------------------------------------------------------------------------------


@case("stylize2_ccthreshold", frames=frames(8))
def _(comp):
    effect(scene(comp), "CC Threshold", p1=[0.5, 0.5, 0.5, 0.5, 0.25, 0.75, 0.5, 0.6], p2=[1, 2, 3, 4, 1, 2, 1, 3], p3=[0, 0, 0, 0, 1, 0, 0, 1], p4=[0.0, 0.0, 0.0, 0.0, 0.0, 0.4, 0.7, 0.2])


@case("stylize2_ccthreshold_rgb", frames=frames(5))
def _(comp):
    effect(
        scene(comp),
        "CC Threshold RGB",
        p1=[0.5, 0.2, 0.8, 0.5, 0.35],
        p2=[0.5, 0.6, 0.3, 0.5, 0.65],
        p3=[0.5, 0.8, 0.5, 0.5, 0.5],
        p4=[0, 1, 0, 1, 0],
        p5=[0, 0, 1, 1, 0],
        p6=[0, 0, 0, 1, 1],
        p7=[0.0, 0.0, 0.0, 0.0, 0.5],
    )


@case("stylize2_threshold_luma", frames=frames(9), width=256, height=60)
def _(comp):
    # Frame 0 (Alpha at 0) passes the ramps' colours through; the others show where Luminance reaches each level.
    effect(comp.add(LUMA), "CC Threshold", p1=[0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7], p2=[4, 1, 1, 1, 1, 1, 1, 1, 1], p3=0, p4=0.0)


# --- Edges and relief --------------------------------------------------------------------------------------------


@case("stylize2_find_edges", frames=frames(4))
def _(comp):
    effect(scene(comp), "ADBE Find Edges", p1=[0, 1, 0, 1], p2=[0.0, 0.0, 0.3, 0.6])


@case("stylize2_find_edges_probe", frames=frames(2))
def _(comp):
    effect(probe(comp), "ADBE Find Edges", p1=[0, 1], p2=0.0)


for name in ("ADBE Emboss", "ADBE Color Emboss"):
    tag = "emboss" if name == "ADBE Emboss" else "color_emboss"

    @case(f"stylize2_{tag}", frames=frames(6))
    def _(comp, name=name):
        effect(scene(comp), name, p1=[45.0, 135.0, 300.0, 0.0, 90.0, 200.0], p2=[1.0, 3.0, 7.5, 2.0, 1.5, 4.0], p3=[100.0, 250.0, 50.0, 100.0, 400.0, 100.0], p4=[0.0, 0.0, 40.0, 0.0, 0.0, 25.0])

    @case(f"stylize2_{tag}_probe", frames=frames(6))
    def _(comp, name=name):
        effect(probe(comp), name, p1=[0.0, 90.0, 45.0, 0.0, 30.0, 0.0], p2=[1.0, 1.0, 1.0, 3.0, 2.5, 0.5], p3=[100.0, 100.0, 100.0, 100.0, 100.0, 300.0], p4=0.0)


# --- Strobe Light ------------------------------------------------------------------------------------------------


@case("stylize2_strobe_copy", frames=frames(9))
def _(comp):
    effect(scene(comp), "ADBE Strobe", p1=[1.0, 0.2, 0.1, 1.0], p2=0.0, p3=2 / 24, p4=4 / 24, p5=0.0, p6=1, p7=1, p8=0)


@case("stylize2_strobe_ops", frames=frames(13))
def _(comp):
    effect(scene(comp), "ADBE Strobe", p1=[0.9, 0.4, 0.2, 1.0], p2=0.0, p3=13.5 / 24, p4=1.0, p5=0.0, p6=1, p7=list(range(1, 14)), p8=0)


@case("stylize2_strobe_blend", frames=frames(5))
def _(comp):
    effect(scene(comp), "ADBE Strobe", p1=[0.2, 0.5, 1.0, 1.0], p2=35.0, p3=0.5, p4=1.0, p5=0.0, p6=1, p7=[1, 2, 4, 9, 13], p8=0)


@case("stylize2_strobe_transparent", frames=frames(8))
def _(comp):
    effect(scene(comp), "ADBE Strobe", p1=[1.0, 1.0, 1.0, 1.0], p2=[0.0, 0.0, 0.0, 0.0, 30.0, 30.0, 30.0, 30.0], p3=3 / 24, p4=6 / 24, p5=0.0, p6=2, p7=1, p8=0)


#: Strobe Duration and Period in frames of 24 fps for the timing grids, one 40 x 30 solid each.
STROBE_TIMINGS = [(2, 4), (3, 6), (1, 4), (2, 8), (4, 8), (6, 12), (12, 24), (13.5, 24), (1, 2), (2.4, 6), (1, 3), (2, 5), (5, 10), (8, 16), (3, 4), (0.5, 1)]

for fps in (24, 30):

    @case(f"stylize2_strobe_timing{'' if fps == 24 else '_30'}", frames=frames(48), duration=2.0, fps=float(fps))
    def _(comp):
        for k, (duration, period) in enumerate(STROBE_TIMINGS):
            s = solid(comp, [1.0, 1.0, 1.0], f"t{k}", 40, 30, 40 * (k % 4), 30 * (k // 4))
            effect(s, "ADBE Strobe", p1=[1.0, 0.0, 0.0, 1.0], p2=0.0, p3=duration / 24, p4=period / 24, p5=0.0, p6=1, p7=1, p8=0)


# --- Tiling and mirrors ------------------------------------------------------------------------------------------


@case("stylize2_kaleida", frames=frames(9))
def _(comp):
    effect(scene(comp), "CC Kaleida", p1=[50.0, 40.0], p2=30.0, p3=list(range(1, 10)), p4=0.0, p5=0)


@case("stylize2_kaleida_rot", frames=frames(4))
def _(comp):
    effect(scene(comp), "CC Kaleida", p1=[[40.0, 30.0], [60.0, 45.0], [50.0, 40.0], [30.0, 50.0]], p2=[20.0, 45.0, 25.0, 35.0], p3=[6, 1, 2, 9], p4=[30.0, -60.0, 90.0, 15.0], p5=[0, 0, 1, 1])


@case("stylize2_kaleida_uv", frames=frames(9))
def _(comp):
    effect(comp.add(UV), "CC Kaleida", p1=[50.0, 40.0], p2=30.0, p3=list(range(1, 10)), p4=0.0, p5=0)


@case("stylize2_kaleida_uv_b", frames=frames(6))
def _(comp):
    effect(comp.add(UV), "CC Kaleida", p1=[[50.0, 40.0], [50.0, 40.0], [30.0, 50.0], [50.0, 40.0], [60.0, 30.0], [50.0, 40.0]], p2=[30.0, 60.0, 30.0, 30.0, 25.0, 30.0], p3=1, p4=[0.0, 0.0, 0.0, 30.0, 0.0, 0.0], p5=[0, 0, 0, 0, 0, 1])


# Tiling cannot be keyed: one layer per mode, each centred in its own 160 x 120 cell.
REPETILE_SIMPLE = [1, 2, 3, 4, 5, 11, 16, 17]
REPETILE_TURNS = [6, 7, 8, 9, 13, 14, 15]
REPETILE_RANDOM = 10


def grid_of(comp, source, count, columns):
    layers = []
    for k in range(count):
        layer = comp.add(source)
        tr(layer, "ADBE Position").value = [80.0 + 160 * (k % columns), 60.0 + 120 * (k // columns), 0.0]
        layers.append(layer)
    return layers


def grid_of_scenes(comp, count, columns):
    return grid_of(comp, SCENE, count, columns)


@case("stylize2_repetile", width=640, height=240)
def _(comp):
    for layer, mode in zip(grid_of_scenes(comp, len(REPETILE_SIMPLE), 4), REPETILE_SIMPLE):
        effect(layer, "CC RepeTile", p1=30, p2=20, p3=15, p4=10, p5=mode, p6=0.0)


@case("stylize2_repetile_turns", width=640, height=240)
def _(comp):
    for layer, mode in zip(grid_of(comp, UV_SQUARE, len(REPETILE_TURNS), 4), REPETILE_TURNS):
        effect(layer, "CC RepeTile", p1=30, p2=20, p3=15, p4=10, p5=mode, p6=0.0)


@case("stylize2_repetile_turns_wide", width=640, height=240)
def _(comp):
    for layer, mode in zip(grid_of(comp, UV, len(REPETILE_TURNS), 4), REPETILE_TURNS):
        effect(layer, "CC RepeTile", p1=30, p2=20, p3=15, p4=10, p5=mode, p6=0.0)


@case("stylize2_repetile_blend", width=480, height=120)
def _(comp):
    for layer, mode, blend in zip(grid_of_scenes(comp, 3, 3), [1, 4, 17], [0.3, 0.6, 1.0]):
        effect(layer, "CC RepeTile", p1=25, p2=25, p3=20, p4=20, p5=mode, p6=blend)


@case("stylize2_repetile_cells", width=460, height=230)
def _(comp):
    for k, mode in enumerate([15, REPETILE_RANDOM]):
        layer = comp.add(UV_SMALL)
        tr(layer, "ADBE Position").value = [115.0 + 230 * k, 115.0, 0.0]
        effect(layer, "CC RepeTile", p1=100, p2=100, p3=100, p4=100, p5=mode, p6=0.0)


@case("stylize2_repetile_twist", width=300, height=200)
def _(comp):
    layer = comp.add(UV)
    tr(layer, "ADBE Position").value = [130.0, 90.0, 0.0]
    effect(layer, "CC RepeTile", p1=120, p2=80, p3=70, p4=50, p5=15, p6=0.0)


@case("stylize2_repetile_brick", frames=frames(2), width=240, height=220)
def _(comp):
    layer = comp.add(UV)
    tr(layer, "ADBE Position").value = [120.0, 110.0, 0.0]
    effect(layer, "CC RepeTile", p1=70, p2=70, p3=70, p4=70, p5=17, p6=[0.0, 0.5])


@case("stylize2_repetile_seams", frames=frames(4), width=120, height=120)
def _(comp):
    layer = comp.add(QUADRANTS)
    tr(layer, "ADBE Position").value = [60.0, 60.0, 0.0]
    effect(layer, "CC RepeTile", p1=40, p2=40, p3=40, p4=40, p5=1, p6=[0.1, 0.3, 0.6, 1.0])


@case("stylize2_kaleida_star", frames=frames(3))
def _(comp):
    effect(comp.add(UV), "CC Kaleida", p1=[50.0, 40.0], p2=[60.0, 40.0, 80.0], p3=9, p4=0.0, p5=0)


@case("stylize2_hextile", frames=frames(3))
def _(comp):
    effect(scene(comp), "CS HexTile", p1=[1, 2, 3], p2=20.0, p3=[50.0, 40.0], p4=0, p5=0.0, p6=0.0)


@case("stylize2_hextile_rot", frames=frames(4))
def _(comp):
    effect(scene(comp), "CS HexTile", p1=[1, 1, 2, 3], p2=[30.0, 15.0, 25.0, 18.0], p3=[[40.0, 30.0], [60.0, 45.0], [50.0, 40.0], [30.0, 50.0]], p4=[0, 1, 0, 1], p5=[30.0, 0.0, 45.0, -20.0], p6=[0.0, 50.0, -40.0, 0.0])


@case("stylize2_hextile_uv", frames=frames(6))
def _(comp):
    effect(comp.add(UV), "CS HexTile", p1=[1, 2, 3, 1, 1, 1], p2=[20.0, 20.0, 20.0, 30.0, 20.0, 20.0], p3=[[50.0, 40.0], [50.0, 40.0], [50.0, 40.0], [50.0, 40.0], [35.0, 30.0], [50.0, 40.0]], p4=[0, 0, 0, 0, 0, 1], p5=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0], p6=0.0)


@case("stylize2_hextile_uv_b", frames=frames(4))
def _(comp):
    effect(comp.add(UV), "CS HexTile", p1=1, p2=20.0, p3=[50.0, 40.0], p4=0, p5=[30.0, 0.0, 0.0, 90.0], p6=[0.0, 50.0, -50.0, 0.0])


@case("stylize2_hextile_fold", frames=frames(6))
def _(comp):
    effect(comp.add(UV), "CS HexTile", p1=[2, 2, 3, 3, 1, 1], p2=[20.0, 20.0, 20.0, 20.0, 20.0, 15.0], p3=[[50.0, 40.0], [50.0, 40.0], [50.0, 40.0], [50.0, 40.0], [40.0, 30.0], [60.0, 45.0]], p4=[0, 0, 0, 0, 1, 1], p5=[45.0, 0.0, 30.0, 0.0, 0.0, 0.0], p6=[0.0, -40.0, 0.0, 50.0, 0.0, 0.0])


@case("stylize2_blockload_uv", frames=frames(21))
def _(comp):
    effect(comp.add(UV), "CS BlockLoad", p1=[5.0 * k for k in range(21)], p2=4, p3=1, p4=0)


@case("stylize2_blockload_uv_b", frames=frames(8))
def _(comp):
    effect(comp.add(UV), "CS BlockLoad", p1=[50.0, 50.0, 50.0, 50.0, 30.0, 30.0, 10.0, 60.0], p2=[1, 2, 8, 16, 4, 4, 4, 4], p3=[1, 1, 1, 1, 0, 1, 1, 1], p4=[0, 0, 0, 0, 0, 1, 1, 1])


@case("stylize2_blockload", frames=frames(6))
def _(comp):
    effect(scene(comp), "CS BlockLoad", p1=[0.0, 10.0, 30.0, 50.0, 75.0, 100.0], p2=4, p3=1, p4=0)


@case("stylize2_blockload_b", frames=frames(6))
def _(comp):
    effect(scene(comp), "CS BlockLoad", p1=[20.0, 45.0, 70.0, 90.0, 20.0, 10.0], p2=[1, 8, 16, 3, 2, 3], p3=[0, 0, 1, 0, 0, 0], p4=[1, 0, 1, 0, 0, 0])


# --- Texture and surfaces ----------------------------------------------------------------------------------------


@case("stylize2_texturize", frames=frames(3))
def _(comp):
    texture = comp.add(TEXTURE)
    texture.enabled = False
    fx = effect(scene(comp), "ADBE Texturize", p2=[135.0, 45.0, 270.0], p3=[1.0, 2.0, 0.5], p4=[1, 2, 3])
    set_layer_param(fx["ADBE Texturize-0001"], texture)


@case("stylize2_burn_film", frames=frames(3))
def _(comp):
    effect(scene(comp), "CC Burn Film", p1=[20.0, 50.0, 80.0], p2=[[50.0, 40.0], [30.0, 30.0], [60.0, 50.0]], p3=[0.0, 0.0, 100.0])


@case("stylize2_ccglass", frames=frames(3))
def _(comp):
    layer = scene(comp)
    fx = effect(layer, "CC Glass", p3=[6, 5, 4], p4=[20.0, 5.0, 10.0], p5=[25.0, 50.0, -30.0], p6=[100.0, 50.0, 200.0], p23=1, p9=100.0, p10=[1.0, 1.0, 1.0, 1.0], p11=1, p12=65.0, p13=[50.0, 40.0], p14=-45.0, p17=50.0, p18=50.0, p19=50.0, p20=0.025, p21=100.0)
    set_layer_param(fx["CC Glass-0002"], layer)


for light in (1, 2):

    @case(f"stylize2_ccplastic{'' if light == 1 else '_point'}", frames=frames(3))
    def _(comp, light=light):
        layer = scene(comp)
        fx = effect(layer, "CC Plastic", p3=[5, 6, 4], p4=[20.0, 5.0, 10.0], p5=[25.0, 60.0, -30.0], p6=0.0, p7=100.0, p26=1, p10=100.0, p11=[1.0, 1.0, 1.0, 1.0], p12=light, p13=65.0, p14=[30.0, 20.0], p15=-45.0, p16=[1.0, 1.0, 1.0, 1.0], p19=75.0, p20=25.0, p21=[25.0, 0.0, 50.0], p22=100.0, p23=0.025, p24=100.0)
        set_layer_param(fx["CC Plastic-0002"], layer)


@case("stylize2_cartoon", frames=frames(3))
def _(comp):
    effect(scene(comp), "ADBE Cartoonify", p1=[3, 1, 2], p2=8.0, p3=10.0, p5=8.0, p6=70.0, p9=1.6, p10=1.5, p11=60.0, p12=100.0, p15=1.0, p16=0.0, p17=0.5)


@case("stylize2_smoothie", frames=frames(2))
def _(comp):
    layer = scene(comp)
    fx = effect(layer, "CC Mr. Smoothie", p2=[5, 7], p3=[4.0, 40.0], p4=[20.0, 20.0], p5=[80.0, 60.0], p6=[0.0, 90.0], p7=[1, 3])
    set_layer_param(fx["CC Mr. Smoothie-0001"], layer)


# --- Random-driven look-alikes -----------------------------------------------------------------------------------


@case("stylize2_roughen", frames=frames(3))
def _(comp):
    effect(scene(comp), "ADBE Roughen Edges", p1=[1, 2, 4], p10=[0.6, 0.2, 0.0, 1.0], p2=8.0, p3=1.0, p4=1.0, p5=100.0, p6=0.0, p7=[0.0, 0.0], p8=2, p9=0.0, p12=0, p13=1, p14=0)


@case("stylize2_scatter", frames=frames(3))
def _(comp):
    effect(scene(comp), "ADBE Scatter", p1=[5.0, 20.0, 20.0], p2=[1, 2, 3], p3=0)


@case("stylize2_brush_strokes", frames=frames(2))
def _(comp):
    effect(scene(comp), "ADBE Brush Strokes", p1=[135.0, 45.0], p2=[2.0, 4.0], p3=[5, 12], p4=1.0, p5=1.0, p6=[1, 2], p7=0.0)


#: Effects driven by After Effects' own random generator: our renderers are seeded look-alikes, measured but kept
#: out of the pixel gate (refs/fixtures/stylize2.approximations.json).
APPROXIMATIONS = {
    "stylize2_roughen": "Roughen Edges' fractal edge comes from After Effects' own noise and random generator; ours is a look-alike",
    "stylize2_scatter": "Scatter moves pixels by After Effects' own random generator; ours scatters by a seeded hash",
    "stylize2_brush_strokes": "Brush Strokes places strokes by After Effects' own random generator; ours is a look-alike",
    "stylize2_burn_film": "CC Burn Film burns along After Effects' own noise; ours is a look-alike",
    "stylize2_ccglass": "CC Glass has no renderer yet (bump-mapped lighting not reproduced); reference kept for that work",
    "stylize2_ccplastic": "CC Plastic has no renderer yet (bump-mapped lighting not reproduced); reference kept for that work",
    "stylize2_ccplastic_point": "CC Plastic has no renderer yet (bump-mapped lighting not reproduced); reference kept for that work",
    "stylize2_cartoon": "Cartoonify has no renderer yet; reference kept for that work",
    "stylize2_smoothie": "CC Mr. Smoothie has no renderer yet; reference kept for that work",
    "stylize2_repetile_cells": "CC RepeTile's Random tiling turns and flips tiles by After Effects' own random generator; ours by a seeded hash (the Twist layer beside it matches)",
}

#: Frames the pixel report accepts with a mean error of at most 1/255.
KNOWN: dict[str, str] = {}

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
(REFS / "stylize2.approximations.json").write_text(json.dumps(approx, indent=1) + "\n", encoding="utf-8")
