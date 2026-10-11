# Builds refs/fixtures/stockfx.aep: the stock effects with renderers in
# src/render/effects/{colorCorrection,blurSharpen,distort,stylize,matte}.ts whose
# definitions an After Effects-saved project of the py-aep corpus holds (Tint,
# Brightness & Contrast, Exposure, Hue/Saturation, Gaussian Blur, Drop Shadow,
# Glow, Transform, Set Matte, Fill), each on a textured card and on an alpha-edged
# star, with every parameter the case depends on set. The other new renderers have
# no donor definition here; scripts/check-stock-effects.ts exercises them.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_stockfx.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BG, ORANGE, TEAL, Suite, add, add_effect, fill, install_effects, set_layer_param, shape_group, stroke, tr  # noqa: E402

EFFECTS = [
    "ADBE Tint",
    "ADBE Brightness & Contrast 2",
    "ADBE Exposure2",
    "ADBE HUE SATURATION",
    "ADBE Gaussian Blur 2",
    "ADBE Drop Shadow",
    "ADBE Glo2",
    "ADBE Set Matte3",
    "ADBE Fill",
]
suite = Suite("stockfx")
# py-aep defines Transform (ADBE Geometry2) itself.
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
    inner = folder.add_comp(f"stockfx_card_{w}x{h}_{cell}", w, h, 1.0, 1.0, 24.0)
    cols = (w + cell - 1) // cell
    for j in range((h + cell - 1) // cell):
        for i in range(cols):
            s = inner.add_solid(CELL_COLORS[(j * cols + i) % len(CELL_COLORS)], f"c{i}_{j}", cell, cell)
            tr(s, "ADBE Position").value = [i * cell + cell / 2, j * cell + cell / 2, 0.0]
    return inner


CARD = card()


def star(comp):
    layer = comp.add_shape()
    g = shape_group(layer)
    add(g, "ADBE Vector Shape - Star", **{"ADBE Vector Star Points": 5.0, "ADBE Vector Star Outer Radius": 40.0, "ADBE Vector Star Inner Radius": 18.0})
    stroke(g, TEAL, 4.0)
    fill(g, ORANGE)
    return layer


def on_card(comp):
    comp.add_solid(BG, "bg")
    return comp.add(CARD)


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


@case("stockfx_tint", frames=frames(3))
def _(comp):
    effect(on_card(comp), "ADBE Tint", p1=[0.1, 0.0, 0.3, 1.0], p2=[1.0, 0.9, 0.6, 1.0], p3=[100.0, 50.0, 0.0])


@case("stockfx_brightness_contrast", frames=frames(4))
def _(comp):
    effect(on_card(comp), "ADBE Brightness & Contrast 2", p1=[40.0, -60.0, 0.0, 40.0], p2=[0.0, 0.0, 50.0, -50.0], p3=0)


@case("stockfx_brightness_contrast_legacy", frames=frames(2))
def _(comp):
    effect(on_card(comp), "ADBE Brightness & Contrast 2", p1=[30.0, -30.0], p2=[40.0, -40.0], p3=1)


@case("stockfx_exposure", frames=frames(4))
def _(comp):
    effect(on_card(comp), "ADBE Exposure2", p1=1, p3=[1.0, -1.0, 0.0, 0.0], p4=[0.0, 0.0, 0.1, 0.0], p5=[1.0, 1.0, 1.0, 2.0], p22=0)


@case("stockfx_exposure_bypass", frames=frames(1))
def _(comp):
    effect(on_card(comp), "ADBE Exposure2", p1=1, p3=1.0, p4=0.0, p5=1.0, p22=1)


# Hue/Saturation's values cannot be keyframed: one comp per setting.
for name, hue, saturation, lightness in (("hue", 60.0, 0.0, 0.0), ("desaturate", 0.0, -60.0, 0.0), ("saturate", 0.0, 60.0, 0.0), ("darken", 0.0, 0.0, -40.0)):

    @case(f"stockfx_hue_saturation_{name}")
    def _(comp, hue=hue, saturation=saturation, lightness=lightness):
        effect(on_card(comp), "ADBE HUE SATURATION", p2=1, p4=hue, p5=saturation, p6=lightness, p7=0)


@case("stockfx_hue_saturation_colorize", frames=frames(1))
def _(comp):
    effect(on_card(comp), "ADBE HUE SATURATION", p2=1, p7=1, p8=200.0, p9=60.0, p10=10.0)


@case("stockfx_gaussian", frames=frames(4))
def _(comp):
    effect(on_card(comp), "ADBE Gaussian Blur 2", p1=[2.0, 6.0, 20.0, 80.0], p2=1, p3=0)


@case("stockfx_gaussian_dims_repeat", frames=frames(3))
def _(comp):
    effect(on_card(comp), "ADBE Gaussian Blur 2", p1=10.0, p2=[1.0, 2.0, 3.0], p3=1)


@case("stockfx_gaussian_alpha", frames=frames(2))
def _(comp):
    effect(star(comp), "ADBE Gaussian Blur 2", p1=[4.0, 15.0], p2=1, p3=0)


@case("stockfx_drop_shadow", frames=frames(3))
def _(comp):
    effect(star(comp), "ADBE Drop Shadow", p1=[0.0, 0.0, 0.0, 1.0], p2=[127.5, 255.0, 200.0], p3=[135.0, 45.0, 270.0], p4=[5.0, 12.0, 20.0], p5=[0.0, 10.0, 30.0], p6=0)


@case("stockfx_drop_shadow_only", frames=frames(1))
def _(comp):
    effect(star(comp), "ADBE Drop Shadow", p1=[0.9, 0.1, 0.1, 1.0], p2=255.0, p3=135.0, p4=8.0, p5=6.0, p6=1)


@case("stockfx_glow", frames=frames(3))
def _(comp):
    effect(on_card(comp), "ADBE Glo2", p1=2, p2=[153.0, 100.0, 200.0], p3=[10.0, 25.0, 5.0], p4=[1.0, 2.0, 1.0], p5=2, p6=3, p7=1, p14=1)


@case("stockfx_glow_alpha_ab", frames=frames(1))
def _(comp):
    effect(star(comp), "ADBE Glo2", p1=1, p2=128.0, p3=15.0, p4=1.0, p5=2, p6=3, p7=2, p8=3, p9=1.0, p10=0.0, p11=0.5, p12=[1.0, 1.0, 0.0, 1.0], p13=[1.0, 0.0, 0.0, 1.0], p14=1)


@case("stockfx_transform", frames=frames(3))
def _(comp):
    effect(on_card(comp), "ADBE Geometry2", p1=[40.0, 30.0], p2=[[40.0, 30.0], [50.0, 25.0], [30.0, 40.0]], p11=1, p3=[100.0, 70.0, 130.0], p5=[0.0, 15.0, 0.0], p6=0.0, p7=[30.0, 0.0, -45.0], p8=[100.0, 60.0, 100.0], p9=1, p10=0.0, p12=1)


@case("stockfx_set_matte", frames=frames(2))
def _(comp):
    comp.add_solid(BG, "bg")
    matte = star(comp)
    matte.enabled = False
    layer = comp.add(CARD)
    fx = effect(layer, "ADBE Set Matte3", p2=[4, 5], p3=0, p4=1, p5=1, p6=1)
    set_layer_param(fx["ADBE Set Matte3-0001"], matte)


@case("stockfx_fill", frames=frames(2))
def _(comp):
    effect(star(comp), "ADBE Fill", p1=0, p7=0, p2=[0.2, 0.6, 1.0, 1.0], p6=0, p5=[1.0, 0.5])


suite.save()
