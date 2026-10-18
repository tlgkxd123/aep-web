# Builds refs/fixtures/distort2.aep: the Distort effects of src/render/effects/distortExtra.ts on a card whose red
# rises along x and green along y (one-pixel solids of n/255, added) under a blue checker, in a comp with transparent
# margins. The ramps make every reference a map of where each pixel samples the card from; a card of one-pixel lines
# shows the resampling filters, and a narrower crop of the card which of the layer's dimensions a parameter follows.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_distort2.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BlendingMode, Suite, add_effect, install_effects, tr  # noqa: E402

EFFECTS = [
    "ADBE Spherize",
    "ADBE Ripple",
    "ADBE Magnify",
    "CC Lens",
    "CC Slant",
    "CC Tiler",
    "CC Split",
    "CC Split 2",
    "CC Bend It",
    "CC Bender",
    "CC Power Pin",
    "CC Griddler",
    "CC Ripple Pulse",
    "CC Flo Motion",
    "ADBE BEZMESH",
    "ADBE WRPMESH",
    "CC Page Turn",
]
suite = Suite("distort2")
install_effects(suite, EFFECTS)
case = suite.case
folder = suite.folder

CW, CH, CELL = 120, 90, 10


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


def ramp(i, n):
    return round(255 * (i + 0.5) / n) / 255


