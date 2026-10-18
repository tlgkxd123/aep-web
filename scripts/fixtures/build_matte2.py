# Builds refs/fixtures/matte2.aep: track mattes of AE 23+ files, which name the matte layer
# explicitly so it can sit anywhere in the stack (below the layer, with other layers between,
# shared by several layers, or left visible).
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_matte2.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BG, ORANGE, TEAL, Suite, TrackMatteType, add_mask, rect, tr  # noqa: E402

suite = Suite("matte2")
case = suite.case


def matte_solid(comp, color=(0.6, 0.6, 0.6)):
    layer = comp.add_solid(list(color), "matte", 70, 50)
    tr(layer, "ADBE Position").value = [95.0, 55.0, 0.0]
    tr(layer, "ADBE Rotate Z").value = 20.0
    return layer


@case("matte2_below")
def _(comp):
    comp.add_solid(BG, "bg")
    matte = matte_solid(comp)
    content = comp.add_solid(ORANGE, "content", 120, 90)
    content.set_track_matte(matte, TrackMatteType.ALPHA)


@case("matte2_gap")
def _(comp):
    matte = matte_solid(comp)
    comp.add_solid(BG, "bg")
    mid = comp.add_solid(TEAL, "mid", 60, 60)
    tr(mid, "ADBE Position").value = [40.0, 40.0, 0.0]
    content = comp.add_solid(ORANGE, "content", 120, 90)
    content.set_track_matte(matte, TrackMatteType.LUMA_INVERTED)


@case("matte2_shared")
def _(comp):
    matte = matte_solid(comp, (0.8, 0.8, 0.8))
    comp.add_solid(BG, "bg")
    first = comp.add_solid(ORANGE, "first", 120, 90)
    first.set_track_matte(matte, TrackMatteType.ALPHA)
    second = comp.add_solid(TEAL, "second", 120, 90)
    tr(second, "ADBE Position").value = [60.0, 70.0, 0.0]
    second.set_track_matte(matte, TrackMatteType.ALPHA_INVERTED)


@case("matte2_visible")
def _(comp):
    matte = matte_solid(comp)
    comp.add_solid(BG, "bg")
    content = comp.add_solid(ORANGE, "content", 120, 90)
    content.set_track_matte(matte, TrackMatteType.ALPHA)
    matte.enabled = True



@case("matte2_chain")
def _(comp):
    # The matte has a matte of its own: AE applies it to the matte first.
    outer = comp.add_solid([1.0, 1.0, 1.0], "outer", 60, 120)
    tr(outer, "ADBE Position").value = [60.0, 60.0, 0.0]
    matte = matte_solid(comp)
    comp.add_solid(BG, "bg")
    content = comp.add_solid(ORANGE, "content", 120, 90)
    content.set_track_matte(matte, TrackMatteType.ALPHA)
    matte.set_track_matte(outer, TrackMatteType.ALPHA)


@case("matte2_chain_legacy")
def _(comp):
    # Positional mattes (id 0) stacked: the layer above, which itself uses the layer above it.
    comp.add_solid(BG, "bg")
    content = comp.add_solid(ORANGE, "content", 120, 90)
    matte = matte_solid(comp)
    outer = comp.add_solid([1.0, 1.0, 1.0], "outer", 60, 120)
    tr(outer, "ADBE Position").value = [60.0, 60.0, 0.0]
    content.track_matte_type = TrackMatteType.ALPHA
    matte.track_matte_type = TrackMatteType.LUMA
    matte.enabled = False
    outer.enabled = False


@case("matte2_dangling")
def _(comp):
    # The matte layer id names no layer of the comp.
    comp.add_solid(BG, "bg")
    content = comp.add_solid(ORANGE, "content", 120, 90)
    content.track_matte_type = TrackMatteType.ALPHA
    content._ldta.matte_layer_id = 9999


@case("matte2_top")
def _(comp):
    # A positional matte on the top layer: there is no layer above.
    comp.add_solid(BG, "bg")
    content = comp.add_solid(ORANGE, "content", 120, 90)
    content.track_matte_type = TrackMatteType.ALPHA


@case("matte2_inactive", frames=(0, 12))
def _(comp):
    # The matte ends halfway: outside its span the matte is empty.
    matte = matte_solid(comp)
    matte.out_point = 0.25
    comp.add_solid(BG, "bg")
    first = comp.add_solid(ORANGE, "first", 120, 90)
    first.set_track_matte(matte, TrackMatteType.ALPHA)
    second = comp.add_solid(TEAL, "second", 60, 60)
    tr(second, "ADBE Position").value = [120.0, 80.0, 0.0]
    second.set_track_matte(matte, TrackMatteType.ALPHA_INVERTED)


@case("matte2_parented", frames=(0, 12))
def _(comp):
    # The matte follows a parent, fades and is masked.
    holder = comp.add_null()
    pos = tr(holder, "ADBE Position")
    pos.set_value_at_time(0.0, [0.0, 0.0, 0.0])
    pos.set_value_at_time(1.0, [40.0, 30.0, 0.0])
    matte = matte_solid(comp)
    matte.parent = holder
    opacity = tr(matte, "ADBE Opacity")
    opacity.set_value_at_time(0.0, 100.0)
    opacity.set_value_at_time(1.0, 20.0)
    add_mask(matte, rect(10, 5, 60, 45))
    comp.add_solid(BG, "bg")
    content = comp.add_solid(ORANGE, "content", 120, 90)
    content.set_track_matte(matte, TrackMatteType.LUMA)


suite.save()
