# Builds refs/fixtures/particular.aep: Trapcode Particular measured on isolated particles. Every row is one
# Particular layer whose particles leave a point emitter in a straight line at a fixed speed, one per second, with
# no randomness, so each particle of a row is drawn alone with the same settings (only its age differs). The comps
# sweep the glow (size, opacity, feather, blend mode), the particle (size, feather, colour, type) and sprites (the
# Sprite, Sprite Colorize, Sprite Fill and Textured Polygon types, rotation, aspect ratio and time sampling of an
# animated texture layer). Rendered on transparency.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_particular.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import Suite, _leaves, add, add_effect, fill, gtr, install_effects, py_aep, set_layer_param, shape_group  # noqa: E402

USER_PROJECT = "C:/Users/schxm/projects/_user/bass-supreme.aep"

suite = Suite("particular")
install_effects(suite, ["tc Particular"])
_user = py_aep.parse(USER_PROJECT).project


def _user_instance():
    comps = [i for i in _user.items.values() if getattr(i, "name", None) == "Real Particles" and hasattr(i, "layers")]
    layer = next(lay for comp in comps for lay in comp.layers if lay.name == "Dark Gray Solid 1")
    return next(fx for fx in layer["ADBE Effect Parade"].properties if fx.match_name == "tc Particular")


USER_FX = _user_instance()


def user_particular(layer, **params):
    """Particular with the static values of the user's instance (layer parameters unset), then `params` by index."""
    fx = add_effect(layer, "tc Particular")
    targets = {leaf.match_name: leaf for leaf in _leaves(fx)}
    for leaf in _leaves(USER_FX):
        target = targets.get(leaf.match_name)
        if target is None or getattr(leaf, "_tdpi", None) is not None:
            continue
        try:
            if leaf.value is not None:
                target.value = leaf.value
        except Exception:  # noqa: BLE001 - groups, layer and custom-data parameters carry no plain value
            pass
    for key, value in params.items():
        fx[f"tc Particular-{int(key[1:]):04d}"].value = value
    return fx

W, H = 1100, 640
FPS = 24.0
#: Rows of a comp, from the top.
ROWS = [80.0, 240.0, 400.0, 560.0]
#: Emitter x, speed (px/s) and frame: particles at 50 + 150·age, ages 0.5 s apart from 0.5 to 6.5 s.
X0, SPEED = 50.0, 150.0
FRAME = 156

TYPE = {"sphere": 1, "glow": 2, "star": 3, "cloudlet": 4, "streaklet": 5, "sprite": 6, "colorize": 7, "fill": 8,
        "polygon": 9, "polygon_colorize": 10, "polygon_fill": 11, "square": 12, "circle": 13}
BLEND = {"normal": 1, "add": 2, "screen": 3, "lighten": 4}

#: Everything that would move, blur, shade or randomise a particle, off.
BASE = dict(
    p529=1,  # Emitter Behavior: Continuous
    p146=1.0,  # Particles/sec
    p5=1,  # Emitter Type: Point
    p113=2,  # Direction: Directional
    p10=0.0,  # Direction Spread
    p112=0.0, p111=90.0, p76=0.0,  # emitter rotation: along +x
    p11=SPEED, p12=0.0, p13=0.0,  # Velocity, Velocity Random, Velocity from Motion
    p2=20.0, p65=0.0,  # Life, Life Random
    p26=TYPE["glow"], p29=50.0,  # Particle Type, Particle Feather
    p267=1, p275=0.0, p276=0.0, p136=0.0, p137=0.0, p277=0.0, p278=0.0, p138=0.0, p279=0.0,  # rotation
    p524=1.0,  # Aspect Ratio
    p27=16.0, p74=0.0,  # Size, Size Random
    p33=100.0, p75=0.0,  # Opacity, Opacity Random
    p88=1, p70=[1.0, 1.0, 1.0, 1.0], p71=0.0,  # Set Color At Start, Color, Color Random
    p69=BLEND["normal"], p531=1,  # Blend Mode, Unmult
    p215=300.0, p216=50.0, p217=100.0, p218=1,  # Glow Size, Opacity, Feather, Blend Mode
    p284=1,  # Shading off
    p119=1, p17=0.0, p25=1.0, p18=0.0, p19=0.0, p22=0.0, p23=0.0, p24=0.0,  # physics
    p41=0.0, p42=0.0,  # turbulence
    p148=1,  # Aux System off
    p227=0.0,  # Pre Run
    p319=1, p35=1,  # Depth of Field, Motion Blur: off
    p290=0.0, p291=0.0, p292=0.0, p293=0.0, p294=0.0, p295=0.0,  # World Transform (the user's turns Y by 90)
)