def make_card():
    inner = folder.add_comp("distort2_card_src", CW, CH, 1.0, 1.0, 24.0)
    for x in range(CW):
        s = inner.add_solid([ramp(x, CW), 0.0, 0.0], f"r{x}", 1, CH)
        tr(s, "ADBE Position").value = [x + 0.5, CH / 2, 0.0]
    for y in range(CH):
        s = inner.add_solid([0.0, ramp(y, CH), 0.0], f"g{y}", CW, 1)
        tr(s, "ADBE Position").value = [CW / 2, y + 0.5, 0.0]
        s.blending_mode = BlendingMode.ADD
    for j in range(CH // CELL):
        for i in range(CW // CELL):
            if (i + j) % 2:
                continue
            s = inner.add_solid([0.0, 0.0, 0.8], f"b{i}_{j}", CELL, CELL)
            tr(s, "ADBE Position").value = [i * CELL + CELL / 2, j * CELL + CELL / 2, 0.0]
            s.blending_mode = BlendingMode.ADD
    return inner


def make_lines():
    inner = folder.add_comp("distort2_lines_src", CW, CH, 1.0, 1.0, 24.0)
    inner.add_solid([0.1, 0.1, 0.3], "ground", CW, CH)
    for x in range(3, CW, 9):
        s = inner.add_solid([1.0, 1.0, 1.0], f"v{x}", 1, CH)
        tr(s, "ADBE Position").value = [x + 0.5, CH / 2, 0.0]
    for y in range(4, CH, 11):
        s = inner.add_solid([1.0, 0.6, 0.0], f"h{y}", CW, 1)
        tr(s, "ADBE Position").value = [CW / 2, y + 0.5, 0.0]
    return inner


def make_narrow():
    inner = folder.add_comp("distort2_narrow_src", 60, CH, 1.0, 1.0, 24.0)
    layer = inner.add(CARD)
    tr(layer, "ADBE Position").value = [30.0, CH / 2, 0.0]
    return inner


CARD = make_card()
LINES = make_lines()
NARROW = make_narrow()


def on_card(comp):
    return comp.add(CARD)


def on_lines(comp):
    return comp.add(LINES)


def on_narrow(comp):
    return comp.add(NARROW)


def frames(n):
    return tuple(range(n))


C = [CW / 2, CH / 2]


@case("distort2_card")
def _(comp):
    on_card(comp)


@case("distort2_spherize", frames=frames(3))
def _(comp):
    effect(on_card(comp), "ADBE Spherize", p1=[30.0, 45.0, 70.0], p2=[C, [45.0, 35.0], [70.0, 50.0]])


@case("distort2_ripple_asym", frames=frames(2))
def _(comp):
    effect(on_card(comp), "ADBE Ripple", p1=[50.0, 80.0], p2=[C, [50.0, 40.0]], p3=1, p4=0.0, p5=[20.0, 12.0], p6=[40.0, 100.0], p7=[0.0, 90.0])


@case("distort2_ripple_sym", frames=(0, 5))
def _(comp):
    effect(on_card(comp), "ADBE Ripple", p1=60.0, p2=C, p3=2, p4=1.0, p5=18.0, p6=60.0, p7=0.0)


@case("distort2_magnify_circle", frames=frames(2))
def _(comp):
    effect(on_card(comp), "ADBE Magnify", p10=1, p1=[C, [40.0, 35.0]], p3=[200.0, 350.0], p11=1, p2=[30.0, 45.0], p4=0.0, p5=100.0, p8=1, p12=2, p9=0)


@case("distort2_magnify_square", frames=frames(2))
def _(comp):
    effect(on_card(comp), "ADBE Magnify", p10=2, p1=[[55.0, 40.0], [70.0, 50.0]], p3=250.0, p11=1, p2=35.0, p4=[0.0, 12.0], p5=[100.0, 70.0], p8=1, p12=2, p9=0)


@case("distort2_magnify_resize", frames=frames(1))
def _(comp):
    effect(on_card(comp), "ADBE Magnify", p10=1, p1=[100.0, 20.0], p3=200.0, p11=1, p2=40.0, p4=0.0, p5=100.0, p8=1, p12=2, p9=1)


@case("distort2_magnify_soft", frames=frames(1))
def _(comp):
    effect(on_card(comp), "ADBE Magnify", p10=1, p1=C, p3=300.0, p11=1, p2=40.0, p4=0.0, p5=100.0, p8=2, p12=2, p9=0)


@case("distort2_lens", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Lens", p1=[C, [50.0, 40.0], C], p2=[40.0, 60.0, 30.0], p3=[100.0, 50.0, -80.0])


@case("distort2_slant", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Slant", p1=[20.0, -35.0, 50.0], p2=[1, 0, 1], p3=[100.0, 80.0, 60.0], p4=[[60.0, 90.0], [60.0, 70.0], [40.0, 90.0]], p5=0)


@case("distort2_slant_color", frames=frames(1))
def _(comp):
    effect(on_card(comp), "CC Slant", p1=30.0, p2=1, p3=100.0, p4=[60.0, 90.0], p5=1, p6=[0.9, 0.2, 0.2, 1.0])


@case("distort2_tiler", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Tiler", p1=[0.5, 0.3, 0.75], p2=[C, [50.0, 30.0], [70.0, 60.0]], p3=[0.0, 0.4, 0.0])


@case("distort2_split", frames=frames(2))
def _(comp):
    effect(on_card(comp), "CC Split", p1=[[30.0, 45.0], [40.0, 20.0]], p2=[[90.0, 45.0], [80.0, 70.0]], p3=[20.0, 45.0])


@case("distort2_split2", frames=frames(2))
def _(comp):
    effect(on_card(comp), "CC Split 2", p1=[[30.0, 45.0], [40.0, 20.0]], p2=[[90.0, 45.0], [80.0, 70.0]], p3=[20.0, 0.0], p4=[40.0, 30.0])


@case("distort2_bendit", frames=frames(4))
def _(comp):
    effect(on_card(comp), "CC Bend It", p1=[40.0, -70.0, 40.0, 40.0], p2=[[60.0, 70.0], [50.0, 80.0], [60.0, 70.0], [60.0, 70.0]], p3=[[60.0, 20.0], [70.0, 10.0], [60.0, 20.0], [60.0, 20.0]], p4=[3, 3, 1, 4], p5=1)


@case("distort2_bendit_extended", frames=frames(1))
def _(comp):
    effect(on_card(comp), "CC Bend It", p1=60.0, p2=[60.0, 70.0], p3=[60.0, 20.0], p4=2, p5=2)


@case("distort2_bender", frames=frames(4))
def _(comp):
    effect(on_card(comp), "CC Bender", p1=[40.0, -50.0, 40.0, 60.0], p2=[1, 2, 3, 4], p3=0, p4=[60.0, 10.0], p5=[60.0, 85.0])


@case("distort2_bender_adjust", frames=frames(1))
def _(comp):
    effect(on_card(comp), "CC Bender", p1=50.0, p2=1, p3=1, p4=[40.0, 20.0], p5=[70.0, 80.0])


@case("distort2_powerpin", frames=frames(3))
def _(comp):
    effect(
        on_card(comp),
        "CC Power Pin",
        p2=[[10.0, 5.0], [0.0, 0.0], [-10.0, -5.0]],
        p3=[[110.0, 15.0], [120.0, 20.0], [130.0, 0.0]],
        p4=[[0.0, 90.0], [20.0, 80.0], [10.0, 95.0]],
        p5=[[125.0, 80.0], [100.0, 90.0], [115.0, 100.0]],
        p6=[1.0, 0.0, 1.0],
        p7=0,
        p9=[0.0, 0.0, 10.0],
        p10=[0.0, 0.0, 5.0],
        p11=[0.0, 0.0, -10.0],
        p12=[0.0, 0.0, 20.0],
    )


@case("distort2_griddler", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Griddler", p1=[50.0, 80.0, 120.0], p2=[50.0, 130.0, 70.0], p3=[15.0, 20.0, 12.0], p4=[0.0, 25.0, -40.0], p5=[1, 1, 0])


@case("distort2_ripple_pulse", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Ripple Pulse", p1=[C, C, [40.0, 30.0]], p2=[100.0, 300.0, 600.0], p3=[1.0, 2.0, 1.0], p4=[100.0, 200.0, -150.0], p5=0)


@case("distort2_flo_motion", frames=frames(3))
def _(comp):
    effect(
        on_card(comp),
        "CC Flo Motion",
        p1=0,
        p2=[[30.0, 25.0], [30.0, 25.0], [60.0, 45.0]],
        p3=[60.0, -80.0, 40.0],
        p4=[[90.0, 65.0], [90.0, 65.0], [100.0, 20.0]],
        p5=[0.0, 50.0, -60.0],
        p6=[1, 0, 1],
        p7=2,
        p8=[1.0, 2.0, 0.5],
    )


@case("distort2_bezier_warp", frames=frames(2))
def _(comp):
    effect(
        on_card(comp),
        "ADBE BEZMESH",
        p1=[[10.0, 5.0], [0.0, 0.0]],
        p2=[[40.0, -15.0], [40.0, 20.0]],
        p3=[[80.0, 10.0], [80.0, -20.0]],
        p4=[[115.0, 0.0], [120.0, 0.0]],
        p5=[[130.0, 30.0], [100.0, 30.0]],
        p6=[[120.0, 60.0], [140.0, 60.0]],
        p7=[[120.0, 90.0], [120.0, 90.0]],
        p8=[[80.0, 100.0], [80.0, 70.0]],
        p9=[[40.0, 80.0], [40.0, 110.0]],
        p10=[[0.0, 85.0], [0.0, 90.0]],
        p11=[[-10.0, 60.0], [20.0, 60.0]],
        p12=[[10.0, 30.0], [-20.0, 30.0]],
        p14=8,
    )


@case("distort2_warp_styles", frames=frames(15))
def _(comp):
    effect(on_card(comp), "ADBE WRPMESH", p1=list(range(1, 16)), p2=1, p3=50.0, p4=0.0, p5=0.0)


@case("distort2_warp_vertical", frames=frames(3))
def _(comp):
    effect(on_card(comp), "ADBE WRPMESH", p1=[1, 8, 12], p2=2, p3=[-40.0, 60.0, 30.0], p4=[30.0, 0.0, -20.0], p5=[-20.0, 25.0, 0.0])


@case("distort2_lines")
def _(comp):
    on_lines(comp)


@case("distort2_narrow")
def _(comp):
    on_narrow(comp)


@case("distort2_ripple_narrow", frames=frames(2))
def _(comp):
    effect(on_narrow(comp), "ADBE Ripple", p1=[50.0, 30.0], p2=[30.0, 45.0], p3=1, p4=0.0, p5=[20.0, 10.0], p6=[40.0, 30.0], p7=0.0)


@case("distort2_lens_narrow", frames=frames(1))
def _(comp):
    effect(on_narrow(comp), "CC Lens", p1=[30.0, 45.0], p2=60.0, p3=80.0)


@case("distort2_magnify_feather", frames=frames(4))
def _(comp):
    effect(on_card(comp), "ADBE Magnify", p10=[1, 2, 1, 2], p1=[[130.0, 45.0], [130.0, 45.0], [60.0, 45.0], [60.0, 45.0]], p3=200.0, p11=1, p2=30.0, p4=15.0, p5=100.0, p8=1, p12=[2, 2, 1, 1], p9=0)


@case("distort2_split_sweep", frames=frames(4))
def _(comp):
    effect(on_card(comp), "CC Split", p1=[30.0, 45.0], p2=[90.0, 45.0], p3=[10.0, 40.0, 80.0, 160.0])


@case("distort2_split_short", frames=frames(2))
def _(comp):
    effect(on_card(comp), "CC Split", p1=[40.0, 30.0], p2=[80.0, 30.0], p3=[20.0, 60.0])


@case("distort2_slant_lines", frames=frames(2))
def _(comp):
    effect(on_lines(comp), "CC Slant", p1=[20.0, 50.0], p2=1, p3=[100.0, 70.0], p4=[60.0, 90.0], p5=0)


@case("distort2_tiler_lines", frames=frames(1))
def _(comp):
    effect(on_lines(comp), "CC Tiler", p1=0.6, p2=C, p3=0.0)


@case("distort2_powerpin_lines", frames=frames(2))
def _(comp):
    effect(
        on_lines(comp),
        "CC Power Pin",
        p2=[0.0, 0.0],
        p3=[[120.0, 20.0], [120.0, 0.0]],
        p4=[[20.0, 80.0], [0.0, 90.0]],
        p5=[[100.0, 90.0], [60.0, 90.0]],
        p6=[0.0, 0.0],
        p7=0,
    )


@case("distort2_griddler_plain", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Griddler", p1=100.0, p2=100.0, p3=[20.0, 20.0, 40.0], p4=0.0, p5=[1, 0, 1])


@case("distort2_griddler_narrow", frames=frames(2))
def _(comp):
    effect(on_narrow(comp), "CC Griddler", p1=[100.0, 60.0], p2=[100.0, 60.0], p3=20.0, p4=0.0, p5=1)


@case("distort2_bender_below", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Bender", p1=40.0, p2=[1, 4, 2], p3=0, p4=[60.0, 10.0], p5=[60.0, 50.0])


@case("distort2_bender_adjust_styles", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Bender", p1=[60.0, -40.0, 50.0], p2=[2, 3, 4], p3=1, p4=[60.0, 5.0], p5=[60.0, 85.0])


@case("distort2_flo_single", frames=frames(3))
def _(comp):
    effect(on_card(comp), "CC Flo Motion", p1=0, p2=[60.0, 45.0], p3=[40.0, -40.0, 40.0], p4=[100.0, 80.0], p5=0.0, p6=0, p7=3, p8=[1.0, 1.0, 3.0])


@case("distort2_page_turn", frames=frames(2))
def _(comp):
    effect(on_card(comp), "CC Page Turn", p8=1, p1=[[80.0, 40.0], [60.0, 60.0]], p2=[-60.0, 30.0], p3=[20.0, 35.0], p4=[-60.0, 0.0], p7=1, p9=85.0, p6=[0.77, 0.77, 0.7, 1.0])


# Comps of effects distortExtra.ts does not render yet: built into the project, left out of the manifest.
PENDING = {
    "distort2_ripple_pulse",
    "distort2_flo_motion",
    "distort2_flo_single",
    "distort2_bendit",
    "distort2_bendit_extended",
    "distort2_warp_styles",
    "distort2_warp_vertical",
    "distort2_page_turn",
}
suite.manifest = [c for c in suite.manifest if c["comp"] not in PENDING]
suite.save()
