# Builds refs/fixtures/color2.aep: the Color Correction effects of
# src/render/effects/colorExtra.ts on a textured card and on an alpha-edged star,
# with every parameter each case depends on set. Each comp shows one setting per
# frame: a copy of the content per setting, visible on its frame alone (several of
# these effects' parameters cannot be keyed), so a comp renders in one aerender run.
#
# With --probe it builds refs/fixtures/color2.probe.aep instead: one comp sweeping
# every effect over a grid of 256 colours, rendered as an approximation list (no pixel
# gate) to read After Effects' formulas from (scripts/check-color2-probe.ts).
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_color2.py [--probe]
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import aepfix  # noqa: E402
from aepfix import BG, ORANGE, TEAL, Suite, add, add_effect, fill, install_effects, shape_group, stroke, tr  # noqa: E402
from py_aep.binary.mutations import clone_chunk_tree  # noqa: E402

EFFECTS = [
    "ADBE Color Balance 2",
    "ADBE Gamma/Pedestal/Gain2",
    "ADBE Pro Levels2",
    "ADBE PhotoFilterPS",
    "ADBE Change Color",
    "ADBE Change To Color",
    "ADBE Leave Color",
    "CC Toner",
    "CC Color Offset",
    "ADBE Broadcast Colors",
    "ADBE SelectiveColor",
    "APC Colorama",
    "ADBE CurvesCustom",
    "ADBE PS Arbitrary Map",
    "CS Color Neutralizer",
    "CS Kernel",
]

_donor_parse = aepfix._donor_definitions
_donor_cache: dict = {}


def _donor_definitions(path, wanted):
    """aepfix's, parsing each donor once for all the effects (the donor project is large)."""
    if path not in _donor_cache:
        _donor_cache[path] = _donor_parse(path, set(EFFECTS))
    return {k: clone_chunk_tree(v) for k, v in _donor_cache[path].items() if k in wanted}


aepfix._donor_definitions = _donor_definitions

PROBE = "--probe" in sys.argv
suite = Suite("color2", "color2.probe.aep", "color2.probe.approximations.json") if PROBE else Suite("color2")
install_effects(suite, EFFECTS)
case = suite.case
folder = suite.folder
FPS = 24.0

CELL_COLORS = [
    [0.95, 0.85, 0.2], [0.1, 0.2, 0.6], [0.85, 0.2, 0.25], [0.2, 0.75, 0.35],
    [0.6, 0.3, 0.8], [1.0, 1.0, 1.0], [0.05, 0.05, 0.05], [0.95, 0.55, 0.1],
    [0.3, 0.85, 0.9], [0.5, 0.5, 0.5], [0.9, 0.4, 0.7], [0.15, 0.45, 0.3],
    [0.75, 0.75, 0.7], [0.25, 0.25, 0.3], [0.4, 0.1, 0.05], [0.6, 0.9, 0.5],
]


def grid(name, colors, cols, cell, duration=10.0, opacities=None):
    """A precomp of solids, one cell per colour, row by row (each at its opacity, percent, when given)."""
    rows = (len(colors) + cols - 1) // cols
    inner = folder.add_comp(name, cols * cell, rows * cell, 1.0, duration, FPS)
    for k, c in enumerate(colors):
        i, j = k % cols, k // cols
        s = inner.add_solid(c, f"c{i}_{j}", cell, cell)
        tr(s, "ADBE Position").value = [i * cell + cell / 2, j * cell + cell / 2, 0.0]
        if opacities:
            tr(s, "ADBE Opacity").value = opacities[k % len(opacities)]
    return inner


def set_arbitrary(fx, index, data: bytes):
    """Replaces the arbitrary data (aRbp) of an effect parameter in the instance."""
    name = f"{fx.match_name}-{index:04d}"
    chunks = fx._tdgp.chunks

    def find(cs):
        for c in cs:
            if getattr(c, "chunk_type", "") == "aRbp":
                return c
            found = find(getattr(c, "chunks", None) or [])
            if found is not None:
                return found
        return None

    for k, c in enumerate(chunks):
        if getattr(c, "chunk_type", "") == "tdmn" and c.value == name:
            end = next((j for j in range(k + 1, len(chunks)) if getattr(chunks[j], "chunk_type", "") == "tdmn"), len(chunks))
            arbp = find(chunks[k + 1 : end])
            if arbp is None:
                raise KeyError(f"{name} holds no arbitrary data")
            assert len(arbp.data) == len(data), (len(arbp.data), len(data))
            arbp.data = data
            return
    raise KeyError(name)


