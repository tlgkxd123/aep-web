# Reads the projects written by scripts/edit-roundtrip.ts with py-aep
# (MIT, https://github.com/forticheprod/py-aep) and checks every recorded
# expectation, so the edited files are verified by an independent decoder.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/check_edits.py [DIR] [--require]
import json
import math
import os
import sys
import tempfile
import traceback
from collections import Counter
from pathlib import Path

PY_AEP = Path(os.environ.get("PY_AEP", "C:/Users/schxm/projects/_ref/py-aep"))
sys.path.insert(0, str(PY_AEP / "src"))
import py_aep  # noqa: E402
from py_aep.models.properties.property import Property  # noqa: E402

args = [a for a in sys.argv[1:] if not a.startswith("--")]
DIR = Path(args[0]) if args else Path(tempfile.gettempdir()) / "aep-web-edit-roundtrip"


def close(a, b, eps=1e-4):
    if isinstance(a, bool) or isinstance(b, bool):
        return bool(a) == bool(b)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if math.isnan(a) and math.isnan(b):
            return True
        return abs(a - b) <= eps * max(1.0, abs(a), abs(b))
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(close(x, y, eps) for x, y in zip(a, b))
    if a is None or b is None:
        return a is None and b is None
    return a == b


def plain(value):
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value)
    return value


def leaves(node, path=()):
    seen = Counter()
    for child in node:
        seen[child.match_name] += 1
        n = seen[child.match_name]
        here = (*path, f"{child.match_name}#{n}" if n > 1 else child.match_name)
        if isinstance(child, Property):
            yield child, here
        else:
            yield from leaves(child, here)


def find(layer, path):
    wanted = tuple(path)
    for prop, here in leaves(layer):
        if here == wanted:
            return prop
    raise KeyError("/".join(path))


SWITCHES = {
    "solo": "solo",
    "shy": "shy",
    "locked": "locked",
    "motionBlur": "motion_blur",
    "enabled": "enabled",
    "adjustmentLayer": "adjustment_layer",
    "threeDLayer": "three_d_layer",
    "collapseTransformation": "collapse_transformation",
}


def read(comp, layer, e):
    field = e["field"]
    if field == "settings":
        return [comp.width, comp.height, comp.frame_rate, comp.duration, list(comp.bg_color)]
    if field in SWITCHES:
        return getattr(layer, SWITCHES[field])
    if field == "name":
        return layer.name
    if field == "blendingMode":
        return int(layer.blending_mode)
    if field == "trackMatteType":
        return int(layer.track_matte_type)
    if field == "startTime":
        return layer.start_time
    if field == "outPoint":
        return layer.out_point
    if field == "inPoint":
        return layer.in_point
    if field == "parentId":
        return layer.parent.id if layer.parent is not None else 0
    if field == "index":
        return comp.layers.index(layer) + 1
    prop = find(layer, e["path"])
    if field == "value":
        return prop.value
    if field == "expression":
        return prop.expression
    if field == "expressionEnabled":
        return prop.expression_enabled
    keys = prop.keyframes
    if field == "keyCount":
        return len(keys)
    if field == "key0":
        return keys[0].value
    if field == "lastKeyTime":
        return keys[-1].time
    if field == "key0Interpolation":
        return [int(keys[0].in_interpolation_type), int(keys[0].out_interpolation_type)]
    if field == "keyframes":
        return [[k.time, k.value] for k in sorted(keys, key=lambda k: k.time)]
    raise KeyError(field)


expectations = json.loads((DIR / "expectations.json").read_text(encoding="utf-8"))
by_file: dict[str, list[dict]] = {}
for e in expectations:
    by_file.setdefault(Path(e["file"]).name, []).append(e)
files = sorted(p for p in DIR.glob("*.aep"))

parse_failures: list[str] = []
mismatches: list[str] = []
fields = Counter()
mismatched_fields = Counter()
checked = 0
for path in files:
    try:
        project = py_aep.parse(path).project
    except Exception:  # noqa: BLE001 - report every file that py-aep cannot read
        parse_failures.append(f"{path.name}: {traceback.format_exc(limit=2).splitlines()[-1]}")
        continue
    for e in by_file.get(path.name, []):
        fields[e["field"]] += 1
        checked += 1
        try:
            comp = project.items[e["compId"]]
            layer = None
            if e["layerId"]:
                layer = next(l for l in comp.layers if l.id == e["layerId"])
            actual = read(comp, layer, e)
            expected = e["value"]
            if e["path"] and e["path"][-1].startswith("ADBE Text VF Axis"):
                # aep-web reports [value, axis tag]; py-aep reports the value alone.
                if e["field"] == "keyframes":
                    expected = [[t, v[0]] for t, v in expected]
                elif e["field"] in ("value", "key0"):
                    expected = expected[0]
            ok = close(plain(actual), expected)
            if ok and layer is not None and e["field"] != "index" and comp.layers.index(layer) + 1 != e["layer"]:
                actual, ok = f"layer index {comp.layers.index(layer) + 1}", False
        except Exception as error:  # noqa: BLE001
            actual, ok = f"error {type(error).__name__}: {error}", False
        if not ok:
            mismatched_fields[e["field"]] += 1
            mismatches.append(
                f"{path.name} {e['comp']} layer {e['layer']} {'/'.join(e['path'])} {e['field']}: "
                f"py-aep {json.dumps(plain(actual), default=str)[:160]}, expected {json.dumps(e['value'])[:160]}"
            )

print(f"files: {len(files)}, py-aep parse failures: {len(parse_failures)}, checked fields: {checked}, mismatches: {len(mismatches)}")
print("fields:", dict(fields))
if mismatched_fields:
    print("mismatched fields:", dict(mismatched_fields))
for line in parse_failures[:20]:
    print("  PARSE", line)
for line in mismatches[:40]:
    print("  FAIL", line)
if "--require" in sys.argv:
    if len(files) >= 400 and checked >= 5000 and not parse_failures and not mismatches:
        print("PY-AEP-EDITS-PASSED")
    else:
        print("py-aep edit check requirement not met")
        sys.exit(1)
