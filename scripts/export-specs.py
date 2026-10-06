# Exports py-aep's property synthesis tables (MIT, https://github.com/forticheprod/py-aep)
# to src/aep/data/property-specs.json: canonical child order, display names and the
# default values After Effects reports for properties it does not write to the file.
#
#   uv run --with attrs --with pyyaml --with fonttools python scripts/export-specs.py ../_ref/py-aep/src
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "../_ref/py-aep/src")

from py_aep.synthesis import property as specs  # noqa: E402


def number(value):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def spec_json(spec):
    if isinstance(spec, specs.GroupSpec):
        out = {"matchName": spec.match_name, "name": spec.auto_name, "group": True}
        if not spec.enable_flags & 1:
            out["enabled"] = False
        return out
    value = spec.value
    if isinstance(value, (list, tuple)):
        value = [number(v) for v in value]
    elif isinstance(value, (int, float)):
        value = number(value)
    elif value is not None:
        value = None
    out = {
        "matchName": spec.match_name,
        "name": spec.auto_name,
        "value": value,
        "pvt": int(spec.pvt),
        "dimensions": spec.dimensions,
    }
    for key, attr in (("isSpatial", "is_spatial"), ("color", "color"), ("integer", "integer")):
        if getattr(spec, attr):
            out[key] = True
    if spec.min_value is not None and number(spec.min_value) is not None:
        out["min"] = number(spec.min_value)
    if spec.max_value is not None and number(spec.max_value) is not None:
        out["max"] = number(spec.max_value)
    if spec.can_vary_over_time is not None:
        out["canVaryOverTime"] = bool(spec.can_vary_over_time)
    return out


group_children = {k: [spec_json(s) for s in v] for k, v in specs._GROUP_CHILD_SPECS.items()}
for style, children in specs._LAYER_STYLE_CHILD_SPECS.items():
    group_children.setdefault(style, [spec_json(s) for s in children])

tables = {
    "groupChildren": group_children,
    "topLevel": [spec_json(s) for s in specs._TOP_LEVEL_SPECS],
    "parametricMeshTopLevel": [spec_json(s) for s in specs._PARAMETRIC_MESH_TOP_LEVEL_SPECS],
    "skip": {
        "AVLayer": sorted(specs._SKIP_FOR_REGULAR_AV),
        "TextLayer": sorted(specs._SKIP_FOR_TEXT),
        "ShapeLayer": sorted(specs._SKIP_FOR_SHAPE),
        "CameraLayer": sorted(specs._SKIP_FOR_CAMERA),
        "LightLayer": sorted(specs._SKIP_FOR_LIGHT),
    },
    "transform": [spec_json(s) for s in specs._TRANSFORM_SPECS],
    "transformFixedDefaults": specs._TRANSFORM_FIXED_DEFAULTS,
}

out = Path("src/aep/data/property-specs.json")
out.write_text(json.dumps(tables, indent=1) + "\n", encoding="utf-8")
count = sum(len(v) for v in tables["groupChildren"].values())
print(f"wrote {len(tables['groupChildren'])} groups, {count} child specs, {len(tables['topLevel'])} top-level specs")
