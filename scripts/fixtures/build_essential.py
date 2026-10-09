# Builds refs/fixtures/essential.aep: Exposure, Fast Box Blur, Unsharp Mask and Curves.
# Curves keeps its curves in arbitrary data (LIST:aRbs/aRbp) that py-aep cannot author,
# so the saved project is patched afterwards: each Curves instance, in file order,
# gets the next blob of CURVES.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_essential.py
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import REFS, Suite, add_mask, install_effects, rect, tr  # noqa: E402

from py_aep.enums.property import PropertyControlType  # noqa: E402

EFFECTS = ["ADBE Exposure2", "ADBE Box Blur2", "ADBE Unsharp Mask2", "ADBE CurvesCustom"]
KNOWN: dict[str, str] = {}

suite = Suite("essential")
install_effects(suite, EFFECTS)
case = suite.case
folder = suite.folder


def _leaves(group):
    for child in group.properties:
        if hasattr(child, "properties"):
            yield from _leaves(child)
        else:
            yield child


def effect(layer, match_name, **params):
    fx = layer["ADBE Effect Parade"].add_property(match_name)
    fx.enabled = True
    for leaf in _leaves(fx):
        if getattr(leaf, "_tdpi", None) is not None and not leaf.match_name.endswith("-0000"):
            leaf._tdpi.value = 0
        if leaf._property_control_type == PropertyControlType.ENUM and leaf.value == 0 and leaf.last_value:
            leaf.value = leaf.last_value
    for index, value in params.items():
        fx[f"{match_name}-{int(index[1:]):04d}"].value = value
    return fx


def param(fx, index):
    return fx[f"{fx.match_name}-{index:04d}"]


def keyed(prop, values, fps=24.0):
    for k, v in enumerate(values):
        prop.set_value_at_time(k / fps, v)


# --- Sources ------------------------------------------------------------------------


def block(comp, color, name, x, y, w, h):
    layer = comp.add_solid(list(color), name, w, h)
    tr(layer, "ADBE Position").value = [x + w / 2, y + h / 2, 0.0]
    return layer


def strips_source():
    """16 gray steps (top half), saturated patches, and white details on black (bottom)."""
    comp = folder.add_comp("essential_src_strips", 160, 120, 1.0, 1.0, 24.0)
    comp.add_solid([0.0, 0.0, 0.0], "black")
    for i in range(16):
        v = i / 15
        block(comp, [v, v, v], f"gray{i}", 10 * i, 0, 10, 60)
    colors = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 0], [1, 0.5, 0], [0.2, 0.6, 0.5]]
    for i, c in enumerate(colors):
        block(comp, c, f"patch{i}", 20 * i, 60, 20, 30)
    block(comp, [1, 1, 1], "square", 12, 98, 16, 16)
    block(comp, [1, 1, 1], "line_v", 50, 94, 2, 24)
    block(comp, [1, 1, 1], "line_h", 70, 104, 30, 1)
    block(comp, [0.9, 0.3, 0.1], "dot", 120, 102, 3, 3)
    return comp


def alpha_source():
    """Soft-edged and hard-edged shapes on transparency."""
    comp = folder.add_comp("essential_src_alpha", 160, 120, 1.0, 1.0, 24.0)
    soft = block(comp, [1.0, 0.6, 0.2], "soft", 20, 20, 60, 50)
    add_mask(soft, rect(0, 0, 60, 50), feather=12.0)
    block(comp, [0.2, 0.5, 1.0], "hard", 95, 30, 40, 60)
    half = block(comp, [1.0, 1.0, 1.0], "half", 40, 85, 40, 20)
    tr(half, "ADBE Opacity").value = 50.0
    return comp


STRIPS = strips_source()
ALPHA = alpha_source()


def fx_case(name, frames=(0,), src=None, bg=(0.2, 0.2, 0.2)):
    """A comp holding the source precomp (with a gray background); `build(layer)` adds the effects."""

    def wrap(build):
        @case(name, frames=frames)
        def _(comp):
            if bg is not None:
                comp.add_solid(list(bg), "bg")
            build(comp.add(src or STRIPS))

        return build

    return wrap


# --- Exposure -----------------------------------------------------------------------
# 1 Channels (Master, Individual), 3-5 Master exposure/offset/gamma, 8-10 red,
# 13-15 green, 18-20 blue, 22 Bypass Linear Light Conversion.


@fx_case("essential_exposure", frames=(0, 1, 2, 3, 4))
def _(layer):
    keyed(param(effect(layer, "ADBE Exposure2"), 3), [-2.0, -0.5, 0.4, 1.0, 2.5])


