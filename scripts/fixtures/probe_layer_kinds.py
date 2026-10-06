# Probe: how py-aep's (MIT, https://github.com/forticheprod/py-aep) new layer
# blocks differ between layer kinds (solid, null, comp, footage, shape).
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/probe_layer_kinds.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probe_layers import build, diff  # noqa: E402

blocks = {m: build(m) for m in ("solid", "null", "comp", "item", "shape")}
for m in ("solid", "null", "comp", "item"):
    print(m, "ldta", blocks[m]["L0/ldta#1"].hex())
print("shape ldta", blocks["shape"]["L0/ldta#1"].hex())
only_layer = lambda b: {k: v for k, v in b.items() if k.startswith("L")}  # noqa: E731
for m in ("null", "comp", "item"):
    diff(only_layer(blocks["solid"]), only_layer(blocks[m]), f"solid vs {m}")
diff(blocks["solid"], blocks["null"], "solid vs null (items)")
