# Builds the base project of the roundtrip suite, refs/fixtures/roundtrip.base.aep: for
# every effect of the Effects & Presets library (src/edit/data/effect-library.json) a
# roundtrip_<effect> comp, and a roundtrip_<effect>_set comp when the effect has a
# parameter the editor can set, each holding the card: a precomp tiled with coloured
# solids, with holes, under a filled and stroked star, on transparency. The effects
# themselves are applied by the browser editor in scripts/fixtures/apply_roundtrip.ts,
# which writes refs/fixtures/roundtrip.aep and its manifest.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_roundtrip.py
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import ORANGE, REFS, TEAL, Suite, add, fill, shape_group, stroke, tr  # noqa: E402

LIBRARY = Path(__file__).resolve().parents[2] / "src" / "edit" / "data" / "effect-library.json"
BASE_JSON = "roundtrip.base.json"
CARD = "roundtrip_card"
#: Effects whose only parameters are layers, which an applied effect starts without.
NOTHING_TO_SET = {"ADBE Layer Control"}
#: Effects that change over time are also checked half a second in.
ANIMATED = {"tc Particular", "tc Sound Keys"}

suite = Suite("roundtrip", project_file="roundtrip.base.aep", manifest_file=BASE_JSON)
case = suite.case

CELL_COLORS = [
    [0.95, 0.85, 0.2], [0.1, 0.2, 0.6], [0.85, 0.2, 0.25], [0.2, 0.75, 0.35],
    [0.6, 0.3, 0.8], [1.0, 1.0, 1.0], [0.05, 0.05, 0.05], [0.95, 0.55, 0.1],
    [0.3, 0.85, 0.9], [0.5, 0.5, 0.5], [0.9, 0.4, 0.7], [0.15, 0.45, 0.3],
]


def card(w=120, h=90, cell=15):
    """Coloured solids with a hole every fifth cell, under a star that reaches past them, on transparency."""
    inner = suite.folder.add_comp(CARD, w, h, 1.0, 1.0, 24.0)
    cols = w // cell
    k = 0
    for j in range(h // cell):
        for i in range(cols):
            k += 1
            if k % 5 == 0 or (i >= cols - 2 and j >= 3):
                continue
            s = inner.add_solid(CELL_COLORS[k % len(CELL_COLORS)], f"c{i}_{j}", cell, cell)
            tr(s, "ADBE Position").value = [i * cell + cell / 2, j * cell + cell / 2, 0.0]
    star = inner.add_shape()
    g = shape_group(star)
    add(g, "ADBE Vector Shape - Star", **{"ADBE Vector Star Points": 5.0, "ADBE Vector Star Outer Radius": 28.0, "ADBE Vector Star Inner Radius": 13.0})
    stroke(g, TEAL, 3.0)
    fill(g, ORANGE)
    tr(star, "ADBE Position").value = [w - 30.0, h - 26.0, 0.0]
    return inner


SOURCE = card()


def slug(match_name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", re.sub(r"^ADBE ", "", match_name).lower()).strip("_")


effects = json.loads(LIBRARY.read_text(encoding="utf-8"))["effects"]
comps: dict[str, list[str]] = {}
#: Look-alikes of plug-ins After Effects lacks here (Sapphire): it cannot render them.
for match_name in [m for m, e in effects.items() if not e.get("lookalike")]:
    names = [f"roundtrip_{slug(match_name)}"]
    if match_name not in NOTHING_TO_SET:
        names.append(f"{names[0]}_set")
    comps[match_name] = names
    for name in names:

        @case(name, frames=(0, 12) if match_name in ANIMATED else (0,))
        def build(comp):
            comp.add(SOURCE)

suite.save()
base = json.loads((REFS / BASE_JSON).read_text(encoding="utf-8"))
base["effects"] = comps
(REFS / BASE_JSON).write_text(json.dumps(base, indent=1) + "\n", encoding="utf-8")
print(f"{len(comps)} effects")
