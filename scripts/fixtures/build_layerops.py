# Builds the base project of the layerops suite, refs/fixtures/layerops.base.aep:
# empty layerops_* comps, a source precomp and a holder comp whose solids give
# the layer operations footage of other sizes and aspect ratios. The edits
# themselves are made by the browser editor in scripts/build-layerops.ts, which
# writes refs/fixtures/layerops.aep and its manifest.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/build_layerops.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aepfix import BG, ORANGE, TEAL, Suite, tr  # noqa: E402

suite = Suite("layerops", project_file="layerops.base.aep", manifest_file="layerops.base.json")
case = suite.case

# The card: an 80x60 precomp with an off-centre mark, so flips and rotations show.
card = suite.folder.add_comp("layerops_card", 80, 60, 1.0, 1.0, 24.0)
card.add_solid(TEAL, "layerops card bg", 80, 60, 1.0)
mark = card.add_solid([1.0, 0.9, 0.2], "layerops card mark", 20, 14, 1.0)
tr(mark, "ADBE Position").value = [18.0, 14.0, 0.0]

# Solids of other sizes and aspect ratios, used as footage by the edits. They are
# larger than the comp: After Effects fringes the edges of upscaled solids with a
# lighter colour the browser renderer does not reproduce yet.
holder = suite.folder.add_comp("layerops_holder", 160, 120, 1.0, 1.0, 24.0)
holder.add_solid(ORANGE, "layerops wide", 200, 50, 1.0)
holder.add_solid([0.85, 0.3, 0.6], "layerops tall", 60, 180, 1.0)
holder.add_solid([0.3, 0.8, 0.3], "layerops small", 320, 160, 1.0)

for name, frames in [
    ("layerops_new", (0,)),
    ("layerops_fit", (0,)),
    ("layerops_fit_width", (0,)),
    ("layerops_fit_height", (0,)),
    ("layerops_move", (0, 12)),
    ("layerops_parent", (0,)),
    ("layerops_anchor", (0,)),
    ("layerops_stack", (0,)),
]:

    @case(name, frames=frames)
    def build(comp):
        comp.bg_color = BG

suite.save()