@fx_case("essential_exposure_offset", frames=(0, 1, 2))
def _(layer):
    keyed(param(effect(layer, "ADBE Exposure2"), 4), [-0.1, 0.05, 0.2])


@fx_case("essential_exposure_gamma", frames=(0, 1, 2))
def _(layer):
    keyed(param(effect(layer, "ADBE Exposure2"), 5), [0.5, 1.6, 3.0])


@fx_case("essential_exposure_bypass", frames=(0, 1))
def _(layer):
    keyed(param(effect(layer, "ADBE Exposure2", p22=1), 3), [-1.0, 1.0])


@fx_case("essential_exposure_combo")
def _(layer):
    effect(layer, "ADBE Exposure2", p3=0.7, p4=0.03, p5=1.4)


@fx_case("essential_exposure_indiv")
def _(layer):
    effect(layer, "ADBE Exposure2", p1=2, p8=1.0, p14=0.1, p20=2.0, p3=3.0)


@fx_case("essential_exposure_alpha", frames=(0, 1), src=ALPHA, bg=None)
def _(layer):
    keyed(param(effect(layer, "ADBE Exposure2", p4=0.05), 3), [1.0, -1.0])


# --- Fast Box Blur ------------------------------------------------------------------
# 1 Blur Radius, 2 Iterations, 3 Blur Dimensions (Both, Horizontal, Vertical), 4 Repeat Edge Pixels.


@fx_case("essential_box_radius", frames=(0, 1, 2, 3, 4))
def _(layer):
    keyed(param(effect(layer, "ADBE Box Blur2", p2=1, p3=1, p4=0), 1), [1.0, 2.5, 5.0, 12.0, 30.0])


for iterations in (2, 3, 5):

    @fx_case(f"essential_box_iter{iterations}", frames=(0, 1, 2))
    def _(layer, iterations=iterations):
        keyed(param(effect(layer, "ADBE Box Blur2", p2=iterations, p3=1, p4=0), 1), [1.5, 4.0, 10.0])


@fx_case("essential_box_horizontal")
def _(layer):
    effect(layer, "ADBE Box Blur2", p1=8.0, p2=2, p3=2, p4=0)


@fx_case("essential_box_vertical")
def _(layer):
    effect(layer, "ADBE Box Blur2", p1=8.0, p2=2, p3=3, p4=0)


@fx_case("essential_box_repeat", frames=(0, 1))
def _(layer):
    keyed(param(effect(layer, "ADBE Box Blur2", p2=3, p3=1, p4=1), 1), [4.0, 15.0])


@fx_case("essential_box_alpha", frames=(0, 1), src=ALPHA, bg=None)
def _(layer):
    keyed(param(effect(layer, "ADBE Box Blur2", p2=3, p3=1, p4=0), 1), [3.0, 9.0])


# --- Unsharp Mask -------------------------------------------------------------------
# 1 Amount (%), 2 Radius, 3 Threshold.


@fx_case("essential_unsharp_amount", frames=(0, 1, 2))
def _(layer):
    keyed(param(effect(layer, "ADBE Unsharp Mask2", p2=2.0, p3=0.0), 1), [50.0, 150.0, 400.0])


@fx_case("essential_unsharp_radius", frames=(0, 1, 2, 3))
def _(layer):
    keyed(param(effect(layer, "ADBE Unsharp Mask2", p1=100.0, p3=0.0), 2), [0.5, 1.5, 4.0, 10.0])


@fx_case("essential_unsharp_threshold", frames=(0, 1, 2, 3))
def _(layer):
    keyed(param(effect(layer, "ADBE Unsharp Mask2", p1=200.0, p2=3.0), 3), [0.0, 0.02, 0.08, 0.25])


@fx_case("essential_unsharp_alpha", src=ALPHA, bg=None)
def _(layer):
    effect(layer, "ADBE Unsharp Mask2", p1=150.0, p2=3.0, p3=0.0)


# --- Curves -------------------------------------------------------------------------
# aRbp: u16 version 1, u16 1, then 256-entry tables for RGB, Red, Green, Blue, Alpha,
# then per channel 16 (x, y) u16 points, i32 count, i32 selected point.

IDENTITY = [(0, 0), (255, 255)]