def curves_data(luts, points):
    """Curves' arbitrary data: a header, five 256-entry tables, then five records of up to 16 points (x, y as
    big-endian u16), their count and the selected point (-1)."""
    out = bytearray(b"\x00\x01\x00\x01")
    for lut in luts:
        out += bytes(lut)
    for pts in points:
        pts = pts or [(0, 0), (255, 255)]
        rec = bytearray(64)
        for k, (x, y) in enumerate(pts):
            rec[4 * k : 4 * k + 4] = struct.pack(">HH", x, y)
        out += rec + struct.pack(">Ii", len(pts), -1)
    return bytes(out)


def colorama_cycle(entries):
    """Colorama's output cycle data: 64 entries of (place in 65536ths as a big-endian u32, then A, R, G, B bytes),
    the count, and four zero bytes."""
    out = bytearray(512)
    for k, (at, r, g, b) in enumerate(entries):
        out[8 * k : 8 * k + 8] = struct.pack(">I", round(at * 65536)) + bytes([255, r, g, b])
    return bytes(out + struct.pack(">I", len(entries)) + bytes(4))


def apply(layer, match_name, params):
    """add_effect with every parameter of `params` (p<index>, or "data<index>" for arbitrary data) set."""
    fx = add_effect(layer, match_name)
    for key, value in params.items():
        if key.startswith("data"):
            set_arbitrary(fx, int(key[4:]), value)
        else:
            fx[f"{match_name}-{int(key[1:]):04d}"].value = value
    return fx


def per_frame(**lists):
    """Settings from per-frame lists of number values (a scalar holds on every frame)."""
    n = max(len(v) for v in lists.values() if isinstance(v, list))
    return [{k: v[i] if isinstance(v, list) else v for k, v in lists.items()} for i in range(n)]


def staged(comp, content, settings):
    """One copy of `content(comp)` per (match name, params) setting, the k-th visible on frame k alone."""
    for k, (match_name, params) in enumerate(settings):
        layer = content(comp)
        layer.in_point = k / FPS
        layer.out_point = (k + 1) / FPS
        if match_name:
            apply(layer, match_name, params)


def staged_case(name, content, settings, width=160, height=120, background=True):
    n = len(settings)

    @case(name, frames=tuple(range(n)), width=width, height=height, duration=max(1.0, n / FPS))
    def _(comp):
        if background:
            comp.add_solid(BG, "bg")
        staged(comp, content, settings)


