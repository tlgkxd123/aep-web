# Builds refs/fixtures/channel.aep: the Channel and Utility effects rendered by
# src/render/effects/channelUtility.ts (Set Channels, Channel Combiner,
# Arithmetic, Compound Arithmetic, Blend, Calculations, Solid Composite, CC
# Composite, Grow Bounds, Cineon Converter, CC Overbrights, HDR Compander, HDR
# Highlight Compression). Each runs on a card of cells in scattered colours, some
# rows partly transparent and some cells empty, with no background, so the
# references show the effect's colour and alpha; the layer-input effects read a
# second card of another size. Popups and other parameters are keyed one value
# per frame to sweep their settings.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_channel.py
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import REFS, Suite, add_effect, install_effects, set_layer_param, tr  # noqa: E402

EFFECTS = [
    "ADBE Set Channels",
    "ADBE Channel Combiner",
    "ADBE Arithmetic",
    "ADBE Compound Arithmetic",
    "ADBE Blend",
    "ADBE Calculations",
    "ADBE Solid Composite",
    "CC Composite",
    "ADBE GROW BOUNDS",
    "ADBE Cineon Converter2",
    "CC Overbrights",
    "ADBE Compander",
    "ADBE HDR ToneMap",
    "ADBE Tint",
    "ADBE Gaussian Blur 2",
]
suite = Suite("channel")
install_effects(suite, EFFECTS)
case = suite.case
folder = suite.folder


def scattered(seed):
    """Deterministic 8-bit colours spread over the cube."""
    state = seed
    while True:
        rgb = []
        for _ in range(3):
            state = (state * 1103515245 + 12345) % 2147483648
            rgb.append((state >> 16) % 256 / 255.0)
        yield rgb


def card(name, cols, rows, seed, opacities, empty):
    """A precomp of 10 px solids: row 0 holds greys, the rest scattered colours; `opacities` per row, `empty` cells left out."""
    inner = folder.add_comp(name, cols * 10, rows * 10, 1.0, 1.0, 24.0)
    colours = scattered(seed)
    for j in range(rows):
        for i in range(cols):
            colour = next(colours)
            if j == 0:
                colour = [round(i * 255 / (cols - 1)) / 255.0] * 3
            if j in opacities:
                # Multiples of 5 at a fifth of full opacity premultiply to whole 8-bit values.
                colour = [round(c * 255 / 5) * 5 / 255.0 for c in colour]
            if (i, j) in empty:
                continue
            s = inner.add_solid(colour, f"c{i}_{j}", 10, 10)
            tr(s, "ADBE Position").value = [i * 10 + 5.0, j * 10 + 5.0, 0.0]
            if opacities.get(j, 100.0) != 100.0:
                tr(s, "ADBE Opacity").value = opacities[j]
    return inner


CARD_A = card("channel_card_a", 16, 12, 7, {9: 60.0, 10: 40.0, 11: 20.0}, {(15, 2), (15, 4), (15, 6), (14, 10), (3, 11)})
CARD_B = card("channel_card_b", 10, 8, 99, {6: 60.0, 7: 20.0}, {(9, 3), (0, 7)})


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


def layer_a(comp):
    return comp.add(CARD_A)


def second(comp):
    """CARD_B, switched off: only read through layer parameters."""
    b = comp.add(CARD_B)
    b.enabled = False
    return b


def frames(n):
    return tuple(range(n))


def menu(n, separators=()):
    """A popup's stored values, separators left out."""
    return [float(v) for v in range(1, n + 1) if v not in separators]


# --- Set Channels ---------------------------------------------------------------

@case("channel_cards", frames=frames(1), height=220)
def _(comp):
    """Both cards with no effect: the inputs every other comp starts from."""
    tr(layer_a(comp), "ADBE Position").value = [80.0, 60.0, 0.0]
    tr(comp.add(CARD_B), "ADBE Position").value = [80.0, 170.0, 0.0]


@case("channel_set_channels_self", frames=frames(10))
def _(comp):
    effect(
        layer_a(comp),
        "ADBE Set Channels",
        p2=[float((k + 1) % 10 + 1) for k in range(10)],
        p4=[float((k + 2) % 10 + 1) for k in range(10)],
        p6=[float((k + 3) % 10 + 1) for k in range(10)],
        p8=[4.0, 4.0, 5.0, 9.0, 1.0, 8.0, 4.0, 2.0, 7.0, 3.0],
        p9=1,
    )


@case("channel_set_channels_layers", frames=frames(2))
def _(comp):
    b = second(comp)
    fx = effect(layer_a(comp), "ADBE Set Channels", p2=1, p4=2, p6=5, p8=4, p9=[1.0, 0.0])
    set_layer_param(fx["ADBE Set Channels-0001"], b)
    set_layer_param(fx["ADBE Set Channels-0005"], b)
    set_layer_param(fx["ADBE Set Channels-0007"], b)


# --- Channel Combiner -------------------------------------------------------------

