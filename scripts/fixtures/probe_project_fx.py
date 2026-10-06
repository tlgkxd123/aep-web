# Lists effect instances of a project (py-aep view) and the layers carrying them.
#
#   uv run --no-project --with attrs --with pyyaml --with fonttools python scripts/fixtures/probe_project_fx.py <project.aep> <match name>
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import aepfix  # noqa: E402,F401
import py_aep  # noqa: E402

path, match = sys.argv[1], sys.argv[2]
app = py_aep.parse(path)
items = app.project.items
print(type(items), len(items))
for item in (items.values() if hasattr(items, "values") else items):
    if not hasattr(item, "layers"):
        continue
    for layer in item.layers:
        try:
            parade = layer["ADBE Effect Parade"]
        except Exception as e:  # noqa: BLE001
            print("no parade", item.name, layer.name, e)
            continue
        for fx in parade.properties:
            if fx.match_name != match:
                continue
            src = getattr(layer, "source", None)
            print(f"{item.name} > {layer.name} [{type(layer).__name__}, src={type(src).__name__ if src else None} "
                  f"{getattr(src, 'width', '')}x{getattr(src, 'height', '')}] enabled={fx.enabled}")