if PROBE:
    seed = 12345

    def rand():
        global seed
        seed = (seed * 1103515245 + 12345) % (1 << 31)
        return (seed >> 8) % 256

    primaries = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255], [255, 0, 255], [255, 255, 0], [255, 255, 255], [0, 0, 0]]
    lattice = primaries + [[rand(), rand(), rand()] for _ in range(192 - len(primaries))]
    greys = [[round(k * 255 / 63)] * 3 for k in range(64)]
    CELLS = grid("color2_probe_cells", [[v / 255 for v in c] for c in lattice + greys], 16, 8)
    PROBES = [(None, {})]

    def probe(match_name, base, settings):
        PROBES.extend((match_name, {**base, **s}) for s in settings)

    z10 = [0.0] * 10
    probe("ADBE Color Balance 2", {}, per_frame(
        p1=[60.0, -60.0, 0, 0, 0, 0, 0, 30.0, 30.0, 0],
        p2=[0, 0, 0, 0, 0, 0, 100.0, -40.0, -40.0, 0],
        p3=z10,
        p4=[0, 0, 60.0, -60.0, 0, 0, 0, 50.0, 50.0, 0],
        p5=z10,
        p6=[0, 0, 0, 0, 0, 0, 0, -70.0, -70.0, 30.0],
        p7=[0, 0, 0, 0, 60.0, -60.0, 0, 20.0, 20.0, 0],
        p8=z10,
        p9=[0, 0, 0, 0, 0, 0, 0, 80.0, 80.0, 0],
        p10=[0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    ))
    probe("ADBE Gamma/Pedestal/Gain2", {"p5": 1.0, "p6": 0.0, "p7": 1.0, "p8": 1.0, "p9": 0.0, "p10": 1.0}, per_frame(
        p1=[1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 4.0, 1.0, 3.0],
        p2=[2.0, 0.5, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.5, 0.7],
        p3=[0, 0, 0.2, -0.2, 0, 0, 0, 0, 0.1, 0],
        p4=[1.0, 1.0, 1.0, 1.0, 0.6, 1.5, 1.0, 1.0, 0.8, 1.0],
    ))
    probe("ADBE Pro Levels2", {"p1": 1, "p12": 1.0, "p14": 0.0, "p15": 1.0, "p18": 0.0, "p19": 1.0, "p20": 1.0, "p21": 0.0, "p32": 0.0, "p33": 1.0, "p34": 1.0, "p35": 0.0}, per_frame(
        p4=[0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        p5=[0.8, 1, 1, 1, 1, 0.7, 1, 1, 1, 1],
        p6=[1.0, 2.0, 0.5, 1.0, 0.5, 1.0, 1.0, 1.0, 1.0, 1.0],
        p7=[0, 0, 0, 0.2, 0, 0, 0, 0, -0.2, 0],
        p8=[1, 1, 1, 0.7, 1, 1, 1, 1, 1.2, 1],
        p11=[0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0],
        p13=[1.0, 1.0, 1.0, 1.0, 2.0, 1.0, 1.0, 1.0, 1.0, 1.0],
        p22=[1, 1, 1, 1, 1, 1, 0.5, 1, 1, 1],
        p25=[0, 0, 0, 0, 0, 0, 0, 0.1, 0, 0],
        p26=[1, 1, 1, 1, 1, 1, 1, 0.6, 1, 1],
        p27=[1, 1, 1, 1, 1, 1, 1, 1.3, 1, 1],
        p28=[0, 0, 0, 0, 0, 0, 0, 0.2, 0, 0],
        p29=[1, 1, 1, 1, 1, 1, 1, 0.9, 1, 1],
        p36=[1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5],
        p38=[3, 3, 3, 3, 3, 3, 3, 3, 2, 3],
        p39=[3, 3, 3, 3, 3, 3, 3, 3, 2, 3],
    ))
    blue = [0.2, 0.5, 1.0, 1.0]
    probe("ADBE PhotoFilterPS", {}, [
        {"p1": 1, "p2": blue, "p3": 25.0, "p4": 1},
        {"p1": 1, "p2": blue, "p3": 25.0, "p4": 0},
        {"p1": 22, "p2": blue, "p3": 60.0, "p4": 1},
        {"p1": 22, "p2": blue, "p3": 60.0, "p4": 0},
        {"p1": 22, "p2": [1.0, 0.0, 0.0, 1.0], "p3": 100.0, "p4": 0},
        {"p1": 22, "p2": [1.0, 0.0, 0.0, 1.0], "p3": 100.0, "p4": 1},
        {"p1": 17, "p2": blue, "p3": 50.0, "p4": 1},
        {"p1": 20, "p2": blue, "p3": 40.0, "p4": 1},
        {"p1": 15, "p2": blue, "p3": 70.0, "p4": 0},
    ])
    probe("ADBE Change Color", {"p5": [0.8, 0.2, 0.2, 1.0], "p6": 30.0}, per_frame(
        p1=[2, 2, 2, 2, 1, 1, 1, 2],
        p2=[0, 0, 0, 0, 90.0, 0, -45.0, 0],
        p3=[0, 0, 0, 0, 0, 40.0, 0, 0],
        p4=[0, 0, 0, 0, 0, -50.0, 60.0, 0],
        p7=[0, 20.0, 0, 0, 10.0, 10.0, 10.0, 0],
        p8=[1, 1, 2, 3, 1, 1, 3, 1],
        p9=[0, 0, 0, 0, 0, 0, 0, 1],
    ))
    probe("ADBE Change To Color", {"p1": [0.8, 0.2, 0.2, 1.0], "p2": [0.1, 0.3, 0.9, 1.0]}, per_frame(
        p3=[1, 1, 1, 1, 4, 1, 4, 2, 3],
        p4=[1, 1, 1, 1, 1, 2, 2, 1, 1],
        p5=[0.1, 0.1, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
        p6=[1.0, 1.0, 0.3, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
        p7=[1.0, 1.0, 0.3, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
        p8=[0.5, 0.0, 0.3, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        p9=[1, 1, 1, 0, 0, 0, 0, 0, 0],
    ))
    red = [0.8, 0.2, 0.2, 1.0]
    probe("ADBE Leave Color", {}, [
        {"p1": 100.0, "p2": red, "p3": 15.0, "p4": 0.0, "p5": 1},
        {"p1": 100.0, "p2": red, "p3": 40.0, "p4": 0.0, "p5": 1},
        {"p1": 100.0, "p2": red, "p3": 15.0, "p4": 30.0, "p5": 1},
        {"p1": 100.0, "p2": red, "p3": 20.0, "p4": 10.0, "p5": 2},
        {"p1": 50.0, "p2": red, "p3": 30.0, "p4": 0.0, "p5": 1},
        {"p1": 100.0, "p2": [0.3, 0.8, 0.3, 1.0], "p3": 30.0, "p4": 0.0, "p5": 2},
    ])
    probe("CC Toner", {"p1": [1.0, 0.95, 0.6, 1.0], "p6": [0.9, 0.5, 0.3, 1.0], "p2": [0.8, 0.1, 0.3, 1.0], "p7": [0.1, 0.4, 0.2, 1.0], "p3": [0.0, 0.05, 0.3, 1.0]}, [
        {"p5": 1, "p4": 0.0}, {"p5": 2, "p4": 0.0}, {"p5": 3, "p4": 0.0}, {"p5": 5, "p4": 0.0}, {"p5": 2, "p4": 0.5},
    ])
    probe("CC Color Offset", {}, per_frame(
        p1=[90.0, 90.0, 90.0, 90.0, 45.0, -120.0],
        p2=[0, 180.0, 180.0, 180.0, 0, 0],
        p3=[0, 270.0, 270.0, 270.0, 0, 0],
        p4=[1, 1, 2, 3, 2, 3],
    ))
    probe("ADBE Broadcast Colors", {}, per_frame(p1=[1, 1, 1, 1, 2, 1], p2=[1, 2, 4, 5, 1, 2], p3=[110.0, 110.0, 110.0, 110.0, 100.0, 90.0]))
    probe("ADBE SelectiveColor", {"p1": 1, "p2": 1, **{f"p{3 + 6 * g + k}": 0.0 for g in range(10) for k in range(4)}}, [
        {"p9": -50.0},
        {"p10": 50.0},
        {"p11": 50.0, "p12": 50.0},
        {"p1": 2, "p9": -50.0},
        {"p48": 40.0},
        {"p51": 30.0, "p52": -30.0},
        {"p59": 50.0},
        {"p15": 30.0, "p22": -40.0, "p29": 40.0, "p33": 25.0, "p42": -30.0},
        {"p1": 2, "p15": 30.0, "p22": -40.0, "p29": 40.0, "p33": 25.0, "p42": -30.0},
        {"p3": -60.0},
    ])
    probe("CS Color Neutralizer", {
        "p1": [0.0, 0.0, 0.0, 1.0], "p7": [0.498, 0.498, 0.498, 1.0], "p13": [1.0, 1.0, 1.0, 1.0],
        **{f"p{i}": 0.0 for i in (3, 4, 5, 9, 10, 11, 15, 16, 17, 19, 20, 23)}, "p22": 1, "p24": 100.0,
    }, [
        {"p1": [0.2, 0.1, 0.05, 1.0]},
        {"p7": [0.6, 0.5, 0.4, 1.0]},
        {"p13": [0.9, 0.95, 0.8, 1.0]},
        {"p3": 50.0},
        {"p10": -50.0},
        {"p17": 50.0},
        {"p7": [0.6, 0.5, 0.4, 1.0], "p19": 50.0},
        {"p23": 20.0, "p24": 80.0},
    ])
    probe("CS Kernel", {}, per_frame(
        p2=[1.0, -1.0, -1.0, 0, -2.0, -1.0],
        p3=[1.0, -1.0, -1.0, -1.0, -1.0, -1.0],
        p4=[1.0, -1.0, -1.0, 0, 0, -1.0],
        p7=[1.0, -1.0, -1.0, -1.0, -1.0, -1.0],
        p8=[1.0, 8.0, 8.0, 5.0, 1.0, 8.0],
        p9=[1.0, -1.0, -1.0, -1.0, 1.0, -1.0],
        p12=[1.0, -1.0, -1.0, 0, 0, -1.0],
        p13=[1.0, -1.0, -1.0, -1.0, 1.0, -1.0],
        p14=[1.0, -1.0, -1.0, 0, 2.0, -1.0],
        p16=[9.0, 1.0, 1.0, 1.0, 1.0, 1.0],
        p17=[0, 0, 1, 0, 0, 0],
        p18=[0, 0, 0, 0, 0, 50.0],
    ))
    identity = list(range(256))
    probe("ADBE CurvesCustom", {"p2": 1}, [
        {"data1": curves_data([[255 - v for v in identity], [v // 2 for v in identity], [min(255, v * 2) for v in identity], [255 - v // 2 for v in identity], [128 + v // 2 for v in identity]], [None] * 5)},
        {"data1": curves_data([identity] * 5, [[(0, 0), (64, 128), (192, 160), (255, 255)], None, None, None, None])},
    ])
    staged_case("color2_probe", lambda comp: comp.add(CELLS), PROBES, width=128, height=128, background=False)

    PROBES = [(None, {})]
    COLORAMA = {"p2": 1, "p6": 10, "p40": 1, "p8": 0.0, "p10": 1, "p38": 1.0, "p14": 1, "p16": 1, "p18": 1, "p34": 0, "p26": 1, "p30": 1, "p32": 1, "p36": 0.0}
    probe("APC Colorama", COLORAMA, [
        {},
        {"p2": 2},
        {"p8": 90.0},
        {"p38": 2.0},
        {"p14": 0},
        {"p2": 5},
        {"p2": 6},
        {"p2": 7},
        {"p2": 8},
        {"p16": 2},
        {"p16": 8},
        {"p10": 8},
        {"p10": 14},
        {"p10": 21},
        {"p36": 50.0},
        {"p26": 2, "p20": [0.8, 0.2, 0.2, 1.0], "p22": 0.3, "p24": 0.1},
        {"p6": 2, "p40": 1},
    ])
    probe("ADBE PhotoFilterPS", {"p2": blue, "p3": 100.0, "p4": 0}, [{"p1": k} for k in range(1, 21)])
    sliders = {f"p{k}": 0.0 for k in range(1, 10)}
    probe("ADBE Color Balance 2", {**sliders, "p10": 0}, [{f"p{k}": v} for k in range(1, 10) for v in (-100.0, -30.0, 30.0, 100.0)])
    probe("CC Color Offset", {"p2": 0.0, "p3": 0.0, "p4": 3}, [{"p1": v} for v in (0.0, 60.0, 180.0, 300.0)])
    staged_case("color2_probe2", lambda comp: comp.add(CELLS), PROBES, width=128, height=128, background=False)

    PROBES = [(None, {})]
    probe("ADBE Color Balance 2", {**sliders, "p10": 1}, [
        {"p1": 50.0}, {"p7": 50.0}, {"p4": 50.0, "p6": -30.0}, {"p4": 50.0, "p5": 20.0, "p6": -30.0},
        {"p1": 50.0, "p2": -30.0}, {"p7": 50.0, "p9": -30.0}, {"p1": 50.0, "p4": 50.0}, {"p4": 50.0, "p7": 50.0},
        {"p1": 30.0, "p7": -50.0}, {"p1": -50.0}, {"p7": -50.0, "p8": 30.0}, {"p3": 40.0, "p5": 40.0},
    ])
    staged_case("color2_probe3", lambda comp: comp.add(CELLS), PROBES, width=128, height=128, background=False)

    PROBES = [(None, {})]
    probe("CS Color Neutralizer", {
        "p1": [0.0, 0.0, 0.0, 1.0], "p7": [0.498, 0.498, 0.498, 1.0], "p13": [1.0, 1.0, 1.0, 1.0],
        **{f"p{i}": 0.0 for i in (3, 4, 5, 9, 10, 11, 15, 16, 17, 19, 20, 23)}, "p22": 1, "p24": 100.0,
    }, [
        {"p3": 50.0, "p19": 50.0}, {"p3": 50.0, "p19": 100.0}, {"p10": -50.0, "p19": 50.0}, {"p17": 50.0, "p19": 50.0},
        {"p3": 50.0, "p20": 50.0}, {"p3": 50.0, "p23": 20.0}, {"p3": 50.0, "p24": 80.0}, {"p17": 50.0, "p24": 80.0},
        {"p10": -50.0, "p23": 20.0, "p24": 80.0}, {"p3": 100.0}, {"p4": 30.0, "p5": -30.0},
    ])
    staged_case("color2_probe4", lambda comp: comp.add(CELLS), PROBES, width=128, height=128, background=False)

else:
    CARD = grid("color2_card", CELL_COLORS * 2, 8, 20)

    def star(comp):
        layer = comp.add_shape()
        g = shape_group(layer)
        add(g, "ADBE Vector Shape - Star", **{"ADBE Vector Star Points": 5.0, "ADBE Vector Star Outer Radius": 40.0, "ADBE Vector Star Inner Radius": 18.0})
        stroke(g, TEAL, 4.0)
        fill(g, ORANGE)
        return layer

    def card(comp):
        return comp.add(CARD)

    SOFT_CARD = grid("color2_card_soft", CELL_COLORS * 2, 8, 20, opacities=[100.0, 60.0, 30.0, 80.0, 0.0])

    def soft_card(comp):
        return comp.add(SOFT_CARD)

    def effect_case(name, match_name, base, on_card, on_star=(), on_soft=()):
        """color2_<name>: the card through each of `on_card`'s settings, the star through `on_star`'s, then the
        translucent card through `on_soft`'s."""
        n = len(on_card) + len(on_star) + len(on_soft)

        @case(f"color2_{name}", frames=tuple(range(n)), duration=max(1.0, n / FPS))
        def _(comp):
            comp.add_solid(BG, "bg")
            cases = [(card, s) for s in on_card] + [(star, s) for s in on_star] + [(soft_card, s) for s in on_soft]
            for k, (content, setting) in enumerate(cases):
                layer = content(comp)
                layer.in_point = k / FPS
                layer.out_point = (k + 1) / FPS
                apply(layer, match_name, {**base, **setting})

    BALANCE = {f"p{i}": 0.0 for i in range(1, 10)}
    effect_case("balance", "ADBE Color Balance 2", {**BALANCE, "p10": 0}, [
        {"p1": 30.0, "p2": -40.0, "p4": 50.0, "p6": -70.0, "p7": 20.0, "p9": 80.0},
        {"p1": 30.0, "p2": -40.0, "p4": 50.0, "p6": -70.0, "p7": 20.0, "p9": 80.0, "p10": 1},
        {"p3": 100.0, "p5": -100.0, "p8": 60.0},
    ], [{"p1": -50.0, "p5": 40.0, "p9": -60.0, "p10": 1}])

    effect_case("gpg", "ADBE Gamma/Pedestal/Gain2", {"p1": 1.0, "p2": 1.0, "p3": 0.0, "p4": 1.0, "p5": 1.0, "p6": 0.0, "p7": 1.0, "p8": 1.0, "p9": 0.0, "p10": 1.0}, [
        {"p2": 1.6, "p3": 0.1, "p4": 0.9, "p5": 0.6, "p7": 1.2, "p9": -0.1},
        {"p1": 2.5, "p5": 1.4, "p6": 0.05, "p8": 0.8, "p10": 0.7},
    ], [{"p1": 1.5, "p2": 0.7, "p6": 0.2, "p10": 1.3}])

    LEVELS = {"p1": 1, "p38": 3, "p39": 3}
    for base in (4, 11, 18, 25, 32):
        LEVELS.update({f"p{base}": 0.0, f"p{base + 1}": 1.0, f"p{base + 2}": 1.0, f"p{base + 3}": 0.0, f"p{base + 4}": 1.0})
    effect_case("levels", "ADBE Pro Levels2", LEVELS, [
        {"p4": 0.1, "p5": 0.85, "p6": 1.4, "p13": 0.7, "p15": 0.9, "p18": 0.2, "p27": 1.5, "p28": 0.1},
        {"p6": 0.6, "p7": 0.15, "p8": 0.9, "p11": 0.1, "p12": 0.9, "p22": 0.8, "p36": 0.6},
    ], [{"p5": 0.7, "p20": 2.0, "p32": 0.2, "p33": 0.8}])

    effect_case("photofilter", "ADBE PhotoFilterPS", {"p2": [0.2, 0.5, 1.0, 1.0]}, [
        {"p1": 1, "p3": 25.0, "p4": 1},
        {"p1": 22, "p2": [0.1, 0.8, 0.3, 1.0], "p3": 60.0, "p4": 0},
        {"p1": 17, "p3": 50.0, "p4": 1},
    ], [{"p1": 22, "p2": [0.9, 0.1, 0.6, 1.0], "p3": 70.0, "p4": 1}])

    effect_case("changecolor", "ADBE Change Color", {"p1": 1, "p2": 0.0, "p3": 0.0, "p4": 0.0, "p5": [0.85, 0.2, 0.25, 1.0], "p6": 30.0, "p7": 0.0, "p8": 1, "p9": 0}, [
        {"p2": 120.0, "p6": 40.0, "p7": 15.0},
        {"p2": -60.0, "p3": 30.0, "p4": -40.0, "p8": 3, "p7": 10.0},
        {"p1": 2, "p8": 2, "p6": 25.0, "p7": 20.0},
    ], [{"p5": [1.0, 0.5, 0.0, 1.0], "p2": 180.0, "p6": 20.0, "p7": 10.0}])

    effect_case("changetocolor", "ADBE Change To Color", {"p1": [0.85, 0.2, 0.25, 1.0], "p2": [0.2, 0.4, 0.9, 1.0], "p3": 1, "p4": 1, "p5": 0.1, "p6": 1.0, "p7": 1.0, "p8": 0.5, "p9": 0}, [
        {"p3": 4, "p5": 0.15, "p8": 0.3},
        {"p3": 1, "p4": 2, "p5": 0.2, "p8": 0.0},
        {"p9": 1, "p5": 0.12, "p6": 0.5, "p7": 0.6},
    ], [{"p1": [1.0, 0.5, 0.0, 1.0], "p2": [0.3, 0.9, 0.2, 1.0], "p3": 3}])

    effect_case("leavecolor", "ADBE Leave Color", {"p1": 100.0, "p2": [0.85, 0.2, 0.25, 1.0], "p3": 15.0, "p4": 0.0, "p5": 1}, [
        {"p3": 30.0, "p4": 20.0},
        {"p1": 70.0, "p2": [0.2, 0.75, 0.35, 1.0], "p3": 25.0, "p5": 2},
    ], [{"p2": [1.0, 0.5, 0.0, 1.0], "p3": 20.0, "p4": 10.0}])

    TONES = {"p1": [1.0, 0.95, 0.6, 1.0], "p6": [0.9, 0.5, 0.3, 1.0], "p2": [0.8, 0.1, 0.3, 1.0], "p7": [0.1, 0.4, 0.2, 1.0], "p3": [0.0, 0.05, 0.3, 1.0], "p4": 0.0}
    effect_case("toner", "CC Toner", TONES, [{"p5": 1}, {"p5": 2, "p4": 0.3}, {"p5": 3}, {"p5": 5}], [{"p5": 2}])

    effect_case("offset", "CC Color Offset", {"p1": 0.0, "p2": 0.0, "p3": 0.0, "p4": 1}, [
        {"p1": 90.0, "p2": 200.0, "p3": -45.0, "p4": 1},
        {"p1": 120.0, "p3": 60.0, "p4": 2},
        {"p2": 150.0, "p3": 300.0, "p4": 3},
    ], [{"p1": 60.0, "p2": 60.0, "p3": 60.0, "p4": 2}])

    SELECTIVE = {"p1": 1, "p2": 1, **{f"p{3 + 6 * g + k}": 0.0 for g in range(10) for k in range(4)}}
    effect_case("selective", "ADBE SelectiveColor", SELECTIVE, [
        {"p9": -40.0, "p10": 30.0, "p17": 50.0, "p28": -30.0, "p34": 40.0, "p48": 20.0},
        {"p1": 2, "p9": -40.0, "p10": 30.0, "p17": 50.0, "p28": -30.0, "p34": 40.0, "p48": 20.0},
        {"p51": 25.0, "p53": -20.0, "p60": 40.0, "p45": -30.0, "p21": 60.0},
    ], [{"p12": 50.0, "p18": -40.0, "p41": 30.0}])

    NEUTRAL = {"p1": [0.0, 0.0, 0.0, 1.0], "p7": [0.498, 0.498, 0.498, 1.0], "p13": [1.0, 1.0, 1.0, 1.0], **{f"p{i}": 0.0 for i in (3, 4, 5, 9, 10, 11, 15, 16, 17, 19, 20, 23)}, "p22": 1, "p24": 100.0}
    effect_case("neutralizer", "CS Color Neutralizer", NEUTRAL, [
        {"p3": 25.0, "p11": -30.0, "p16": 20.0},
        {"p3": 30.0, "p4": -20.0, "p10": -40.0, "p17": 25.0},
        {"p23": 10.0, "p24": 85.0, "p20": 30.0, "p9": 40.0, "p5": -30.0},
    ], [{"p10": 35.0, "p15": -25.0}])

    KERNEL = {"p2": 0.0, "p3": 0.0, "p4": 0.0, "p7": 0.0, "p8": 1.0, "p9": 0.0, "p12": 0.0, "p13": 0.0, "p14": 0.0, "p16": 1.0, "p17": 0, "p18": 0.0}
    effect_case("kernel", "CS Kernel", KERNEL, [
        {"p2": 1.0, "p3": 2.0, "p4": 1.0, "p7": 2.0, "p8": 4.0, "p9": 2.0, "p12": 1.0, "p13": 2.0, "p14": 1.0, "p16": 16.0},
        {"p3": -1.0, "p7": -1.0, "p8": 5.0, "p9": -1.0, "p13": -1.0},
        {"p2": -2.0, "p3": -1.0, "p7": -1.0, "p9": 1.0, "p13": 1.0, "p14": 2.0, "p17": 1, "p18": 30.0},
    ], [{"p2": 1.0, "p3": 2.0, "p4": 1.0, "p7": 2.0, "p8": 4.0, "p9": 2.0, "p12": 1.0, "p13": 2.0, "p14": 1.0, "p16": 16.0}],
        [{"p2": -1.0, "p3": -1.0, "p4": -1.0, "p7": -1.0, "p8": 8.0, "p9": -1.0, "p12": -1.0, "p13": -1.0, "p14": -1.0, "p17": 1},
         {"p2": -2.0, "p3": -1.0, "p7": -1.0, "p9": 1.0, "p13": 1.0, "p14": 2.0, "p17": 1, "p18": 30.0}])

    COLORAMA = {"p2": 1, "p6": 10, "p40": 1, "p8": 0.0, "p10": 1, "p38": 1.0, "p14": 1, "p16": 1, "p18": 1, "p34": 0, "p26": 1, "p30": 1, "p32": 1, "p36": 0.0}
    FIRE = colorama_cycle([(0.0, 20, 0, 40), (0.3, 200, 30, 0), (0.6, 255, 200, 0), (0.85, 255, 255, 220)])
    effect_case("colorama", "APC Colorama", COLORAMA, [
        {},
        {"p8": 120.0, "p38": 2.0},
        {"p2": 5, "data12": FIRE},
        {"p2": 6, "data12": FIRE, "p14": 0, "p36": 30.0},
        {"p16": 8, "p8": 60.0},
    ], [{"p2": 1, "data12": FIRE}])

    ramp = list(range(256))
    s_curve = [round(255 * (0.5 - 0.5 * __import__("math").cos(__import__("math").pi * v / 255))) for v in ramp]
    effect_case("curves", "ADBE CurvesCustom", {"p2": 1}, [
        {"data1": curves_data([s_curve, ramp, ramp, ramp, ramp], [[(0, 0), (64, 38), (192, 217), (255, 255)], None, None, None, None])},
        {"data1": curves_data([ramp, [min(255, v * 3 // 2) for v in ramp], ramp, [255 - v for v in ramp], ramp], [None, [(0, 0), (170, 255)], None, [(0, 255), (255, 0)], None])},
    ], [{"data1": curves_data([[v // 2 + 64 for v in ramp], ramp, ramp, ramp, ramp], [[(0, 64), (255, 191)], None, None, None, None])}])

#: Frames the pixel report accepts with a mean error of at most 1/255.
KNOWN = {
    "color2_toner@4": "the star's outer edge: the shared shape rasteriser places that anti-aliased edge differently "
    "from After Effects, and Toner's contrast against the background makes the coverage difference visible",
}

suite.save()
if not PROBE:
    manifest_path = aepfix.REFS / suite.manifest_file
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["known"] = KNOWN
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