COMBINER_FROM = menu(19, (6, 11, 17))
COMBINER_TO = menu(17, (5, 9, 14))


@case("channel_combiner_from", frames=frames(len(COMBINER_FROM)))
def _(comp):
    effect(layer_a(comp), "ADBE Channel Combiner", p2=0, p5=COMBINER_FROM, p6=1, p7=0, p8=0)


@case("channel_combiner_to", frames=frames(len(COMBINER_TO)))
def _(comp):
    effect(layer_a(comp), "ADBE Channel Combiner", p2=0, p5=14, p6=COMBINER_TO, p7=0, p8=0)


@case("channel_combiner_options", frames=frames(4))
def _(comp):
    effect(layer_a(comp), "ADBE Channel Combiner", p2=0, p5=[7.0, 12.0, 5.0, 19.0], p6=[4.0, 13.0, 1.0, 6.0], p7=[1.0, 0.0, 1.0, 1.0], p8=[0.0, 1.0, 1.0, 0.0])


@case("channel_combiner_invert", frames=frames(6))
def _(comp):
    effect(layer_a(comp), "ADBE Channel Combiner", p2=0, p5=[1.0, 3.0, 5.0, 2.0, 4.0, 5.0], p6=1, p7=1, p8=[0.0, 0.0, 0.0, 0.0, 0.0, 1.0])


@case("channel_combiner_layer", frames=frames(2))
def _(comp):
    b = second(comp)
    fx = effect(layer_a(comp), "ADBE Channel Combiner", p2=1, p5=[14.0, 10.0], p6=[3.0, 4.0], p7=0, p8=0)
    set_layer_param(fx["ADBE Channel Combiner-0003"], b)


# --- Arithmetic -------------------------------------------------------------------

@case("channel_arithmetic", frames=frames(13))
def _(comp):
    effect(layer_a(comp), "ADBE Arithmetic", p1=menu(13), p2=100.0, p3=180.0, p4=40.0, p5=1)


@case("channel_arithmetic_wrap", frames=frames(13))
def _(comp):
    effect(layer_a(comp), "ADBE Arithmetic", p1=menu(13), p2=200.0, p3=60.0, p4=128.0, p5=0)


# --- Compound Arithmetic ----------------------------------------------------------

def compound(comp, **params):
    b = second(comp)
    fx = effect(layer_a(comp), "ADBE Compound Arithmetic", **params)
    set_layer_param(fx["ADBE Compound Arithmetic-0001"], b)


@case("channel_compound", frames=frames(15))
def _(comp):
    compound(comp, p2=menu(15), p3=1, p4=1, p5=1, p6=0.0)


@case("channel_compound_argb", frames=frames(15))
def _(comp):
    compound(comp, p2=menu(15), p3=2, p4=2, p5=0, p6=0.0)


@case("channel_compound_scale", frames=frames(15))
def _(comp):
    compound(comp, p2=menu(15), p3=1, p4=3, p5=1, p6=0.0)


@case("channel_compound_alpha", frames=frames(6))
def _(comp):
    compound(comp, p2=[2.0, 3.0, 4.0, 5.0, 9.0, 12.0], p3=3, p4=1, p5=1, p6=[0.0, 0.0, 0.0, 0.0, 40.0, 40.0])


# --- Blend ------------------------------------------------------------------------

def blend(comp, **params):
    b = second(comp)
    fx = effect(layer_a(comp), "ADBE Blend", **params)
    set_layer_param(fx["ADBE Blend-0001"], b)


@case("channel_blend", frames=frames(5))
def _(comp):
    blend(comp, p2=menu(5), p3=0.0, p4=1)


@case("channel_blend_stretch", frames=frames(5))
def _(comp):
    blend(comp, p2=menu(5), p3=0.4, p4=2)


# --- Calculations -----------------------------------------------------------------

CALC_MODES = menu(37, (3, 8, 14, 21, 25, 30, 35))


def calculations(comp, **params):
    b = second(comp)
    fx = effect(layer_a(comp), "ADBE Calculations", **params)
    set_layer_param(fx["ADBE Calculations-0006"], b)


@case("channel_calculations", frames=frames(len(CALC_MODES)), duration=2.0)
def _(comp):
    calculations(comp, p2=1, p3=0, p7=1, p8=1.0, p9=0, p10=1, p12=CALC_MODES, p13=0)


@case("channel_calculations_preserve", frames=frames(len(CALC_MODES)), duration=2.0)
def _(comp):
    calculations(comp, p2=1, p3=0, p7=1, p8=0.7, p9=0, p10=0, p12=CALC_MODES, p13=1)


@case("channel_calculations_channels", frames=frames(6))
def _(comp):
    calculations(
        comp,
        p2=menu(6),
        p3=[0.0, 1.0, 0.0, 1.0, 0.0, 1.0],
        p7=[6.0, 5.0, 4.0, 3.0, 2.0, 1.0],
        p8=0.6,
        p9=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        p10=1,
        p12=[1.0, 5.0, 11.0, 1.0, 22.0, 15.0],
        p13=0,
    )


