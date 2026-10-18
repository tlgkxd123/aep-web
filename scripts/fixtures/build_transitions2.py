# Builds refs/fixtures/transitions2.aep: the transition effects of
# src/render/effects/transitionsExtra.ts (Iris Wipe, Gradient Wipe,
# CC Grid Wipe, CC Radial ScaleWipe, CC Scale Wipe, CC Jaws, CC Line Sweep,
# CC Light Wipe, CC Image Wipe, CC Glass Wipe, CC Twister), each on a textured
# card over a background and on a plain white solid (its alpha is the coverage),
# with every parameter the case depends on set. A list for a number parameter is
# keyed one value per frame.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_transitions2.py
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import aepfix  # noqa: E402
from aepfix import BG, REFS, Suite, add_effect, install_effects, py_aep, set_layer_param, tr  # noqa: E402
from py_aep.binary.mutations import clone_chunk_tree  # noqa: E402
from py_aep.binary.utils import filter_by_list_type, find_by_list_type  # noqa: E402

_definitions: dict[str, dict] = {}


def _donor_definitions(path: str, wanted: set[str]) -> dict:
    """aepfix's lookup with each donor parsed once: the donor of every effect is a 14 MB project."""
    if path not in _definitions:
        raw = Path(path).read_bytes()
        found = {}
        if any(name.encode() in raw for name in EFFECTS):
            try:
                efdg = find_by_list_type(py_aep.parse(path).project._rifx.chunks, "EfdG")
                for efdf in filter_by_list_type(efdg.chunks, "EfDf"):
                    tdmn = next((c for c in efdf.chunks if getattr(c, "chunk_type", "") == "tdmn"), None)
                    if tdmn is not None:
                        found[tdmn.value] = efdf
            except Exception:  # noqa: BLE001 - unreadable donor or no definitions
                pass
        _definitions[path] = found
    return {name: clone_chunk_tree(efdf) for name, efdf in _definitions[path].items() if name in wanted}


aepfix._donor_definitions = _donor_definitions

EFFECTS = [
    "ADBE IRIS_WIPE",
    "ADBE Gradient Wipe",
    "CC Grid Wipe",
    "CC Radial ScaleWipe",
    "CC Scale Wipe",
    "CC Jaws",
    "CS LineSweep",
    "CC Light Wipe",
    "CC Image Wipe",
    "CC Glass Wipe",
    "CC Twister",
    "ADBE Ramp",
]
#: Accepted approximations, "comp@frame" -> reason (still held to a mean error of 1/255).
KNOWN: dict[str, str] = {}

suite = Suite("transitions2")
install_effects(suite, EFFECTS)
case = suite.case
folder = suite.folder

CELL_COLORS = [
    [0.95, 0.85, 0.2], [0.1, 0.2, 0.6], [0.85, 0.2, 0.25], [0.2, 0.75, 0.35],
    [0.6, 0.3, 0.8], [1.0, 1.0, 1.0], [0.05, 0.05, 0.05], [0.95, 0.55, 0.1],
    [0.3, 0.85, 0.9], [0.5, 0.5, 0.5], [0.9, 0.4, 0.7], [0.15, 0.45, 0.3],
]