def row(comp, k, label, **overrides):
    layer = comp.add_solid([0.5, 0.5, 0.5], f"row {k} {label}", W, H)
    params = {**BASE, "p581": [X0, ROWS[k], 0.0], **overrides}
    return user_particular(layer, **params)


def sweep(name, label, values, frames=(FRAME,), **shared):
    """One row per value of parameter `label` (e.g. "p215")."""

    @suite.case(name, frames=frames, width=W, height=H, duration=7.0, fps=FPS)
    def _(comp):
        for k, value in enumerate(values):
            row(comp, k, f"{label}={value}", **{**shared, label: value})


# --- Glow Sphere ---------------------------------------------------------------------

sweep("particular_glow_size", "p215", [100.0, 200.0, 300.0, 400.0])
sweep("particular_glow_opacity", "p216", [10.0, 25.0, 50.0, 100.0])
sweep("particular_glow_feather", "p217", [0.0, 33.0, 66.0, 100.0])
sweep("particular_glow_psize", "p27", [6.0, 12.0, 24.0, 36.0])
sweep("particular_glow_pfeather", "p29", [0.0, 25.0, 50.0, 100.0])
sweep("particular_glow_popacity", "p33", [100.0, 60.0, 30.0, 10.0])
sweep("particular_glow_color", "p70", [[1.0, 0.5, 0.1, 1.0], [0.2, 0.4, 1.0, 1.0], [0.5, 0.5, 0.5, 1.0], [1.0, 0.0, 0.0, 1.0]])


@suite.case("particular_glow_blend", frames=(FRAME,), width=W, height=H, duration=7.0, fps=FPS)
def _(comp):
    # Particles 9 px apart: neighbours overlap, so the blend modes between them show.
    for k, (particle, glow) in enumerate([("normal", "normal"), ("normal", "add"), ("normal", "screen"), ("add", "add")]):
        row(comp, k, f"{particle}/{glow}", p11=18.0, p146=2.0, p216=40.0, p69=BLEND[particle], p218=BLEND[glow])


@suite.case("particular_glow_blend2", frames=(FRAME,), width=W, height=H, duration=7.0, fps=FPS)
def _(comp):
    for k, (particle, glow) in enumerate([("add", "normal"), ("screen", "screen"), ("lighten", "normal"), ("add", "screen")]):
        row(comp, k, f"{particle}/{glow}", p11=18.0, p146=2.0, p216=40.0, p69=BLEND[particle], p218=BLEND[glow])


sweep("particular_types", "p26", [TYPE["sphere"], TYPE["star"], TYPE["circle"], TYPE["square"]], p27=24.0)

# Fits: the core alone and the glow at full opacity.
sweep("particular_fit_sphere_feather", "p29", [0.0, 25.0, 75.0, 100.0], p26=TYPE["sphere"], p27=24.0)
sweep("particular_fit_sphere_size", "p27", [4.0, 8.0, 12.0, 40.0], p26=TYPE["sphere"])


@suite.case("particular_fit_glow", frames=(FRAME,), width=W, height=H, duration=7.0, fps=FPS)
def _(comp):
    for k, (size, feather) in enumerate([(200.0, 0.0), (400.0, 0.0), (200.0, 50.0), (400.0, 50.0)]):
        row(comp, k, f"glow {size} feather {feather}", p216=100.0, p215=size, p217=feather)


@suite.case("particular_fit_glow2", frames=(FRAME,), width=W, height=H, duration=7.0, fps=FPS)
def _(comp):
    rows = [
        ("size 8 glow 400", dict(p27=8.0, p215=400.0)),
        ("size 24 glow 200", dict(p27=24.0, p215=200.0)),
        ("feather 0", dict(p29=0.0)),
        ("feather 100", dict(p29=100.0)),
    ]
    for k, (label, overrides) in enumerate(rows):
        row(comp, k, label, p216=100.0, **overrides)


# Every Particular instance stores its whole definition (about 1.3 MB): the harness page cannot load all the
# comps from one project, so the sprites are a project of their own.
suite.save()
suite = Suite("particular_sprite")
install_effects(suite, ["tc Particular"])


# --- Sprites ---------------------------------------------------------------------------


def texture_source():
    """A 64x48 texture that shows its orientation: red left half, green disc top right, blue bar bottom right."""
    comp = suite.folder.add_comp("particular_src_texture", 64, 48, 1.0, 7.0, FPS)
    layer = comp.add_shape()
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [-16.0, 0.0])
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [32.0, 48.0]})
    fill(g, [1.0, 0.1, 0.1])
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [16.0, -12.0])
    add(g, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [20.0, 20.0]})
    fill(g, [0.1, 1.0, 0.2])
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [16.0, 14.0])
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [28.0, 8.0]})
    fill(g, [0.2, 0.3, 1.0], **{"ADBE Vector Fill Opacity": 60.0})
    return comp