# --- Solid Composite --------------------------------------------------------------

SOLID_MODES = menu(21, (2, 9, 12, 17))


@case("channel_solid_composite", frames=frames(len(SOLID_MODES)))
def _(comp):
    effect(layer_a(comp), "ADBE Solid Composite", p1=70.0, p2=[0.2, 0.6, 0.9, 1.0], p3=80.0, p4=SOLID_MODES)


@case("channel_solid_composite_normal", frames=frames(3))
def _(comp):
    effect(layer_a(comp), "ADBE Solid Composite", p1=[100.0, 40.0, 0.0], p2=[0.9, 0.3, 0.1, 1.0], p3=[50.0, 100.0, 100.0], p4=1)


# --- CC Composite -----------------------------------------------------------------

# Composite Original cannot be keyed: one CARD_B layer per mode, in a grid of 4 x 5 at whole-pixel positions.
CC_MODES = menu(41, (4, 10, 17, 25, 29, 34, 39))


def cc_grid(comp, modes, first):
    for n, mode in enumerate(modes):
        layer = comp.add(CARD_B)
        tr(layer, "ADBE Position").value = [50.0 + 100 * (n % 4), 40.0 + 80 * (n // 4), 0.0]
        first(layer)
        effect(layer, "CC Composite", p1=70.0 if first is set_alpha else 100.0, p2=mode, p3=n % 2 if first is set_alpha else 0)


def tint(layer):
    effect(layer, "ADBE Tint", p1=[0.1, 0.0, 0.4, 1.0], p2=[1.0, 0.9, 0.3, 1.0], p3=100.0)


def set_alpha(layer):
    effect(layer, "ADBE Set Channels", p2=3, p4=1, p6=2, p8=5, p9=1)


for part, modes in enumerate((CC_MODES[:20], CC_MODES[20:])):
    for name, first in (("", tint), ("_alpha", set_alpha)):

        @case(f"channel_cc_composite{name}_{part + 1}", width=400, height=400)
        def _(comp, modes=modes, first=first):
            cc_grid(comp, modes, first)


# --- Grow Bounds ------------------------------------------------------------------

@case("channel_grow_bounds", frames=frames(2), width=200, height=160)
def _(comp):
    """The card unscaled in a larger comp, its bounds grown (by 20, then 0) before a blur that does not repeat edges."""
    layer = layer_a(comp)
    tr(layer, "ADBE Position").value = [100.0, 80.0, 0.0]
    effect(layer, "ADBE GROW BOUNDS", p1=[20.0, 0.0])
    effect(layer, "ADBE Gaussian Blur 2", p1=6.0, p2=1, p3=0)


# --- Cineon Converter -------------------------------------------------------------

@case("channel_cineon", frames=frames(3))
def _(comp):
    effect(layer_a(comp), "ADBE Cineon Converter2", p1=menu(3), p2=95.0, p8=0.0, p4=685.0, p9=1.0, p6=1.7, p7=20.0)


@case("channel_cineon_custom", frames=frames(6))
def _(comp):
    effect(
        layer_a(comp),
        "ADBE Cineon Converter2",
        p1=[1.0, 2.0, 3.0, 2.0, 1.0, 2.0],
        p2=[50.0, 50.0, 50.0, 180.0, 180.0, 95.0],
        p8=[0.1, 0.1, 0.1, 0.0, 0.0, 0.2],
        p4=[800.0, 800.0, 800.0, 600.0, 600.0, 685.0],
        p9=[0.9, 0.9, 0.9, 1.0, 1.0, 0.8],
        p6=[1.0, 2.2, 1.0, 1.0, 0.6, 1.7],
        p7=[0.0, 50.0, 100.0, 0.0, 0.0, 150.0],
    )


# --- CC Overbrights, HDR Compander, HDR Highlight Compression ----------------------

@case("channel_overbrights", frames=frames(6))
def _(comp):
    effect(layer_a(comp), "CC Overbrights", p1=[1.0, 2.0, 3.0, 5.0, 6.0, 7.0], p2=[0.0, 1.0, 0.0, 1.0])


@case("channel_compander", frames=frames(4))
def _(comp):
    effect(layer_a(comp), "ADBE Compander", p1=[1.0, 2.0, 1.0, 2.0], p2=[2.0, 2.0, 0.5, 1.5], p3=[1.0, 1.0, 2.2, 0.6])


@case("channel_hdr_tonemap", frames=frames(2))
def _(comp):
    effect(layer_a(comp), "ADBE HDR ToneMap", p1=[50.0, 100.0])


#: Frames the pixel report accepts with a mean error of at most 1/255.
KNOWN = {
    "channel_combiner_to@11": "one cell's luminance is 174.501, which After Effects rounds down (it rounds 82.501 up, and "
    "every other cell to nearest); Hue Only turns that level into 6 levels of red",
}

suite.save()
manifest_path = REFS / suite.manifest_file
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["known"] = KNOWN
manifest_path.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