def card(w, h, cell):
    """A precomp tiled with differently coloured solids: hard edges and texture, opaque to its bounds."""
    inner = folder.add_comp(f"transitions2_card_{w}x{h}_{cell}", w, h, 1.0, 1.0, 24.0)
    cols = (w + cell - 1) // cell
    for j in range((h + cell - 1) // cell):
        for i in range(cols):
            s = inner.add_solid(CELL_COLORS[(j * cols + i) % len(CELL_COLORS)], f"c{i}_{j}", cell, cell)
            tr(s, "ADBE Position").value = [i * cell + cell / 2, j * cell + cell / 2, 0.0]
    return inner


def steps(w, h, n, vertical=False):
    """A precomp of n grey bands (black to white) across its width, or down its height."""
    inner = folder.add_comp(f"transitions2_steps_{w}x{h}_{n}{'v' if vertical else ''}", w, h, 1.0, 1.0, 24.0)
    size = (h if vertical else w) // n
    for k in range(n):
        g = round(k * 255 / (n - 1)) / 255
        s = inner.add_solid([g, g, g], f"s{k}", w if vertical else size, size if vertical else h)
        tr(s, "ADBE Position").value = [w / 2, k * size + size / 2, 0.0] if vertical else [k * size + size / 2, h / 2, 0.0]
    return inner


CARD = card(160, 120, 20)
STEPS = steps(160, 120, 32)
STEPS_SMALL = steps(80, 60, 16)
STEPS_V = steps(160, 120, 24, vertical=True)


def on_card(comp):
    comp.add_solid(BG, "bg")
    return comp.add(CARD)


def white(comp):
    return comp.add_solid([1.0, 1.0, 1.0], "white")


def hidden(comp, item):
    layer = comp.add(item)
    layer.enabled = False
    return layer


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


# --- Iris Wipe: 1 Center, 2 Points, 3 Outer Radius, 4 Use Inner, 5 Inner Radius, 6 Rotation, 7 Feather ---

@case("transitions2_iris_points", frames=frames(4))
def _(comp):
    effect(white(comp), "ADBE IRIS_WIPE", p1=[80.0, 60.0], p2=[6.0, 7.0, 12.0, 32.0], p3=45.0, p4=0, p5=0.0, p6=0.0, p7=0.0)


@case("transitions2_iris_inner", frames=frames(3))
def _(comp):
    effect(white(comp), "ADBE IRIS_WIPE", p1=[70.0, 55.0], p2=8.0, p3=50.0, p4=1, p5=[10.0, 25.0, 60.0], p6=[0.0, 15.0, 30.0], p7=0.0)


@case("transitions2_iris_feather", frames=frames(3))
def _(comp):
    effect(white(comp), "ADBE IRIS_WIPE", p1=[90.0, 50.0], p2=10.0, p3=40.0, p4=1, p5=20.0, p6=20.0, p7=[4.0, 10.0, 25.0])


@case("transitions2_iris_feather_edge", frames=frames(5))
def _(comp):
    # A triangle whose bottom edge runs straight along y = 60 across the middle.
    effect(white(comp), "ADBE IRIS_WIPE", p1=[80.0, 20.0], p2=6.0, p3=80.0, p4=0, p5=0.0, p6=0.0, p7=[2.0, 5.0, 10.0, 20.0, 40.0])


@case("transitions2_iris_card", frames=frames(3))
def _(comp):
    effect(on_card(comp), "ADBE IRIS_WIPE", p1=[60.0, 70.0], p2=6.0, p3=[20.0, 55.0, 120.0], p4=0, p5=0.0, p6=10.0, p7=3.0)


# --- Gradient Wipe: 1 Completion, 2 Softness, 3 Gradient Layer, 4 Placement, 5 Invert ---

def gradient_wipe(comp, layer, grad, **params):
    fx = effect(layer, "ADBE Gradient Wipe", **params)
    set_layer_param(fx["ADBE Gradient Wipe-0003"], grad)
    return fx


@case("transitions2_gradient_hard", frames=frames(4))
def _(comp):
    grad = hidden(comp, STEPS)
    gradient_wipe(comp, white(comp), grad, p1=[0.0, 0.25, 0.5, 0.9], p2=0.0, p4=3, p5=0)


@case("transitions2_gradient_soft", frames=frames(3))
def _(comp):
    grad = hidden(comp, STEPS)
    gradient_wipe(comp, white(comp), grad, p1=[0.3, 0.5, 0.5], p2=[0.1, 0.25, 1.0], p4=3, p5=0)


@case("transitions2_gradient_invert", frames=frames(2))
def _(comp):
    grad = hidden(comp, STEPS_V)
    gradient_wipe(comp, white(comp), grad, p1=[0.4, 0.7], p2=0.2, p4=3, p5=1)


@case("transitions2_gradient_tile", frames=frames(2))
def _(comp):
    grad = hidden(comp, STEPS_SMALL)
    gradient_wipe(comp, white(comp), grad, p1=[0.35, 0.6], p2=0.1, p4=1, p5=0)


@case("transitions2_gradient_center", frames=frames(2))
def _(comp):
    grad = hidden(comp, STEPS_SMALL)
    gradient_wipe(comp, white(comp), grad, p1=[0.35, 0.6], p2=0.1, p4=2, p5=0)


@case("transitions2_gradient_stretch_white", frames=frames(1))
def _(comp):
    # Full softness at half completion keeps each pixel by its gradient level: the alpha is the stretched gradient.
    grad = hidden(comp, STEPS_SMALL)
    gradient_wipe(comp, white(comp), grad, p1=0.5, p2=1.0, p4=3, p5=0)


@case("transitions2_gradient_stretch", frames=frames(2))
def _(comp):
    grad = hidden(comp, STEPS_SMALL)
    gradient_wipe(comp, on_card(comp), grad, p1=[0.35, 0.6], p2=0.1, p4=3, p5=0)


# Block Dissolve has no case: After Effects picks its blocks with its own random numbers, so the renderer is a
# look-alike no reference frame can check.

# --- CC Grid Wipe: 1 Completion, 2 Center, 3 Rotation, 4 Border, 5 Tiles, 6 Shape, 7 Reverse ---

for name, shape in (("doors", 1), ("radial", 2), ("rect", 3)):

    @case(f"transitions2_gridwipe_{name}", frames=frames(4))
    def _(comp, shape=shape):
        effect(white(comp), "CC Grid Wipe", p1=[0.1, 0.3, 0.5, 0.8], p2=[80.0, 60.0], p3=0.0, p4=75.0, p5=4.0, p6=shape, p7=0)


@case("transitions2_gridwipe_rotated", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Grid Wipe", p1=[0.2, 0.45, 0.7], p2=[60.0, 50.0], p3=30.0, p4=[50.0, 120.0, 200.0], p5=6.0, p6=2, p7=0)


@case("transitions2_gridwipe_reverse", frames=frames(2))
def _(comp):
    effect(white(comp), "CC Grid Wipe", p1=[0.3, 0.6], p2=[80.0, 60.0], p3=45.0, p4=75.0, p5=5.0, p6=3, p7=1)


# --- CC Radial ScaleWipe: 1 Completion, 2 Center, 3 Reverse ---

@case("transitions2_radialscale", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Radial ScaleWipe", p1=[0.2, 0.5, 0.8], p2=[70.0, 55.0], p3=0)


@case("transitions2_radialscale_ramp", frames=frames(3))
def _(comp):
    # A black-to-white ramp across the layer: the grey level tells which column each pixel shows.
    layer = white(comp)
    effect(layer, "ADBE Ramp", p1=[0.0, 60.0], p2=[0.0, 0.0, 0.0, 1.0], p3=[160.0, 60.0], p4=[1.0, 1.0, 1.0, 1.0], p5=1, p6=0.0, p7=0.0)
    effect(layer, "CC Radial ScaleWipe", p1=[0.1, 0.3, 0.5], p2=[40.0, 60.0], p3=0)


@case("transitions2_radialscale_ramp2", frames=frames(3))
def _(comp):
    layer = white(comp)
    effect(layer, "ADBE Ramp", p1=[0.0, 60.0], p2=[0.0, 0.0, 0.0, 1.0], p3=[160.0, 60.0], p4=[1.0, 1.0, 1.0, 1.0], p5=1, p6=0.0, p7=0.0)
    effect(layer, "CC Radial ScaleWipe", p1=[0.2, 0.5, 0.8], p2=[70.0, 55.0], p3=0)


@case("transitions2_radialscale_ramp_reverse", frames=frames(2))
def _(comp):
    layer = white(comp)
    effect(layer, "ADBE Ramp", p1=[0.0, 60.0], p2=[0.0, 0.0, 0.0, 1.0], p3=[160.0, 60.0], p4=[1.0, 1.0, 1.0, 1.0], p5=1, p6=0.0, p7=0.0)
    effect(layer, "CC Radial ScaleWipe", p1=[0.3, 0.6], p2=[90.0, 65.0], p3=1)


@case("transitions2_radialscale_reverse", frames=frames(2))
def _(comp):
    effect(on_card(comp), "CC Radial ScaleWipe", p1=[0.3, 0.6], p2=[90.0, 65.0], p3=1)


# --- CC Scale Wipe: 1 Stretch, 2 Center, 3 Direction ---

@case("transitions2_scalewipe", frames=frames(4))
def _(comp):
    effect(on_card(comp), "CC Scale Wipe", p1=[10.0, 30.0, 60.0, 100.0], p2=[80.0, 60.0], p3=0.0)


@case("transitions2_scalewipe_dir", frames=frames(4))
def _(comp):
    effect(on_card(comp), "CC Scale Wipe", p1=[40.0, 40.0, -40.0, 40.0], p2=[70.0, 50.0], p3=[50.0, 90.0, 90.0, 200.0])


# --- CC Jaws: 1 Completion, 2 Center, 3 Direction, 4 Height, 5 Width, 6 Shape ---

for name, shape in (("spikes", 1), ("robojaw", 2), ("block", 3), ("waves", 4)):

    @case(f"transitions2_jaws_{name}", frames=frames(3))
    def _(comp, shape=shape):
        effect(white(comp), "CC Jaws", p1=[0.0, 0.3, 0.6], p2=[80.0, 60.0], p3=0.0, p4=0.2, p5=8.0, p6=shape)


@case("transitions2_jaws_rot", frames=frames(4))
def _(comp):
    effect(white(comp), "CC Jaws", p1=0.3, p2=[80.0, 60.0], p3=[30.0, 90.0, 135.0, 200.0], p4=0.2, p5=8.0, p6=1)


@case("transitions2_jaws_size", frames=frames(4))
def _(comp):
    effect(white(comp), "CC Jaws", p1=0.3, p2=[50.0, 40.0], p3=0.0, p4=[0.05, 0.1, 0.3, 0.2], p5=[4.0, 12.0, 20.0, 8.0], p6=1)


@case("transitions2_jaws_shapes_rot", frames=frames(3))
def _(comp):
    effect(white(comp), "CC Jaws", p1=0.3, p2=[80.0, 60.0], p3=30.0, p4=0.2, p5=8.0, p6=[2, 3, 4])


@case("transitions2_jaws_dir", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Jaws", p1=0.4, p2=[70.0, 50.0], p3=[30.0, 90.0, 135.0], p4=[0.1, 0.3, 0.05], p5=[5.0, 12.0, 20.0], p6=1)


# --- CC Line Sweep: 1 Completion, 2 Direction, 3 Thickness, 4 Slant, 5 Flip ---

@case("transitions2_linesweep", frames=frames(4))
def _(comp):
    effect(white(comp), "CS LineSweep", p1=[10.0, 30.0, 50.0, 80.0], p2=180.0, p3=30.0, p4=50.0, p5=0)


# Direction, Thickness and Slant cannot be keyframed.
for name, direction, thickness, slant in (("a", 90, 20, 25), ("b", 45, 40, 75), ("c", 180, 15, 0), ("d", 180, 15, 90), ("e", 300, 60, 10)):

    @case(f"transitions2_linesweep_{name}", frames=frames(2))
    def _(comp, direction=direction, thickness=thickness, slant=slant):
        effect(white(comp), "CS LineSweep", p1=[30.0, 60.0], p2=float(direction), p3=float(thickness), p4=float(slant), p5=0)


# Thicknesses that do not divide the box: where the lines start.
for name, direction, thickness in (("anchor90", 90, 30), ("anchor180", 180, 50), ("anchor45", 45, 50)):

    @case(f"transitions2_linesweep_{name}", frames=frames(3))
    def _(comp, direction=direction, thickness=thickness):
        effect(white(comp), "CS LineSweep", p1=[20.0, 40.0, 60.0], p2=float(direction), p3=float(thickness), p4=50.0, p5=0)


@case("transitions2_linesweep_flip", frames=frames(2))
def _(comp):
    effect(on_card(comp), "CS LineSweep", p1=[30.0, 60.0], p2=120.0, p3=25.0, p4=60.0, p5=1)


# --- CC Light Wipe: 1 Completion, 2 Center, 3 Intensity, 4 Shape, 5 Direction, 6 Color from Source, 7 Color, 8 Reverse ---

for name, shape in (("doors", 1), ("round", 2), ("square", 3)):

    @case(f"transitions2_lightwipe_{name}", frames=frames(3))
    def _(comp, shape=shape):
        effect(on_card(comp), "CC Light Wipe", p1=[20.0, 45.0, 70.0], p2=[80.0, 60.0], p3=100.0, p4=shape, p5=0.0, p6=0, p7=[1.0, 1.0, 1.0, 1.0], p8=0)


@case("transitions2_lightwipe_params", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Light Wipe", p1=40.0, p2=[60.0, 50.0], p3=[50.0, 200.0, 100.0], p4=3, p5=[20.0, 20.0, 45.0], p6=0, p7=[1.0, 0.6, 0.2, 1.0], p8=0)


@case("transitions2_lightwipe_white", frames=frames(2))
def _(comp):
    effect(white(comp), "CC Light Wipe", p1=[30.0, 60.0], p2=[80.0, 60.0], p3=100.0, p4=2, p5=0.0, p6=0, p7=[0.2, 0.4, 1.0, 1.0], p8=0)


# --- CC Image Wipe: 1 Completion, 2 Border Softness, 3 Auto Softness, 5 Layer, 6 Property, 4 Blur, 7 Inverse ---

def image_wipe(layer, grad, **params):
    fx = effect(layer, "CC Image Wipe", **params)
    set_layer_param(fx["CC Image Wipe-0005"], grad)
    return fx


@case("transitions2_imagewipe", frames=frames(4))
def _(comp):
    grad = hidden(comp, STEPS)
    image_wipe(white(comp), grad, p1=[0.2, 0.4, 0.6, 0.9], p2=0.0, p3=0, p6=5, p4=0.0, p7=0)


@case("transitions2_imagewipe_soft", frames=frames(3))
def _(comp):
    grad = hidden(comp, STEPS)
    image_wipe(white(comp), grad, p1=0.5, p2=[0.05, 0.2, 0.5], p3=0, p6=5, p4=0.0, p7=0)


# Keyed Property popups do not take effect in After Effects as py-aep writes them: one comp per Property.
@case("transitions2_imagewipe_card", frames=frames(1))
def _(comp):
    grad = hidden(comp, CARD)
    image_wipe(on_card(comp), grad, p1=0.3, p2=0.1, p3=0, p6=1, p4=0.0, p7=0)


@case("transitions2_imagewipe_card3", frames=frames(2))
def _(comp):
    grad = hidden(comp, CARD)
    image_wipe(on_card(comp), grad, p1=[0.5, 0.35], p2=0.1, p3=0, p6=3, p4=0.0, p7=1)


@case("transitions2_imagewipe_card2", frames=frames(2))
def _(comp):
    grad = hidden(comp, CARD)
    image_wipe(on_card(comp), grad, p1=[0.7, 0.45], p2=0.25, p3=0, p6=2, p4=0.0, p7=0)


# --- CC Glass Wipe: 1 Completion, 2 Layer to Reveal, 3 Gradient Layer, 4 Softness, 5 Displacement ---

@case("transitions2_glasswipe", frames=frames(3))
def _(comp):
    grad = hidden(comp, STEPS)
    reveal = comp.add_solid([0.2, 0.6, 0.9], "reveal")
    reveal.enabled = False
    layer = white(comp)
    fx = effect(layer, "CC Glass Wipe", p1=[25.0, 50.0, 75.0], p4=10.0, p5=0.0)
    set_layer_param(fx["CC Glass Wipe-0002"], reveal)
    set_layer_param(fx["CC Glass Wipe-0003"], grad)


@case("transitions2_glasswipe_card", frames=frames(3))
def _(comp):
    grad = hidden(comp, STEPS_V)
    reveal = comp.add_solid([0.9, 0.3, 0.1], "reveal")
    reveal.enabled = False
    layer = on_card(comp)
    fx = effect(layer, "CC Glass Wipe", p1=[30.0, 50.0, 70.0], p4=[10.0, 30.0, 60.0], p5=[25.0, 50.0, 100.0])
    set_layer_param(fx["CC Glass Wipe-0002"], reveal)
    set_layer_param(fx["CC Glass Wipe-0003"], grad)


# --- CC Twister: 2 Completion, 1 Backside, 3 Shading, 4 Center, 5 Axis ---

@case("transitions2_twister", frames=frames(4))
def _(comp):
    effect(on_card(comp), "CC Twister", p2=[0.1, 0.3, 0.6, 0.9], p3=0, p4=[80.0, 60.0], p5=0.0)


@case("transitions2_twister_shaded", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Twister", p2=[0.2, 0.4, 0.7], p3=1, p4=[70.0, 55.0], p5=[-120.0, 30.0, 90.0])


suite.save()
manifest = REFS / suite.manifest_file
data = json.loads(manifest.read_text(encoding="utf-8"))
data["known"] = KNOWN
manifest.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