def spline_table(points):
    """A natural cubic spline through the points, clamped to 0..255."""
    xs = [float(p[0]) for p in points]
    ys = [float(p[1]) for p in points]
    n = len(points)
    if n == 2:
        return [max(0, min(255, round(ys[0] + (ys[1] - ys[0]) * (x - xs[0]) / (xs[1] - xs[0])))) for x in range(256)]
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    a = [0.0] * n
    b = [1.0] * n
    c = [0.0] * n
    d = [0.0] * n
    for i in range(1, n - 1):
        a[i], b[i], c[i] = h[i - 1], 2 * (h[i - 1] + h[i]), h[i]
        d[i] = 6 * ((ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1])
    for i in range(1, n):
        m = a[i] / b[i - 1]
        b[i] -= m * c[i - 1]
        d[i] -= m * d[i - 1]
    m2 = [0.0] * n
    for i in range(n - 1, -1, -1):
        m2[i] = (d[i] - c[i] * (m2[i + 1] if i + 1 < n else 0.0)) / b[i]
    out = []
    for x in range(256):
        k = max(0, min(n - 2, next((i for i in range(n - 1) if x <= xs[i + 1]), n - 2)))
        t = x - xs[k]
        hk = h[k]
        y = (
            m2[k] * (xs[k + 1] - x) ** 3 / (6 * hk)
            + m2[k + 1] * t**3 / (6 * hk)
            + (ys[k] / hk - m2[k] * hk / 6) * (xs[k + 1] - x)
            + (ys[k + 1] / hk - m2[k + 1] * hk / 6) * t
        )
        out.append(max(0, min(255, round(y))))
    return out


def curves_blob(rgb=IDENTITY, red=IDENTITY, green=IDENTITY, blue=IDENTITY, alpha=IDENTITY, tables=None):
    channels = [rgb, red, green, blue, alpha]
    tables = tables or [spline_table(p) for p in channels]
    out = bytearray(struct.pack(">HH", 1, 1))
    for table in tables:
        out += bytes(table)
    for points in channels:
        block_ = bytearray(64)
        for i, (x, y) in enumerate(points):
            struct.pack_into(">HH", block_, i * 4, x, y)
        out += block_ + struct.pack(">ii", len(points), -1)
    assert len(out) == 1644
    return bytes(out)


CURVES: list[bytes] = []


def curves_case(name, blob, src=None, bg=(0.2, 0.2, 0.2)):
    @fx_case(name, src=src, bg=bg)
    def _(layer):
        effect(layer, "ADBE CurvesCustom")
        CURVES.append(blob)


# A table that contradicts its points: shows whether AE renders the stored table or the points.
curves_case("essential_curves_table", curves_blob(tables=[[255 - x for x in range(256)]] + [list(range(256))] * 4))
curves_case("essential_curves_rgb", curves_blob(rgb=[(0, 0), (64, 128), (255, 255)]))
curves_case("essential_curves_s", curves_blob(rgb=[(0, 0), (60, 30), (128, 128), (190, 230), (255, 255)]))
curves_case(
    "essential_curves_channels",
    curves_blob(
        rgb=[(0, 0), (100, 150), (255, 255)],
        red=[(0, 0), (128, 64), (255, 255)],
        green=[(0, 40), (255, 215)],
        blue=[(0, 255), (255, 0)],
    ),
)
curves_case("essential_curves_alpha", curves_blob(alpha=[(0, 0), (221, 143), (255, 255)]), src=ALPHA, bg=None)
curves_case("essential_curves_alpha_rgb", curves_blob(rgb=[(0, 0), (64, 128), (255, 255)]), src=ALPHA, bg=None)


def patch_curves(path: Path) -> None:
    """Values live in LIST:aRbs (the aRbp of each parT is the default); comps are stored newest first."""
    raw = bytearray(path.read_bytes())
    blobs = CURVES[::-1]
    efdg = raw.find(b"EfdG")
    efdg_end = efdg + struct.unpack(">I", raw[efdg - 4 : efdg])[0]
    at, k = 0, 0
    while (at := raw.find(b"aRbp", at)) >= 0:
        size = struct.unpack(">I", raw[at + 4 : at + 8])[0]
        in_definition = efdg <= at < efdg_end
        if raw[at - 4 : at] == b"aRbs" and size == 1644 and not in_definition and k < len(blobs):
            raw[at + 8 : at + 8 + size] = blobs[k]
            k += 1
        at += 8
    if k != len(CURVES):
        raise SystemExit(f"patched {k} Curves blobs, expected {len(CURVES)}")
    path.write_bytes(bytes(raw))


suite.save()
patch_curves(REFS / suite.project_file)
manifest = REFS / suite.manifest_file
data = json.loads(manifest.read_text(encoding="utf-8"))
data["known"] = KNOWN
manifest.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