def animated_source():
    """A 32x32 square whose grey level steps from black to white over its 24 frames, then stays white."""
    comp = suite.folder.add_comp("particular_src_anim", 32, 32, 1.0, 1.0, FPS)
    layer = comp.add_shape()
    g = shape_group(layer)
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [32.0, 32.0]})
    item = fill(g, [0.0, 0.0, 0.0])
    prop = item["ADBE Vector Fill Color"]
    for k in range(24):
        v = k / 23.0
        prop.set_value_at_time(k / FPS, [v, 1.0 - v, 0.5, 1.0])
    return comp


TEXTURE = texture_source()
ANIMATED = animated_source()


def texture_layer(comp, source):
    layer = comp.add(source)
    layer.enabled = False
    return layer


def sprite_case(name, rows, source=TEXTURE, frames=(FRAME,)):
    @suite.case(name, frames=frames, width=W, height=H, duration=7.0, fps=FPS)
    def _(comp):
        texture = texture_layer(comp, source)
        for k, (label, overrides) in enumerate(rows):
            fx = row(comp, k, label, **{"p27": 48.0, "p70": [1.0, 0.6, 0.2, 1.0], **overrides})
            set_layer_param(fx["tc Particular-0066"], texture)


sprite_case(
    "particular_sprite_types",
    [("sprite", dict(p26=TYPE["sprite"])), ("colorize", dict(p26=TYPE["colorize"])), ("fill", dict(p26=TYPE["fill"])), ("polygon", dict(p26=TYPE["polygon"]))],
)
sprite_case(
    "particular_sprite_shape",
    [
        ("size 24", dict(p26=TYPE["sprite"], p27=24.0)),
        ("aspect 2", dict(p26=TYPE["sprite"], p524=2.0)),
        ("rotate 45", dict(p26=TYPE["sprite"], p136=45.0)),
        ("feather 0, opacity 50", dict(p26=TYPE["sprite"], p29=0.0, p33=50.0)),
    ],
)
sprite_case(
    "particular_sprite_spin",
    [
        ("speed z 0.25", dict(p26=TYPE["sprite"], p138=0.25)),
        ("polygon rotate x 60", dict(p26=TYPE["polygon"], p275=60.0)),
        ("polygon rotate y 60", dict(p26=TYPE["polygon"], p276=60.0)),
        ("polygon colorize", dict(p26=TYPE["polygon_colorize"])),
    ],
)
sprite_case(
    "particular_sprite_time",
    [
        ("current time", dict(p26=TYPE["sprite"], p67=1)),
        ("birth play once", dict(p26=TYPE["sprite"], p67=2)),
        ("birth loop", dict(p26=TYPE["sprite"], p67=3)),
        ("birth stretch", dict(p26=TYPE["sprite"], p67=4)),
    ],
    source=ANIMATED,
    frames=(60, FRAME),
)

def block_source(name, w, h):
    """A w x h texture: red left half, green disc at the top right."""
    comp = suite.folder.add_comp(name, w, h, 1.0, 7.0, FPS)
    layer = comp.add_shape()
    g = shape_group(layer)
    gtr(g, "ADBE Vector Position", [-w / 4, 0.0])
    add(g, "ADBE Vector Shape - Rect", **{"ADBE Vector Rect Size": [w / 2, float(h)]})
    fill(g, [1.0, 0.1, 0.1])
    g = shape_group(layer)
    d = min(w, h) / 3
    gtr(g, "ADBE Vector Position", [w / 4, -h / 4])
    add(g, "ADBE Vector Shape - Ellipse", **{"ADBE Vector Ellipse Size": [d, d]})
    fill(g, [0.1, 1.0, 0.2])
    return comp


SIZED = [block_source("particular_src_tall", 32, 96), block_source("particular_src_wide", 96, 32), block_source("particular_src_square", 50, 50)]


@suite.case("particular_fit_sprite_size", frames=(FRAME,), width=W, height=H, duration=7.0, fps=FPS)
def _(comp):
    rows = [(SIZED[0], {}), (SIZED[1], {}), (SIZED[2], {}), (TEXTURE, dict(p27=24.0, p524=2.0))]
    for k, (source, overrides) in enumerate(rows):
        texture = texture_layer(comp, source)
        fx = row(comp, k, source.name, **{"p26": TYPE["sprite"], "p27": 32.0, **overrides})
        set_layer_param(fx["tc Particular-0066"], texture)


suite.save()
