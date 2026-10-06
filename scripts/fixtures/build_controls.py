# Builds refs/fixtures/controls.aep: expression control effects must leave pixels unchanged.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_controls.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BG, ORANGE, TEAL, Suite, tr  # noqa: E402

suite = Suite("controls")

CONTROLS = [
    "ADBE Slider Control",
    "ADBE Point Control",
    "ADBE Point3D Control",
    "ADBE Angle Control",
    "ADBE Checkbox Control",
    "ADBE Color Control",
    "ADBE Dropdown Control",
    "ADBE Layer Control",
]


@suite.case("controls_all")
def _(comp):
    comp.add_solid(BG, "bg")
    box = comp.add_solid(ORANGE, "box", 80, 60)
    tr(box, "ADBE Rotate Z").value = 20.0
    for match_name in CONTROLS:
        box["ADBE Effect Parade"].add_property(match_name)
    small = comp.add_solid(TEAL, "small", 30, 30)
    tr(small, "ADBE Position").value = [40.0, 30.0, 0.0]
    small["ADBE Effect Parade"].add_property("ADBE Slider Control")


suite.save()
